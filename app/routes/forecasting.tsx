import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation, useFetcher, useSearchParams } from "react-router";
import React, { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  getGallatinInventory,
  getUnfulfilledLineItems,
  aggregateUnfulfilledBySku,
  type UnfulfilledLineItem,
} from "../utils/shopify.server";
import {
  fetchProgrammedOrders,
  type ProgrammedOrdersResponse,
} from "../utils/queued-orders-client.server";
import { resolveProcessConfig } from "../utils/process";

// Recursive function to explode BOM and find all raw materials at any depth
async function explodeBomRecursively(
  skuId: string,
  quantity: number,
  rawMaterials: Map<string, { skuId: string; sku: string; name: string; needed: number; available: number }>,
  assemblies: Map<string, { skuId: string; sku: string; name: string; type: string; material: string | null; qtyPerUnit: number; totalNeeded: number; available: number }>,
  visited: Set<string> = new Set()
): Promise<void> {
  // Prevent infinite loops from circular references
  if (visited.has(skuId)) return;
  visited.add(skuId);

  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    include: {
      inventoryItems: {
        where: { quantity: { not: 0 } },
      },
      bomComponents: {
        include: {
          componentSku: {
            include: {
              inventoryItems: {
                where: { quantity: { not: 0 } },
              },
            },
          },
        },
      },
    },
  });

  if (!sku) return;

  for (const bomComp of sku.bomComponents) {
    const comp = bomComp.componentSku;
    const qtyNeeded = bomComp.quantity * quantity;
    const available = comp.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    if (comp.type === "RAW") {
      // Raw material - accumulate it
      const existing = rawMaterials.get(comp.id);
      if (existing) {
        existing.needed += qtyNeeded;
      } else {
        rawMaterials.set(comp.id, {
          skuId: comp.id,
          sku: comp.sku,
          name: comp.name,
          needed: qtyNeeded,
          available,
        });
      }
    } else if (comp.type === "ASSEMBLY") {
      // Track the assembly
      const existingAssembly = assemblies.get(comp.id);
      if (existingAssembly) {
        existingAssembly.totalNeeded += qtyNeeded;
      } else {
        assemblies.set(comp.id, {
          skuId: comp.id,
          sku: comp.sku,
          name: comp.name,
          type: comp.type,
          material: comp.material, // the process used to build this assembly
          qtyPerUnit: bomComp.quantity,
          totalNeeded: qtyNeeded,
          available,
        });
      }

      // Calculate shortfall - how many we still need to build
      const shortfall = Math.max(0, qtyNeeded - available);

      // Recursively explode this assembly's BOM for the shortfall quantity
      if (shortfall > 0) {
        await explodeBomRecursively(comp.id, shortfall, rawMaterials, assemblies, visited);
      }
    }
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const tab = url.searchParams.get("tab") || "forecast";

  // Default to next 7 days if not specified
  const laborStart = startDate ? new Date(startDate) : new Date();
  const laborEnd = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Fetch live Gallatin inventory from Shopify. Used to populate
  // `currentInGallatin` instead of a manually-entered number. Failures
  // fall back to whatever's stored on the Forecast row so the page still
  // loads if Shopify is unreachable.
  let gallatinInventory: Map<string, number> | null = null;
  let shopifyError: string | null = null;
  try {
    gallatinInventory = await getGallatinInventory();
  } catch (err) {
    shopifyError = err instanceof Error ? err.message : String(err);
    console.error("[forecasting] Shopify inventory fetch failed:", shopifyError);
  }

  // The Forecast tab now also needs unfulfilled + programmed totals per
  // SKU for the new columns and the Need-to-Build calculation, so we
  // fetch them whenever the user is on Forecast, Unfulfilled, or
  // Programmed. (Caching in the clients keeps repeated visits cheap.)
  const needsExternalData = tab === "forecast" || tab === "unfulfilled" || tab === "programmed";

  let unfulfilledItems: UnfulfilledLineItem[] | null = null;
  let unfulfilledError: string | null = null;
  if (needsExternalData) {
    try {
      unfulfilledItems = await getUnfulfilledLineItems();
    } catch (err) {
      unfulfilledError = err instanceof Error ? err.message : String(err);
      console.error("[forecasting] Unfulfilled fetch failed:", unfulfilledError);
    }
  }

  let programmedOrders: ProgrammedOrdersResponse | null = null;
  let programmedError: string | null = null;
  if (needsExternalData) {
    try {
      programmedOrders = await fetchProgrammedOrders({
        from: laborStart.toISOString().split("T")[0],
        to: laborEnd.toISOString().split("T")[0],
      });
    } catch (err) {
      programmedError = err instanceof Error ? err.message : String(err);
      console.error("[forecasting] Programmed orders fetch failed:", programmedError);
    }
  }

  // Per-SKU rollup maps used by the Forecast tab columns. Shopify variant SKUs
  // and our DB SKUs can differ in case (e.g. "COC-TI-3PACK-100g-2.0in" vs
  // "COC-TI-3PACK-100G-2.0IN"), so an exact-string join silently misses and the
  // Forecast tab shows 0 even though the Unfulfilled tab shows the real number.
  // Key everything by a normalized (trim + upper-case) SKU and accumulate.
  const normSku = (s: string) => s.trim().toUpperCase();

  const unfulfilledQtyBySku = new Map<string, number>();
  if (unfulfilledItems) {
    for (const it of unfulfilledItems) {
      const k = normSku(it.sku);
      unfulfilledQtyBySku.set(k, (unfulfilledQtyBySku.get(k) ?? 0) + it.quantity);
    }
  }
  const programmedQtyBySku = new Map<string, number>();
  if (programmedOrders) {
    for (const row of programmedOrders.bySku) {
      const k = normSku(row.sku);
      programmedQtyBySku.set(k, (programmedQtyBySku.get(k) ?? 0) + row.quantity);
    }
  }
  // Same normalization for live Gallatin inventory (also Shopify-keyed).
  const gallatinQtyByNormSku = new Map<string, number>();
  if (gallatinInventory) {
    for (const [s, q] of gallatinInventory) {
      const k = normSku(s);
      gallatinQtyByNormSku.set(k, (gallatinQtyByNormSku.get(k) ?? 0) + q);
    }
  }

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
            select: {
              id: true,
              sku: true,
              name: true,
              type: true,
              material: true,
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

  // Calculate forecast data for each SKU using recursive BOM explosion
  const forecastData: Array<{
    skuId: string;
    sku: string;
    name: string;
    currentCompleted: number;
    currentInGallatin: number;
    forecastedQty: number;
    unfulfilledQty: number;
    programmedQty: number;
    needToBuild: number;
    assemblySkusNeeded: Array<{ skuId: string; sku: string; name: string; type: string; qtyPerUnit: number; totalNeeded: number; available: number }>;
    rawMaterialsNeeded: Array<{ skuId: string; sku: string; name: string; needed: number; available: number }>;
    processTotals: Record<string, { units: number; seconds: number }>;
    hasForecast: boolean;
    hasSufficientRawMaterials: boolean;
    buildTimeHours: number;
  }> = [];

  for (const sku of completedSkus) {
    const forecast = forecastMap.get(sku.id);
    // Prefer the live Shopify number when available; fall back to the
    // stored manual value so the page still calculates if Shopify is down.
    const skuKey = normSku(sku.sku);
    const liveGallatin = gallatinQtyByNormSku.get(skuKey);
    // Floor at 0 — Shopify reports negative "available" for oversold items,
    // but we never show negative on-hand inventory.
    const currentInGallatin = Math.max(0, liveGallatin ?? forecast?.currentInGallatin ?? 0);
    const forecastedQty = forecast?.quantity || 0;
    const unfulfilledQty = unfulfilledQtyBySku.get(skuKey) ?? 0;
    const programmedQty = programmedQtyBySku.get(skuKey) ?? 0;

    // Calculate current completed inventory
    const currentCompleted = sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    // Need to Build = (Unfulfilled + Programmed) − (Current Completed + Current in Gallatin)
    // The manual `forecastedQty` is still saved for reference but no longer
    // drives this calculation — live demand replaces it.
    const totalDemand = unfulfilledQty + programmedQty;
    const needToBuild = Math.max(0, totalDemand - (currentCompleted + currentInGallatin));

    // Use recursive BOM explosion to find ALL raw materials at any depth
    const rawMaterialsMap = new Map<string, { skuId: string; sku: string; name: string; needed: number; available: number }>();
    const assembliesMap = new Map<string, { skuId: string; sku: string; name: string; type: string; material: string | null; qtyPerUnit: number; totalNeeded: number; available: number }>();

    // Always explode so clicking "+" shows the bill of materials even when the
    // SKU is sufficient (needToBuild = 0). With qty 0 this lists the immediate
    // components and their per-unit quantities (availability/totals are only
    // rendered when needToBuild > 0).
    await explodeBomRecursively(sku.id, needToBuild, rawMaterialsMap, assembliesMap);

    // Process labor for EVERY stage that must be built — not just the final
    // pack: the pack process for `needToBuild`, plus each sub-assembly's
    // process for its shortfall (e.g. stud-testing short broadheads, blading
    // short ferrules, tipping short tipped-ferrules). A SKU's process is stored
    // in its `material` field.
    const processTotals: Record<string, { units: number; seconds: number }> = {};
    if (needToBuild > 0) {
      const addLabor = (material: string | null, units: number) => {
        if (units <= 0) return;
        // Resolve the SKU's `material` to its process the SAME way the Process
        // Times page and worker submit-task do, so labor counts every stage.
        const cfg = resolveProcessConfig(material, processConfigs);
        if (!cfg) return;
        const key = cfg.displayName;
        if (!processTotals[key]) processTotals[key] = { units: 0, seconds: 0 };
        processTotals[key].units += units;
        processTotals[key].seconds += units * (cfg.secondsPerUnit || 0);
      };
      // Final pack/assembly stage for the whole quantity being built.
      addLabor(sku.material, needToBuild);
      // Each sub-assembly that is short must itself be built (its shortfall).
      for (const asm of assembliesMap.values()) {
        addLabor(asm.material, Math.max(0, asm.totalNeeded - asm.available));
      }
    }

    // Check if all raw materials are sufficient
    const rawMaterialsList = Array.from(rawMaterialsMap.values());
    const hasSufficientRawMaterials = rawMaterialsList.length > 0 && rawMaterialsList.every(raw => raw.available >= raw.needed);

    // Calculate total build time in hours
    const totalBuildSeconds = Object.values(processTotals).reduce((sum, p) => sum + p.seconds, 0);
    const buildTimeHours = totalBuildSeconds / 3600;

    forecastData.push({
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      currentCompleted,
      currentInGallatin,
      forecastedQty,
      unfulfilledQty,
      programmedQty,
      needToBuild,
      assemblySkusNeeded: Array.from(assembliesMap.values()),
      rawMaterialsNeeded: rawMaterialsList,
      processTotals,
      hasForecast: !!forecast,
      hasSufficientRawMaterials,
      buildTimeHours,
    });
  }

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

  // Build a list of Gallatin inventory rows (SKU + live qty) that beast
  // doesn't otherwise know about — useful as a quick reference on the
  // Forecast tab. Only include SKUs that exist in beast's catalog.
  const allCompletedAndRawSkus = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["RAW", "ASSEMBLY", "COMPLETED"] } },
    select: { id: true, sku: true, name: true, type: true },
    orderBy: { sku: "asc" },
  });
  const gallatinRows = gallatinInventory
    ? allCompletedAndRawSkus
        .map((s) => {
          // Normalized lookup (Shopify SKU casing differs from ours) and floor
          // at 0 so oversold items never display as negative inventory.
          const v = gallatinQtyByNormSku.get(normSku(s.sku));
          return {
            sku: s.sku,
            name: s.name,
            type: s.type,
            available: v == null ? null : Math.max(0, v),
          };
        })
        .filter((r) => r.available !== null) as { sku: string; name: string; type: string; available: number }[]
    : [];

  // Aggregate unfulfilled line items by SKU for the Unfulfilled tab
  const unfulfilledBySku = unfulfilledItems
    ? Array.from(aggregateUnfulfilledBySku(unfulfilledItems).entries())
        .map(([sku, agg]) => ({ sku, ...agg }))
        .sort((a, b) => b.quantity - a.quantity)
    : [];

  return {
    user,
    tab,
    forecastData,
    totalProcessRequirements,
    allRawMaterialShortages: Object.values(allRawMaterialShortages),
    laborStart: laborStart.toISOString().split('T')[0],
    laborEnd: laborEnd.toISOString().split('T')[0],
    availableLaborHours,
    totalLaborHoursNeeded,
    daysDiff,
    templates,
    // Integration data
    gallatinRows,
    shopifyError,
    unfulfilledItems,
    unfulfilledBySku,
    unfulfilledError,
    programmedOrders,
    programmedError,
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

  if (intent === "bulk-update-forecasts") {
    // Get all COMPLETED SKUs
    const completedSkus = await prisma.sku.findMany({
      where: { isActive: true, type: "COMPLETED" },
      select: { id: true },
    });

    let updatedCount = 0;

    for (const sku of completedSkus) {
      const forecastedQtyStr = formData.get(`forecastedQty_${sku.id}`) as string;
      const currentInGallatinStr = formData.get(`currentInGallatin_${sku.id}`) as string;

      if (forecastedQtyStr && currentInGallatinStr) {
        const quantity = parseInt(forecastedQtyStr, 10);
        const currentInGallatin = parseInt(currentInGallatinStr, 10);

        if (!isNaN(quantity) && !isNaN(currentInGallatin) && quantity >= 0 && currentInGallatin >= 0) {
          await prisma.forecast.upsert({
            where: { skuId: sku.id },
            create: { skuId: sku.id, quantity, currentInGallatin },
            update: { quantity, currentInGallatin },
          });
          updatedCount++;
        }
      }
    }

    await createAuditLog(user.id, "BULK_UPDATE_FORECASTS", "Forecast", "", {
      updatedCount,
    });

    return { success: true, message: `Updated ${updatedCount} forecast(s) successfully` };
  }

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
    unfulfilledQty: number;
    programmedQty: number;
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
          <input
            type="hidden"
            name={`currentInGallatin_${item.skuId}`}
            value={item.currentInGallatin}
          />
          <div className="flex items-center justify-end gap-1.5">
            <span className="font-semibold text-gray-900">{item.currentInGallatin}</span>
            <span
              className="text-xs text-blue-500"
              title="Live value from Shopify Gallatin location"
            >
              ●
            </span>
          </div>
        </td>
        <td className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className={item.unfulfilledQty > 0 ? "font-semibold text-orange-600" : "text-gray-400"}>
              {item.unfulfilledQty}
            </span>
            <span className="text-xs text-blue-500" title="Live from Shopify open orders">●</span>
          </div>
        </td>
        <td className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className={item.programmedQty > 0 ? "font-semibold text-blue-600" : "text-gray-400"}>
              {item.programmedQty}
            </span>
            <span className="text-xs text-blue-500" title="Queued orders scheduled in the selected date range">●</span>
          </div>
        </td>
        <td className="text-right">
          <input
            type="number"
            name={`forecastedQty_${item.skuId}`}
            className="form-input w-24 text-sm text-right"
            min="0"
            defaultValue={item.forecastedQty}
            placeholder="0"
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

              {/* Assembled SKUs */}
              {item.assemblySkusNeeded.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 text-gray-900">Assembled Components</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    Assembled SKUs required for this product
                    {item.needToBuild > 0 && ` (to build ${item.needToBuild} units)`}
                  </p>
                  <table className="data-table-sm">
                    <thead>
                      <tr>
                        <th>Assembly SKU</th>
                        <th>Name</th>
                        <th className="text-right">Per Unit</th>
                        {item.needToBuild > 0 && (
                          <>
                            <th className="text-right">Total Needed</th>
                            <th className="text-right">Available</th>
                            <th className="text-right">Shortfall</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {item.assemblySkusNeeded.map((assembly) => {
                        const shortfall = Math.max(0, assembly.totalNeeded - assembly.available);
                        return (
                          <tr key={assembly.skuId}>
                            <td className="font-mono text-sm">{assembly.sku}</td>
                            <td>{assembly.name}</td>
                            <td className="text-right text-gray-600">{assembly.qtyPerUnit}</td>
                            {item.needToBuild > 0 && (
                              <>
                                <td className="text-right font-semibold">{assembly.totalNeeded}</td>
                                <td className="text-right text-green-600">{assembly.available}</td>
                                <td className="text-right">
                                  {shortfall > 0 ? (
                                    <span className="font-bold text-orange-600">{shortfall}</span>
                                  ) : (
                                    <span className="text-green-600">✓</span>
                                  )}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-xs text-gray-500 mt-2">
                    Note: Raw materials below are only calculated for assemblies that need to be built (shortfall)
                  </p>
                </div>
              )}

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

              {item.assemblySkusNeeded.length === 0 && item.rawMaterialsNeeded.length === 0 && (
                <p className="text-sm text-gray-500">
                  No bill of materials is configured for this SKU.
                </p>
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
    tab,
    forecastData,
    totalProcessRequirements,
    allRawMaterialShortages,
    laborStart,
    laborEnd,
    availableLaborHours,
    totalLaborHoursNeeded,
    daysDiff,
    templates,
    gallatinRows,
    shopifyError,
    unfulfilledItems,
    unfulfilledBySku,
    unfulfilledError,
    programmedOrders,
    programmedError,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [searchParams] = useSearchParams();

  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const laborCapacitySufficient = availableLaborHours >= totalLaborHoursNeeded;

  const buildTabUrl = (nextTab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", nextTab);
    return `/forecasting?${next.toString()}`;
  };

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

      {/* Date range — drives both labor calc and programmed orders */}
      <div className="card mb-4">
        <div className="card-body">
          <Form method="get" className="flex items-end gap-3 flex-wrap">
            <input type="hidden" name="tab" value={tab} />
            <div className="form-group mb-0">
              <label className="form-label">From</label>
              <input
                type="date"
                name="startDate"
                className="form-input"
                defaultValue={laborStart}
              />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">To</label>
              <input
                type="date"
                name="endDate"
                className="form-input"
                defaultValue={laborEnd}
              />
            </div>
            <button type="submit" className="btn btn-secondary">Apply</button>
            <span className="text-xs text-gray-500 ml-2">
              {daysDiff} day{daysDiff !== 1 ? "s" : ""} · range filters Programmed Orders and labor capacity
            </span>
          </Form>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs mb-4">
        <Link to={buildTabUrl("forecast")} className={`tab ${tab === "forecast" ? "active" : ""}`}>
          Forecast
        </Link>
        <Link to={buildTabUrl("unfulfilled")} className={`tab ${tab === "unfulfilled" ? "active" : ""}`}>
          Unfulfilled
          {unfulfilledBySku.length > 0 && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {unfulfilledBySku.length}
            </span>
          )}
        </Link>
        <Link to={buildTabUrl("programmed")} className={`tab ${tab === "programmed" ? "active" : ""}`}>
          Programmed Orders
          {programmedOrders && programmedOrders.count > 0 && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {programmedOrders.count}
            </span>
          )}
        </Link>
      </div>

      {shopifyError && tab === "forecast" && (
        <div className="alert alert-warning text-sm">
          Shopify unavailable — Current in Gallatin numbers may be stale. ({shopifyError})
        </div>
      )}

      {tab === "unfulfilled" && (
        <UnfulfilledTab
          items={unfulfilledItems}
          bySku={unfulfilledBySku}
          error={unfulfilledError}
        />
      )}

      {tab === "programmed" && (
        <ProgrammedOrdersTab
          data={programmedOrders}
          error={programmedError}
          from={laborStart}
          to={laborEnd}
        />
      )}

      {tab === "forecast" && (
      <>

      {/* Forecast Input Table */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Production Forecast</h2>
          <p className="text-sm text-gray-500">Enter forecasted demand for each completed SKU</p>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="bulk-update-forecasts" />
            <table className="data-table">
            <thead>
              <tr>
                <th className="w-12"></th>
                <th>SKU</th>
                <th>Product Name</th>
                <th className="text-right">Current Completed</th>
                <th className="text-right">Current in Gallatin</th>
                <th className="text-right" title="Open Shopify orders, unfulfilled qty">Unfulfilled</th>
                <th className="text-right" title="Queued orders scheduled in the selected date range">Programmed</th>
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
          <div className="mt-4 pt-4 border-t flex justify-end">
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </Form>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
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

      </>
      )}
    </Layout>
  );
}

// ============================================================
// Unfulfilled tab — Shopify orders with remaining unfulfilled qty
// ============================================================

function UnfulfilledTab({
  items,
  bySku,
  error,
}: {
  items: UnfulfilledLineItem[] | null;
  bySku: { sku: string; quantity: number; orderCount: number }[];
  error: string | null;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  if (error) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="alert alert-error">
            Couldn't load unfulfilled line items from Shopify: {error}
          </div>
        </div>
      </div>
    );
  }
  if (!items) {
    return (
      <div className="card">
        <div className="card-body text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }
  if (bySku.length === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="empty-state">
            <h3 className="empty-state-title">No unfulfilled line items</h3>
            <p className="empty-state-description">
              Every open Shopify order is fulfilled. Nice.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Unfulfilled Line Items</h2>
        <p className="text-sm text-gray-500">
          Live from Shopify · {items.length} line item{items.length !== 1 ? "s" : ""} across {bySku.length} SKU{bySku.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              <th>SKU</th>
              <th className="text-right">Total Unfulfilled</th>
              <th className="text-right">Order Count</th>
            </tr>
          </thead>
          <tbody>
            {bySku.map((row) => {
              const isOpen = expandedSku === row.sku;
              const skuItems = items.filter((i) => i.sku === row.sku);
              return (
                <React.Fragment key={row.sku}>
                  <tr
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => setExpandedSku(isOpen ? null : row.sku)}
                  >
                    <td className="w-12 text-center">
                      <span className="text-lg font-bold">{isOpen ? "−" : "+"}</span>
                    </td>
                    <td className="font-mono text-sm">{row.sku.toUpperCase()}</td>
                    <td className="text-right font-semibold text-orange-600">
                      {row.quantity}
                    </td>
                    <td className="text-right">{row.orderCount}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4} className="bg-gray-50 p-0">
                        <div className="p-4">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-gray-600">
                                <th className="pb-2">Order</th>
                                <th className="pb-2">Title</th>
                                <th className="pb-2">Created</th>
                                <th className="pb-2 text-right">Qty unfulfilled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {skuItems.map((li, idx) => (
                                <tr key={`${li.orderId}-${idx}`} className="border-t border-gray-200">
                                  <td className="py-2 font-mono">{li.orderName}</td>
                                  <td className="py-2">{li.title}</td>
                                  <td className="py-2">
                                    {new Date(li.orderCreatedAt).toLocaleDateString()}
                                  </td>
                                  <td className="py-2 text-right">{li.quantity}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Programmed Orders tab — queued-orders within date range
// ============================================================

function ProgrammedOrdersTab({
  data,
  error,
  from,
  to,
}: {
  data: ProgrammedOrdersResponse | null;
  error: string | null;
  from: string;
  to: string;
}) {
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  if (error) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="alert alert-error">
            Couldn't load programmed orders: {error}
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card">
        <div className="card-body text-gray-500 text-sm">Loading…</div>
      </div>
    );
  }
  if (data.count === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="empty-state">
            <h3 className="empty-state-title">No programmed orders</h3>
            <p className="empty-state-description">
              No queued orders scheduled between {from} and {to}.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card mb-4">
        <div className="card-header">
          <h2 className="card-title">Programmed Orders ({from} → {to})</h2>
          <p className="text-sm text-gray-500">
            {data.count} order{data.count !== 1 ? "s" : ""} · {data.totalUnits} unit{data.totalUnits !== 1 ? "s" : ""} · ${data.totalAmount.toFixed(2)}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>SKU</th>
                <th className="text-right">Programmed Qty</th>
                <th className="text-right">Orders</th>
              </tr>
            </thead>
            <tbody>
              {data.bySku.map((row) => {
                const isOpen = expandedSku === row.sku;
                const ordersWithSku = data.orders.filter((o) =>
                  o.lineItems.some((li) => (li.sku || "(no SKU)") === row.sku)
                );
                return (
                  <React.Fragment key={row.sku}>
                    <tr
                      className="cursor-pointer hover:bg-gray-50"
                      onClick={() => setExpandedSku(isOpen ? null : row.sku)}
                    >
                      <td className="w-12 text-center">
                        <span className="text-lg font-bold">{isOpen ? "−" : "+"}</span>
                      </td>
                      <td className="font-mono text-sm">{row.sku.toUpperCase()}</td>
                      <td className="text-right font-semibold text-blue-600">
                        {row.quantity}
                      </td>
                      <td className="text-right">{row.orderCount}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={4} className="bg-gray-50 p-0">
                          <div className="p-4">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-gray-600">
                                  <th className="pb-2">Customer</th>
                                  <th className="pb-2">PO #</th>
                                  <th className="pb-2">Scheduled</th>
                                  <th className="pb-2 text-right">Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ordersWithSku.map((o) => {
                                  const qty = o.lineItems
                                    .filter((li) => (li.sku || "(no SKU)") === row.sku)
                                    .reduce((s, li) => s + li.quantity, 0);
                                  return (
                                    <tr key={o.id} className="border-t border-gray-200">
                                      <td className="py-2">
                                        {o.customerName}
                                        {o.companyName && (
                                          <span className="text-xs text-gray-500 ml-1">
                                            ({o.companyName})
                                          </span>
                                        )}
                                        {o.holdAutoConvert && (
                                          <span className="ml-1 badge bg-yellow-100 text-yellow-800 text-xs">
                                            Hold
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2 font-mono text-xs">
                                        {o.poNumber || "—"}
                                      </td>
                                      <td className="py-2">
                                        {new Date(o.scheduledDate).toLocaleDateString()}
                                      </td>
                                      <td className="py-2 text-right">{qty}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
