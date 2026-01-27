import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, useFetcher } from "react-router";
import React, { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  // Default to next 7 days if not specified
  const laborStart = startDate ? new Date(startDate) : new Date();
  const laborEnd = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Get all COMPLETED SKUs with their forecasts and current inventory
  const completedSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: "COMPLETED",
    },
    include: {
      inventoryItems: {
        where: {
          quantity: { gt: 0 },
          state: "COMPLETED",
        },
      },
      bomComponents: {
        include: {
          componentSku: {
            include: {
              inventoryItems: {
                where: { quantity: { gt: 0 } },
              },
              bomComponents: {
                include: {
                  componentSku: {
                    include: {
                      inventoryItems: {
                        where: { quantity: { gt: 0 } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { sku: "asc" },
  });

  // Get all forecasts
  const forecasts = await prisma.forecast.findMany();
  const forecastMap = new Map(forecasts.map(f => [f.skuId, f]));

  // Get all saved forecast templates
  const templates = await prisma.forecastTemplate.findMany({
    include: {
      createdBy: {
        select: { firstName: true, lastName: true },
      },
      items: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Get all process configs for labor calculation
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
  });
  const processMap = new Map(processConfigs.map(p => [p.processName, p]));

  // Calculate forecast data for each SKU
  const forecastData = completedSkus.map(sku => {
    const forecast = forecastMap.get(sku.id);
    const currentInGallatin = forecast?.currentInGallatin || 0;
    const forecastedQty = forecast?.quantity || 0;

    // Calculate current completed inventory
    const currentCompleted = sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    // Need to Build = Demand - (Current Completed + Current in Gallatin)
    const needToBuild = Math.max(0, forecastedQty - (currentCompleted + currentInGallatin));

    // BOM explosion - track assembly SKUs and raw materials needed
    // ALWAYS process BOM structure so we can show it even when needToBuild is 0
    const assemblySkusNeeded: Record<string, { skuId: string; sku: string; name: string; type: string; qtyPerUnit: number; totalNeeded: number; available: number }> = {};
    const rawMaterialsNeeded: Record<string, { skuId: string; sku: string; name: string; needed: number; available: number }> = {};
    const processTotals: Record<string, { units: number; seconds: number }> = {};

    // Process each component in the BOM
    for (const bomComp of sku.bomComponents) {
      const qtyNeeded = bomComp.quantity * needToBuild;
      const available = bomComp.componentSku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

      // Track process time for this component (only if needToBuild > 0)
      if (needToBuild > 0) {
        const compProcess = bomComp.componentSku.material;
        if (compProcess && processMap.has(compProcess)) {
          if (!processTotals[compProcess]) {
            processTotals[compProcess] = { units: 0, seconds: 0 };
          }
          processTotals[compProcess].units += qtyNeeded;
          processTotals[compProcess].seconds += qtyNeeded * (processMap.get(compProcess)?.secondsPerUnit || 0);
        }
      }

      // If component is RAW, track it
      if (bomComp.componentSku.type === "RAW") {
        if (!rawMaterialsNeeded[bomComp.componentSku.id]) {
          rawMaterialsNeeded[bomComp.componentSku.id] = {
            skuId: bomComp.componentSku.id,
            sku: bomComp.componentSku.sku,
            name: bomComp.componentSku.name,
            needed: 0,
            available,
          };
        }
        rawMaterialsNeeded[bomComp.componentSku.id].needed += qtyNeeded;
      } else if (bomComp.componentSku.type === "ASSEMBLY") {
        // Track assembly SKU needed
        if (!assemblySkusNeeded[bomComp.componentSku.id]) {
          assemblySkusNeeded[bomComp.componentSku.id] = {
            skuId: bomComp.componentSku.id,
            sku: bomComp.componentSku.sku,
            name: bomComp.componentSku.name,
            type: bomComp.componentSku.type,
            qtyPerUnit: bomComp.quantity,
            totalNeeded: 0,
            available,
          };
        }
        assemblySkusNeeded[bomComp.componentSku.id].totalNeeded += qtyNeeded;

        // Calculate how many assemblies we still need to build after accounting for available inventory
        const assemblyShortfall = Math.max(0, qtyNeeded - available);

        // Explode assembly BOM for raw materials (only for what we need to build)
        for (const subComp of bomComp.componentSku.bomComponents) {
          // Only calculate raw materials for assemblies we still need to build
          const subQtyNeeded = subComp.quantity * assemblyShortfall;
          const subAvailable = subComp.componentSku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

          // Track process time (only for assemblies we need to build)
          if (assemblyShortfall > 0 && needToBuild > 0) {
            const subProcess = subComp.componentSku.material;
            if (subProcess && processMap.has(subProcess)) {
              if (!processTotals[subProcess]) {
                processTotals[subProcess] = { units: 0, seconds: 0 };
              }
              processTotals[subProcess].units += subQtyNeeded;
              processTotals[subProcess].seconds += subQtyNeeded * (processMap.get(subProcess)?.secondsPerUnit || 0);
            }
          }

          if (subComp.componentSku.type === "RAW") {
            if (!rawMaterialsNeeded[subComp.componentSku.id]) {
              rawMaterialsNeeded[subComp.componentSku.id] = {
                skuId: subComp.componentSku.id,
                sku: subComp.componentSku.sku,
                name: subComp.componentSku.name,
                needed: 0,
                available: subAvailable,
              };
            }
            rawMaterialsNeeded[subComp.componentSku.id].needed += subQtyNeeded;
          }
        }

        // Also track process time for assembling the available assemblies into completed products
        // (if we have them in inventory, we still need to do the final assembly process)
        if (needToBuild > 0) {
          const compProcess = bomComp.componentSku.material;
          if (compProcess && processMap.has(compProcess)) {
            if (!processTotals[compProcess]) {
              processTotals[compProcess] = { units: 0, seconds: 0 };
            }
            // Use the full qtyNeeded (not assemblyShortfall) because we need to process all assemblies
            processTotals[compProcess].units += qtyNeeded;
            processTotals[compProcess].seconds += qtyNeeded * (processMap.get(compProcess)?.secondsPerUnit || 0);
          }
        }
      }
    }

    // Track final assembly process (only if needToBuild > 0)
    if (needToBuild > 0) {
      const finalProcess = sku.material;
      if (finalProcess && processMap.has(finalProcess)) {
        if (!processTotals[finalProcess]) {
          processTotals[finalProcess] = { units: 0, seconds: 0 };
        }
        processTotals[finalProcess].units += needToBuild;
        processTotals[finalProcess].seconds += needToBuild * (processMap.get(finalProcess)?.secondsPerUnit || 0);
      }
    }

    // Check if all raw materials are sufficient
    const rawMaterialsList = Object.values(rawMaterialsNeeded);
    const hasSufficientRawMaterials = rawMaterialsList.length > 0 && rawMaterialsList.every(raw => raw.available >= raw.needed);

    // Calculate total build time in hours
    const totalBuildSeconds = Object.values(processTotals).reduce((sum, p) => sum + p.seconds, 0);
    const buildTimeHours = totalBuildSeconds / 3600;

    return {
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      currentCompleted,
      currentInGallatin,
      forecastedQty,
      needToBuild,
      assemblySkusNeeded: Object.values(assemblySkusNeeded),
      rawMaterialsNeeded: Object.values(rawMaterialsNeeded),
      processTotals,
      hasForecast: !!forecast,
      hasSufficientRawMaterials,
      buildTimeHours,
    };
  });

  // Calculate total labor requirements
  const totalProcessRequirements: Record<string, { units: number; seconds: number; hours: number }> = {};
  for (const item of forecastData) {
    for (const [process, totals] of Object.entries(item.processTotals)) {
      if (!totalProcessRequirements[process]) {
        totalProcessRequirements[process] = { units: 0, seconds: 0, hours: 0 };
      }
      totalProcessRequirements[process].units += totals.units;
      totalProcessRequirements[process].seconds += totals.seconds;
      totalProcessRequirements[process].hours = totalProcessRequirements[process].seconds / 3600;
    }
  }

  // Calculate available labor hours for the date range
  const daysDiff = Math.ceil((laborEnd.getTime() - laborStart.getTime()) / (1000 * 60 * 60 * 24));
  const workers = await prisma.user.findMany({
    where: { role: "WORKER", isActive: true },
    include: {
      schedules: {
        where: { isActive: true, scheduleType: "RECURRING" },
      },
    },
  });

  const availableLaborHours = workers.reduce((total, worker) => {
    const weeklyHours = worker.schedules.reduce((sum, schedule) => {
      const start = parseTime(schedule.startTime);
      const end = parseTime(schedule.endTime);
      return sum + (end - start);
    }, 0);
    return total + (weeklyHours / 7 * daysDiff);
  }, 0);

  // Aggregate all raw material shortages
  const allRawMaterialShortages: Record<string, typeof forecastData[0]["rawMaterialsNeeded"][0] & { shortfall: number; forSkus: string[] }> = {};
  for (const item of forecastData) {
    for (const raw of item.rawMaterialsNeeded) {
      const shortfall = Math.max(0, raw.needed - raw.available);
      if (shortfall > 0) {
        if (!allRawMaterialShortages[raw.skuId]) {
          allRawMaterialShortages[raw.skuId] = { ...raw, shortfall: 0, forSkus: [] };
        }
        allRawMaterialShortages[raw.skuId].shortfall += shortfall;
        allRawMaterialShortages[raw.skuId].forSkus.push(item.sku);
      }
    }
  }

  const totalLaborHoursNeeded = Object.values(totalProcessRequirements).reduce((sum, p) => sum + p.hours, 0);

  return {
    user,
    forecastData,
    totalProcessRequirements,
    allRawMaterialShortages: Object.values(allRawMaterialShortages),
    laborStart: laborStart.toISOString().split('T')[0],
    laborEnd: laborEnd.toISOString().split('T')[0],
    availableLaborHours,
    totalLaborHoursNeeded,
    daysDiff,
    templates,
  };
};

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours + minutes / 60;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Only admins can update forecasts" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update-forecast") {
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    const currentInGallatin = parseInt(formData.get("currentInGallatin") as string, 10);

    if (isNaN(quantity) || quantity < 0) {
      return { error: "Invalid forecasted quantity" };
    }

    if (isNaN(currentInGallatin) || currentInGallatin < 0) {
      return { error: "Invalid current inventory quantity" };
    }

    // Upsert forecast
    await prisma.forecast.upsert({
      where: { skuId },
      create: { skuId, quantity, currentInGallatin },
      update: { quantity, currentInGallatin },
    });

    await createAuditLog(user.id, "UPDATE_FORECAST", "Forecast", skuId, { quantity, currentInGallatin });

    return { success: true, message: "Forecast updated" };
  }

  if (intent === "save-template") {
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;

    if (!title || title.trim().length === 0) {
      return { error: "Template title is required" };
    }

    // Get all current forecasts
    const forecasts = await prisma.forecast.findMany();

    if (forecasts.length === 0) {
      return { error: "No forecasts to save. Please add forecast quantities first." };
    }

    // Create template with items
    const template = await prisma.forecastTemplate.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        createdById: user.id,
        items: {
          create: forecasts.map(f => ({
            skuId: f.skuId,
            quantity: f.quantity,
            currentInGallatin: f.currentInGallatin,
          })),
        },
      },
    });

    await createAuditLog(user.id, "CREATE_FORECAST_TEMPLATE", "ForecastTemplate", template.id, {
      title,
      itemCount: forecasts.length,
    });

    return { success: true, message: `Template "${title}" saved successfully with ${forecasts.length} items` };
  }

  if (intent === "load-template") {
    const templateId = formData.get("templateId") as string;

    const template = await prisma.forecastTemplate.findUnique({
      where: { id: templateId },
      include: { items: true },
    });

    if (!template) {
      return { error: "Template not found" };
    }

    // Update all forecasts from template
    for (const item of template.items) {
      await prisma.forecast.upsert({
        where: { skuId: item.skuId },
        create: {
          skuId: item.skuId,
          quantity: item.quantity,
          currentInGallatin: item.currentInGallatin,
        },
        update: {
          quantity: item.quantity,
          currentInGallatin: item.currentInGallatin,
        },
      });
    }

    await createAuditLog(user.id, "LOAD_FORECAST_TEMPLATE", "ForecastTemplate", templateId, {
      title: template.title,
      itemCount: template.items.length,
    });

    return { success: true, message: `Template "${template.title}" loaded successfully` };
  }

  if (intent === "delete-template") {
    const templateId = formData.get("templateId") as string;

    const template = await prisma.forecastTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return { error: "Template not found" };
    }

    await prisma.forecastTemplate.delete({
      where: { id: templateId },
    });

    await createAuditLog(user.id, "DELETE_FORECAST_TEMPLATE", "ForecastTemplate", templateId, {
      title: template.title,
    });

    return { success: true, message: `Template "${template.title}" deleted successfully` };
  }

  return { error: "Invalid action" };
};

function ForecastRow({
  item,
  expandedSku,
  setExpandedSku,
}: {
  item: {
    skuId: string;
    sku: string;
    name: string;
    currentCompleted: number;
    currentInGallatin: number;
    forecastedQty: number;
    needToBuild: number;
    assemblySkusNeeded: Array<{
      skuId: string;
      sku: string;
      name: string;
      type: string;
      qtyPerUnit: number;
      totalNeeded: number;
      available: number;
    }>;
    rawMaterialsNeeded: Array<{
      skuId: string;
      sku: string;
      name: string;
      needed: number;
      available: number;
    }>;
    processTotals: Record<string, { units: number; seconds: number }>;
    hasForecast: boolean;
    hasSufficientRawMaterials: boolean;
    buildTimeHours: number;
  };
  expandedSku: string | null;
  setExpandedSku: (skuId: string | null) => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting";

  return (
    <React.Fragment>
      <tr>
        <td className="text-center w-12">
          <button
            type="button"
            onClick={() => setExpandedSku(expandedSku === item.skuId ? null : item.skuId)}
            className="btn btn-sm btn-ghost text-lg font-bold"
            disabled={isSubmitting}
          >
            {expandedSku === item.skuId ? "−" : "+"}
          </button>
        </td>
        <td className="font-mono text-sm">{item.sku}</td>
        <td>{item.name}</td>
        <td className="text-right">
          <span className="font-semibold text-gray-900">{item.currentCompleted}</span>
        </td>
        <td className="text-right">
          <fetcher.Form method="post" className="inline">
            <input type="hidden" name="intent" value="update-forecast" />
            <input type="hidden" name="skuId" value={item.skuId} />
            <input
              type="number"
              name="currentInGallatin"
              className="form-input w-24 text-sm text-right"
              min="0"
              defaultValue={item.currentInGallatin}
              placeholder="0"
              required
              onBlur={(e) => {
                const form = e.currentTarget.form;
                if (form) fetcher.submit(form);
              }}
            />
          </fetcher.Form>
        </td>
        <td className="text-right">
          <fetcher.Form method="post" className="inline">
            <input type="hidden" name="intent" value="update-forecast" />
            <input type="hidden" name="skuId" value={item.skuId} />
            <input type="hidden" name="currentInGallatin" value={item.currentInGallatin} />
            <input
              type="number"
              name="quantity"
              className="form-input w-24 text-sm text-right"
              min="0"
              defaultValue={item.forecastedQty}
              placeholder="0"
              required
              onBlur={(e) => {
                const form = e.currentTarget.form;
                if (form) fetcher.submit(form);
              }}
            />
          </fetcher.Form>
        </td>
        <td className="text-right">
          {item.needToBuild > 0 ? (
            <span className="font-bold text-orange-600">{item.needToBuild}</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td>
          {item.needToBuild === 0 ? (
            <span className="badge bg-green-100 text-green-700">✓ Sufficient</span>
          ) : (
            <span className="badge bg-orange-100 text-orange-700">⚠ Build {item.needToBuild}</span>
          )}
        </td>
        <td className="text-center">
          {item.needToBuild > 0 ? (
            item.hasSufficientRawMaterials ? (
              <span className="text-green-600 text-xl">✓</span>
            ) : (
              <span className="text-red-600 text-xl">✗</span>
            )
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="text-right">
          {item.needToBuild > 0 && item.buildTimeHours > 0 ? (
            <span className="font-semibold text-gray-900">{item.buildTimeHours.toFixed(1)}h</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
      </tr>
      {expandedSku === item.skuId && (
        <tr>
          <td colSpan={10} className="bg-gray-50 p-4">
            <div className="space-y-6">
              <h4 className="font-semibold text-lg text-gray-900 mb-4">
                Bill of Materials for {item.name}
              </h4>

              {/* Raw Materials */}
              {item.rawMaterialsNeeded.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 text-gray-900">Raw Materials</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    Raw materials consumed in production
                    {item.needToBuild > 0 && ` (to build ${item.needToBuild} units)`}
                  </p>
                  <table className="data-table-sm">
                    <thead>
                      <tr>
                        <th>Raw Material SKU</th>
                        <th>Name</th>
                        {item.needToBuild > 0 && (
                          <>
                            <th className="text-right">Needed</th>
                            <th className="text-right">Available</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {item.rawMaterialsNeeded.map((raw) => {
                        return (
                          <tr key={raw.skuId}>
                            <td className="font-mono text-sm">{raw.sku}</td>
                            <td>{raw.name}</td>
                            {item.needToBuild > 0 && (
                              <>
                                <td className="text-right font-semibold">{raw.needed}</td>
                                <td className="text-right">{raw.available}</td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Process Time Breakdown - Only show if needToBuild > 0 */}
              {item.needToBuild > 0 && Object.keys(item.processTotals).length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 text-gray-900">Process Time Required</h4>
                  <table className="data-table-sm">
                    <thead>
                      <tr>
                        <th>Process</th>
                        <th className="text-right">Units</th>
                        <th className="text-right">Hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(item.processTotals).map(([process, totals]) => (
                        <tr key={process}>
                          <td>{process}</td>
                          <td className="text-right">{totals.units}</td>
                          <td className="text-right">{(totals.seconds / 3600).toFixed(1)}h</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

export default function Forecasting() {
  const {
    user,
    forecastData,
    totalProcessRequirements,
    allRawMaterialShortages,
    laborStart,
    laborEnd,
    availableLaborHours,
    totalLaborHoursNeeded,
    daysDiff,
    templates,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const laborCapacitySufficient = availableLaborHours >= totalLaborHoursNeeded;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Forecasting & Capacity</h1>
        <p className="page-subtitle">Plan production based on forecasted demand</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Forecast Input Table */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Production Forecast</h2>
          <p className="text-sm text-gray-500">Enter forecasted demand for each completed SKU</p>
        </div>
        <div className="card-body">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-12"></th>
                <th>SKU</th>
                <th>Product Name</th>
                <th className="text-right">Current Completed</th>
                <th className="text-right">Current in Gallatin</th>
                <th className="text-right">Forecasted Demand</th>
                <th className="text-right">Need to Build</th>
                <th>Status</th>
                <th className="text-center">Raw Materials</th>
                <th className="text-right">Build Time</th>
              </tr>
            </thead>
            <tbody>
              {forecastData.map((item) => {
                return <ForecastRow key={item.skuId} item={item} expandedSku={expandedSku} setExpandedSku={setExpandedSku} />;
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Labor Capacity Analysis */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Labor Capacity</h2>
          </div>
          <div className="card-body">
            <Form method="get" className="mb-4 grid grid-cols-2 gap-3">
              <div className="form-group">
                <label className="form-label text-sm">Start Date</label>
                <input
                  type="date"
                  name="startDate"
                  className="form-input text-sm"
                  defaultValue={laborStart}
                />
              </div>
              <div className="form-group">
                <label className="form-label text-sm">End Date</label>
                <input
                  type="date"
                  name="endDate"
                  className="form-input text-sm"
                  defaultValue={laborEnd}
                />
              </div>
              <div className="col-span-2">
                <button type="submit" className="btn btn-sm btn-secondary w-full">
                  Update Date Range
                </button>
              </div>
            </Form>

            <div className="space-y-4">
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <span className="text-sm text-gray-600">Period</span>
                <span className="font-semibold">{daysDiff} days</span>
              </div>
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <span className="text-sm text-gray-600">Hours Needed</span>
                <span className="font-semibold text-orange-600">{totalLaborHoursNeeded.toFixed(1)}h</span>
              </div>
              <div className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <span className="text-sm text-gray-600">Hours Available</span>
                <span className="font-semibold text-blue-600">{availableLaborHours.toFixed(1)}h</span>
              </div>
              <div className={`flex justify-between items-center p-3 rounded ${
                laborCapacitySufficient ? "bg-green-50" : "bg-red-50"
              }`}>
                <span className="text-sm font-semibold">Status</span>
                <span className={`font-bold ${
                  laborCapacitySufficient ? "text-green-700" : "text-red-700"
                }`}>
                  {laborCapacitySufficient ? "✓ Sufficient Capacity" : "⚠ Over Capacity"}
                </span>
              </div>
            </div>

            {Object.keys(totalProcessRequirements).length > 0 && (
              <div className="mt-4">
                <h4 className="font-semibold mb-2 text-sm">By Process</h4>
                <table className="data-table-sm">
                  <thead>
                    <tr>
                      <th>Process</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(totalProcessRequirements).map(([process, totals]) => (
                      <tr key={process}>
                        <td>{process}</td>
                        <td className="text-right">{totals.units}</td>
                        <td className="text-right">{totals.hours.toFixed(1)}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Raw Material Shortages */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Raw Material Shortages</h2>
          </div>
          <div className="card-body">
            {allRawMaterialShortages.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-green-600 text-4xl mb-2">✓</div>
                <p className="text-gray-600">All raw materials sufficient</p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Raw Material SKU</th>
                    <th>Name</th>
                    <th className="text-right">Available</th>
                    <th className="text-right">Shortfall</th>
                  </tr>
                </thead>
                <tbody>
                  {allRawMaterialShortages.map((shortage) => (
                    <tr key={shortage.skuId}>
                      <td className="font-mono text-sm">{shortage.sku}</td>
                      <td className="text-sm">
                        {shortage.name}
                        <div className="text-xs text-gray-500 mt-1">
                          Used in: {shortage.forSkus.join(", ")}
                        </div>
                      </td>
                      <td className="text-right">{shortage.available}</td>
                      <td className="text-right">
                        <span className="font-bold text-red-600">-{shortage.shortfall}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Save Current Forecast as Template */}
      {user.role === "ADMIN" && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Save Forecast as Template</h2>
            <p className="text-sm text-gray-500">Save current forecast values to reuse later</p>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="save-template" />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="form-group mb-0">
                  <label className="form-label">Template Title *</label>
                  <input
                    type="text"
                    name="title"
                    className="form-input"
                    placeholder="e.g., December 2025 Forecast"
                    required
                  />
                </div>
                <div className="form-group mb-0 md:col-span-2">
                  <label className="form-label">Description (Optional)</label>
                  <input
                    type="text"
                    name="description"
                    className="form-input"
                    placeholder="e.g., Holiday season projections"
                  />
                </div>
              </div>
              <div className="mt-4">
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save Template"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Saved Templates */}
      {user.role === "ADMIN" && templates.length > 0 && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Saved Templates</h2>
            <p className="text-sm text-gray-500">Load previously saved forecast templates</p>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              {templates.map((template) => (
                <div key={template.id} className="p-4 border rounded-lg bg-gray-50">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex-1">
                      <h3 className="font-semibold text-lg">{template.title}</h3>
                      {template.description && (
                        <p className="text-sm text-gray-600 mt-1">{template.description}</p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                        <span>
                          Created by: {template.createdBy.firstName} {template.createdBy.lastName}
                        </span>
                        <span>•</span>
                        <span>
                          {new Date(template.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                        <span>•</span>
                        <span>{template.items.length} SKUs</span>
                      </div>
                    </div>
                    <div className="flex gap-2 ml-4">
                      <Form method="post" className="inline">
                        <input type="hidden" name="intent" value="load-template" />
                        <input type="hidden" name="templateId" value={template.id} />
                        <button
                          type="submit"
                          className="btn btn-sm btn-primary"
                          disabled={isSubmitting}
                        >
                          Load
                        </button>
                      </Form>
                      <Form
                        method="post"
                        onSubmit={(e) => {
                          if (!confirm(`Are you sure you want to delete template "${template.title}"?`)) {
                            e.preventDefault();
                          }
                        }}
                        className="inline"
                      >
                        <input type="hidden" name="intent" value="delete-template" />
                        <input type="hidden" name="templateId" value={template.id} />
                        <button
                          type="submit"
                          className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
                          disabled={isSubmitting}
                        >
                          Delete
                        </button>
                      </Form>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
