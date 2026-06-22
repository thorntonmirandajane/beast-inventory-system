import prisma from "../db.server";
import { availableState } from "./production";
import { resolveProcessConfig } from "./process";
import { getUnfulfilledLineItems, getGallatinInventory } from "./shopify.server";
import { fetchProgrammedOrders } from "./queued-orders-client.server";
import type { WorkItem, WorkerCapacity } from "./assignments";

const norm = (s: string) => s.trim().toUpperCase();
function parseTime(t: string): number {
  const [h, m] = (t || "0:0").split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
}
function stageOrder(displayName: string): number {
  const d = displayName.toLowerCase();
  if (d.includes("tip")) return 1;
  if (d.includes("blad")) return 2;
  if (d.includes("stud")) return 3;
  if (d.includes("pack")) return 4;
  return 5;
}

export interface DailyPlan {
  workers: WorkerCapacity[];
  queue: WorkItem[];
  warnings: string[];
  pendingApplied: number; // how many pending lines were projected in
}

/**
 * Build the daily work queue + scheduled-worker capacity for `targetDate`.
 *
 * Inventory is PROJECTED: approved on-hand + every submitted-but-not-yet-approved
 * time-entry line applied (output added, immediate BOM children consumed), so the
 * day's pending-QC work isn't re-assigned. Need-to-build is netted the same way the
 * Forecast page does, so the numbers line up.
 */
export async function computeDailyPlan(
  targetDate: Date,
  demandFrom: Date,
  demandTo: Date
): Promise<DailyPlan> {
  const warnings: string[] = [];

  // 1) SKUs + immediate BOMs
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
      material: true,
      bomComponents: { select: { componentSkuId: true, quantity: true } },
    },
  });
  const skuById = new Map(skus.map((s) => [s.id, s]));

  // 2) Approved available (units in each SKU's available state)
  const inv = await prisma.inventoryItem.groupBy({ by: ["skuId", "state"], _sum: { quantity: true } });
  const available = new Map<string, number>();
  for (const s of skus) {
    const st = availableState(s.type);
    const row = inv.find((i) => i.skuId === s.id && i.state === st);
    available.set(s.id, row?._sum.quantity ?? 0);
  }

  // 3) Project pending (submitted, not-yet-approved) production onto `available`
  const pendingLines = await prisma.timeEntryLine.findMany({
    where: { isMisc: false, skuId: { not: null }, timeEntry: { status: "PENDING" } },
    select: {
      skuId: true,
      quantityCompleted: true,
      adminAdjustedQuantity: true,
      isRejected: true,
      rejectionQuantity: true,
    },
  });
  let pendingApplied = 0;
  for (const line of pendingLines) {
    const out = skuById.get(line.skuId!);
    if (!out || out.bomComponents.length === 0) continue;
    const base = line.adminAdjustedQuantity ?? line.quantityCompleted;
    const accepted = line.isRejected ? 0 : base - (line.rejectionQuantity ?? 0);
    if (accepted <= 0) continue;
    available.set(out.id, (available.get(out.id) ?? 0) + accepted);
    for (const c of out.bomComponents) {
      available.set(c.componentSkuId, (available.get(c.componentSkuId) ?? 0) - c.quantity * accepted);
    }
    pendingApplied++;
  }

  // 4) Demand (unfulfilled + programmed) + Gallatin, normalized by SKU case
  const demand = new Map<string, number>();
  try {
    for (const it of await getUnfulfilledLineItems()) {
      demand.set(norm(it.sku), (demand.get(norm(it.sku)) ?? 0) + it.quantity);
    }
  } catch (e) {
    warnings.push("Unfulfilled demand unavailable: " + (e instanceof Error ? e.message : String(e)));
  }
  try {
    const prog = await fetchProgrammedOrders({
      from: demandFrom.toISOString().split("T")[0],
      to: demandTo.toISOString().split("T")[0],
    });
    for (const row of prog.bySku) demand.set(norm(row.sku), (demand.get(norm(row.sku)) ?? 0) + row.quantity);
  } catch (e) {
    warnings.push("Programmed demand unavailable: " + (e instanceof Error ? e.message : String(e)));
  }
  const gallatin = new Map<string, number>();
  try {
    for (const [s, q] of await getGallatinInventory()) gallatin.set(norm(s), Math.max(0, q));
  } catch {
    warnings.push("Gallatin inventory unavailable — planning off internal stock only.");
  }

  // 5) Need-to-build per completed SKU, then explode to sub-assembly gross need
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { processName: true, displayName: true, secondsPerUnit: true },
  });
  const grossNeeded = new Map<string, number>(); // skuId -> gross units needed (sub-assemblies)

  function explode(skuId: string, qty: number, visited: Set<string>) {
    const sku = skuById.get(skuId);
    if (!sku || qty <= 0 || visited.has(skuId)) return;
    visited.add(skuId);
    for (const c of sku.bomComponents) {
      const child = skuById.get(c.componentSkuId);
      if (!child || child.type !== "ASSEMBLY") continue;
      const needed = c.quantity * qty;
      grossNeeded.set(child.id, (grossNeeded.get(child.id) ?? 0) + needed);
      const shortfall = Math.max(0, needed - (available.get(child.id) ?? 0));
      if (shortfall > 0) explode(child.id, shortfall, new Set(visited));
    }
  }

  const queue: WorkItem[] = [];
  const toWorkItem = (skuId: string, units: number): WorkItem | null => {
    const sku = skuById.get(skuId);
    if (!sku || units <= 0 || sku.bomComponents.length === 0) return null;
    const cfg = resolveProcessConfig(sku.material, processConfigs);
    const display = cfg?.displayName ?? sku.material ?? "Unassigned";
    const buildable = sku.bomComponents.every(
      (c) => (available.get(c.componentSkuId) ?? 0) >= c.quantity * units
    );
    return {
      process: display,
      processName: cfg?.processName ?? "",
      skuId,
      sku: sku.sku,
      name: sku.name,
      units,
      hoursPerUnit: (cfg?.secondsPerUnit ?? 0) / 3600,
      buildable,
      stageOrder: stageOrder(display),
    };
  };

  // Completed SKUs: need = demand − projected completed − gallatin (matches Forecast)
  for (const s of skus) {
    if (s.type !== "COMPLETED") continue;
    const d = demand.get(norm(s.sku)) ?? 0;
    if (d <= 0) continue;
    const need = Math.max(0, d - (available.get(s.id) ?? 0) - (gallatin.get(norm(s.sku)) ?? 0));
    if (need <= 0) continue;
    const wi = toWorkItem(s.id, need);
    if (wi) queue.push(wi);
    explode(s.id, need, new Set());
  }
  // Sub-assemblies: build qty = gross need − projected available
  for (const [skuId, gross] of grossNeeded) {
    const buildQty = Math.max(0, gross - (available.get(skuId) ?? 0));
    const wi = toWorkItem(skuId, buildQty);
    if (wi) queue.push(wi);
  }

  // 6) Scheduled workers for the date (SPECIFIC_DATE wins over RECURRING)
  const dayOfWeek = targetDate.getDay();
  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(targetDate);
  dayEnd.setHours(23, 59, 59, 999);
  const schedules = await prisma.workerSchedule.findMany({
    where: {
      isActive: true,
      OR: [
        { scheduleType: "SPECIFIC_DATE", scheduleDate: { gte: dayStart, lte: dayEnd } },
        { scheduleType: "RECURRING", dayOfWeek },
      ],
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, isActive: true } } },
  });
  const byUser = new Map<string, { name: string; hours: number; specific: boolean }>();
  for (const sc of schedules) {
    if (!sc.user.isActive) continue;
    const hours = Math.max(0, parseTime(sc.endTime) - parseTime(sc.startTime));
    const isSpecific = sc.scheduleType === "SPECIFIC_DATE";
    const existing = byUser.get(sc.userId);
    if (!existing || (isSpecific && !existing.specific)) {
      byUser.set(sc.userId, { name: `${sc.user.firstName} ${sc.user.lastName}`, hours, specific: isSpecific });
    }
  }
  const workers: WorkerCapacity[] = Array.from(byUser.entries()).map(([userId, v]) => ({
    userId,
    name: v.name,
    hours: v.hours,
  }));

  return { workers, queue, warnings, pendingApplied };
}
