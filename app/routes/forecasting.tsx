import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
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
    const needToBuild = Math.max(0, forecastedQty - currentInGallatin);

    // BOM explosion - calculate raw materials needed
    const rawMaterialsNeeded: Record<string, { skuId: string; sku: string; name: string; needed: number; available: number }> = {};
    const processTotals: Record<string, { units: number; seconds: number }> = {};

    if (needToBuild > 0) {
      // Process each component in the BOM
      for (const bomComp of sku.bomComponents) {
        const qtyNeeded = bomComp.quantity * needToBuild;
        const available = bomComp.componentSku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

        // Track process time for this component
        const compProcess = bomComp.componentSku.material;
        if (compProcess && processMap.has(compProcess)) {
          if (!processTotals[compProcess]) {
            processTotals[compProcess] = { units: 0, seconds: 0 };
          }
          processTotals[compProcess].units += qtyNeeded;
          processTotals[compProcess].seconds += qtyNeeded * (processMap.get(compProcess)?.secondsPerUnit || 0);
        }

        // If component is RAW, track shortage
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
        } else {
          // If it's an assembly, explode its BOM too
          for (const subComp of bomComp.componentSku.bomComponents) {
            const subQtyNeeded = subComp.quantity * qtyNeeded;
            const subAvailable = subComp.componentSku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

            // Track process time
            const subProcess = subComp.componentSku.material;
            if (subProcess && processMap.has(subProcess)) {
              if (!processTotals[subProcess]) {
                processTotals[subProcess] = { units: 0, seconds: 0 };
              }
              processTotals[subProcess].units += subQtyNeeded;
              processTotals[subProcess].seconds += subQtyNeeded * (processMap.get(subProcess)?.secondsPerUnit || 0);
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
        }
      }

      // Track final assembly process
      const finalProcess = sku.material;
      if (finalProcess && processMap.has(finalProcess)) {
        if (!processTotals[finalProcess]) {
          processTotals[finalProcess] = { units: 0, seconds: 0 };
        }
        processTotals[finalProcess].units += needToBuild;
        processTotals[finalProcess].seconds += needToBuild * (processMap.get(finalProcess)?.secondsPerUnit || 0);
      }
    }

    return {
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      currentInGallatin,
      forecastedQty,
      needToBuild,
      rawMaterialsNeeded: Object.values(rawMaterialsNeeded),
      processTotals,
      hasForecast: !!forecast,
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

  return { error: "Invalid action" };
};

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
                <th>SKU</th>
                <th>Product Name</th>
                <th className="text-right">Current in Gallatin</th>
                <th className="text-right">Forecasted Demand</th>
                <th className="text-right">Need to Build</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forecastData.map((item) => (
                <>
                  <tr key={item.skuId}>
                    <td className="font-mono text-sm">{item.sku}</td>
                    <td>{item.name}</td>
                    <td className="text-right">
                      <Form method="post" className="inline-flex items-center gap-2 justify-end">
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
                        />
                    </td>
                    <td className="text-right">
                        <input
                          type="number"
                          name="quantity"
                          className="form-input w-24 text-sm text-right"
                          min="0"
                          defaultValue={item.forecastedQty}
                          placeholder="0"
                          required
                        />
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
                    <td className="text-right">
                      <button
                        type="submit"
                        className="btn btn-xs btn-secondary whitespace-nowrap mr-2"
                        disabled={isSubmitting}
                      >
                        Save
                      </button>
                      </Form>
                      {item.needToBuild > 0 && (
                        <button
                          onClick={() => setExpandedSku(expandedSku === item.skuId ? null : item.skuId)}
                          className="btn btn-xs btn-ghost"
                        >
                          {expandedSku === item.skuId ? "Hide Details" : "View Details"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedSku === item.skuId && item.needToBuild > 0 && (
                    <tr>
                      <td colSpan={7} className="bg-gray-50 p-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <h4 className="font-semibold mb-2">Process Breakdown</h4>
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
                          <div>
                            <h4 className="font-semibold mb-2">Raw Materials Needed</h4>
                            {item.rawMaterialsNeeded.length === 0 ? (
                              <p className="text-sm text-gray-500">No raw materials needed</p>
                            ) : (
                              <table className="data-table-sm">
                                <thead>
                                  <tr>
                                    <th>SKU</th>
                                    <th className="text-right">Needed</th>
                                    <th className="text-right">Available</th>
                                    <th>Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.rawMaterialsNeeded.map((raw) => {
                                    const shortfall = Math.max(0, raw.needed - raw.available);
                                    return (
                                      <tr key={raw.skuId}>
                                        <td className="font-mono text-xs">{raw.sku}</td>
                                        <td className="text-right">{raw.needed}</td>
                                        <td className="text-right">{raw.available}</td>
                                        <td>
                                          {shortfall > 0 ? (
                                            <span className="text-xs text-red-600 font-semibold">-{shortfall}</span>
                                          ) : (
                                            <span className="text-xs text-green-600">✓</span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
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
    </Layout>
  );
}
