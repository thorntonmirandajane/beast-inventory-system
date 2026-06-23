import prisma from "../db.server";
import { getSalesBySku, getSalesBreakdownBySku } from "./shopify.server";
import { fetchProgrammedOrders } from "./queued-orders-client.server";
import { availableState } from "./production";

const norm = (s: string) => s.trim().toUpperCase();
const ymd = (d: Date) => d.toISOString().split("T")[0];

// Effective sales window (YTD): scenario values, or Jan 1→today as default.
function salesWindow(sc: { salesStart: Date | null; salesEnd: Date | null }) {
  const now = new Date();
  return {
    start: sc.salesStart ?? new Date(Date.UTC(now.getFullYear(), 0, 1)),
    end: sc.salesEnd ?? now,
  };
}

export async function getOrCreateScenario() {
  let sc = await prisma.forecastScenario.findFirst({ orderBy: { createdAt: "asc" } });
  if (!sc) {
    const now = new Date();
    const ly = now.getFullYear() - 1;
    sc = await prisma.forecastScenario.create({
      data: {
        globalMultiplier: 2.0,
        salesStart: new Date(Date.UTC(now.getFullYear(), 0, 1)),
        salesEnd: now,
        comparisonStart: new Date(Date.UTC(ly, now.getMonth(), now.getDate())),
        comparisonEnd: new Date(Date.UTC(ly, 11, 31)),
        horizonStart: now,
        horizonEnd: new Date(Date.UTC(now.getFullYear(), 11, 31)),
      },
    });
  }
  return sc;
}

export interface CompletedRow {
  skuId: string;
  sku: string;
  name: string;
  category: string;
  fulfilled: number;
  unfulfilled: number;
  programmed: number;
  computedPlanned: number; // multiplier × prior-year (the formula value)
  plannedProjection: number; // override ?? computedPlanned
  isOverridden: boolean;
  total2026: number; // fulfilled + unfulfilled + programmed + plannedProjection
}

export interface RawRow {
  skuId: string;
  sku: string;
  name: string;
  partType: string;
  material: string;
  category: string;
  fulfilled: number;
  unfulfilled: number;
  programmed: number;
  plannedProjection: number;
  qtyStillNeeded: number; // unfulfilled + programmed + plannedProjection
  onHand: number; // RAW available stock
  inAssembly: number; // raws embedded in built (ASSEMBLED + COMPLETED) stock
  onOrder: number; // open PO remainder
  needToOrder: number; // max(0, stillNeeded − onHand − inAssembly − onOrder)
  total2026: number; // fulfilled + unfulfilled + programmed + plannedProjection
}

function materialOf(sku: string, name: string): string {
  const s = `${sku} ${name}`.toUpperCase();
  if (s.includes("COC")) return "Cut-on-Contact";
  if (/\bTI\b/.test(s) || s.includes("-TI-") || s.startsWith("TI") || s.includes("TITANIUM")) return "Titanium";
  if (/\bAL\b/.test(s) || s.includes("-AL-") || s.startsWith("AL") || s.includes("ALUMINUM")) return "Aluminum";
  if (/\bCB\b/.test(s) || s.includes("CARBON")) return "Carbon";
  return "Other";
}
function partTypeOf(sku: string, name: string): string {
  const s = `${sku} ${name}`.toUpperCase();
  if (s.includes("FERRULE")) return "Ferrules";
  if (s.includes("BLADE")) return "Blades";
  if (s.includes("INSERT")) return "Inserts";
  if (s.includes("COLLAR")) return "Collars";
  if (s.includes("O-RING") || s.includes("ORING")) return "O-rings";
  if (s.includes("STUD") || s.includes("SCREW") || s.includes("PIN")) return "Hardware";
  if (s.includes("PACK") || s.includes("BOX") || s.includes("LABEL") || s.includes("CARD") || s.includes("BAG")) return "Packaging";
  return "Other";
}

export async function computeProjections() {
  const scenario = await getOrCreateScenario();
  const [overrides, sales, skus, invRows, openItems] = await Promise.all([
    prisma.forecastOverride.findMany(),
    prisma.projectionSale.findMany(),
    prisma.sku.findMany({
      where: { isActive: true },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        category: true,
        bomComponents: { select: { componentSkuId: true, quantity: true } },
      },
    }),
    prisma.inventoryItem.groupBy({ by: ["skuId", "state"], _sum: { quantity: true } }),
    prisma.pOItem.findMany({
      where: { purchaseOrder: { status: { in: ["SUBMITTED", "PARTIAL", "APPROVED"] } } },
      select: {
        skuId: true,
        quantityOrdered: true,
        quantityReceived: true,
        purchaseOrder: { select: { children: { select: { id: true }, take: 1 } } },
      },
    }),
  ]);

  const skuById = new Map(skus.map((s) => [s.id, s]));
  const overrideBySku = new Map(overrides.map((o) => [o.skuId, o]));
  const salesBySku = new Map(sales.map((s) => [s.skuId, s]));

  // Inventory lookups.
  const invByState = new Map<string, number>(); // `${skuId}:${state}` -> qty
  for (const r of invRows) invByState.set(`${r.skuId}:${r.state}`, r._sum.quantity ?? 0);
  const availQty = (s: { id: string; type: string }) =>
    invByState.get(`${s.id}:${availableState(s.type as any)}`) ?? 0;

  // Gross BOM explosion accumulator (cycle-guarded, depth 10).
  function explodeInto(target: Map<string, number>, skuId: string, qty: number, visited: Set<string>, depth: number) {
    if (qty <= 0 || depth > 10 || visited.has(skuId)) return;
    visited.add(skuId);
    const sku = skuById.get(skuId);
    if (!sku) return;
    for (const c of sku.bomComponents) {
      const child = skuById.get(c.componentSkuId);
      if (!child) continue;
      const need = c.quantity * qty;
      if (child.type === "RAW") target.set(child.id, (target.get(child.id) ?? 0) + need);
      else explodeInto(target, child.id, need, new Set(visited), depth + 1);
    }
  }

  // ---- Bottom: completed-SKU demand rows ----
  const completedRows: CompletedRow[] = [];
  const rawF = new Map<string, number>();
  const rawU = new Map<string, number>();
  const rawP = new Map<string, number>();
  const rawPl = new Map<string, number>();

  for (const s of skus) {
    if (s.type !== "COMPLETED") continue;
    const sale = salesBySku.get(s.id);
    const fulfilled = sale?.ytdFulfilled ?? 0;
    const unfulfilled = sale?.ytdUnfulfilled ?? 0;
    const programmed = sale?.programmedQty ?? 0;
    const priorComp = sale?.priorQty ?? 0;
    const computedPlanned = Math.round(scenario.globalMultiplier * priorComp);
    const ov = overrideBySku.get(s.id);
    const plannedProjection = ov ? ov.overrideQty : computedPlanned;
    const total2026 = fulfilled + unfulfilled + programmed + plannedProjection;
    completedRows.push({
      skuId: s.id,
      sku: s.sku,
      name: s.name,
      category: s.category ?? "Uncategorized",
      fulfilled,
      unfulfilled,
      programmed,
      computedPlanned,
      plannedProjection,
      isOverridden: !!ov,
      total2026,
    });
    // Roll each bucket down to raws.
    if (fulfilled > 0) explodeInto(rawF, s.id, fulfilled, new Set(), 0);
    if (unfulfilled > 0) explodeInto(rawU, s.id, unfulfilled, new Set(), 0);
    if (programmed > 0) explodeInto(rawP, s.id, programmed, new Set(), 0);
    if (plannedProjection > 0) explodeInto(rawPl, s.id, plannedProjection, new Set(), 0);
  }
  completedRows.sort((a, b) => b.total2026 - a.total2026);

  // ---- Supply: raws embedded in built stock + open POs ----
  const inAssembly = new Map<string, number>();
  for (const s of skus) {
    if (s.type === "ASSEMBLY" || s.type === "COMPLETED") {
      const stock = availQty(s);
      if (stock > 0) explodeInto(inAssembly, s.id, stock, new Set(), 0);
    }
  }
  const onHand = new Map<string, number>();
  for (const r of invRows) {
    if (r.state === "RAW") onHand.set(r.skuId, (onHand.get(r.skuId) ?? 0) + (r._sum.quantity ?? 0));
  }
  const onOrder = new Map<string, number>();
  for (const it of openItems) {
    if (it.purchaseOrder.children.length > 0) continue;
    onOrder.set(it.skuId, (onOrder.get(it.skuId) ?? 0) + Math.max(0, it.quantityOrdered - it.quantityReceived));
  }

  // ---- Top: raw-SKU rows (any raw with demand) ----
  const rawIds = new Set<string>([...rawF.keys(), ...rawU.keys(), ...rawP.keys(), ...rawPl.keys()]);
  const rawRows: RawRow[] = [];
  for (const id of rawIds) {
    const sku = skuById.get(id);
    if (!sku) continue;
    const fulfilled = rawF.get(id) ?? 0;
    const unfulfilled = rawU.get(id) ?? 0;
    const programmed = rawP.get(id) ?? 0;
    const plannedProjection = rawPl.get(id) ?? 0;
    const qtyStillNeeded = unfulfilled + programmed + plannedProjection;
    const oh = onHand.get(id) ?? 0;
    const ia = inAssembly.get(id) ?? 0;
    const oo = onOrder.get(id) ?? 0;
    rawRows.push({
      skuId: id,
      sku: sku.sku,
      name: sku.name,
      partType: partTypeOf(sku.sku, sku.name),
      material: materialOf(sku.sku, sku.name),
      category: sku.category ?? "Uncategorized",
      fulfilled,
      unfulfilled,
      programmed,
      plannedProjection,
      qtyStillNeeded,
      onHand: oh,
      inAssembly: ia,
      onOrder: oo,
      needToOrder: Math.max(0, qtyStillNeeded - oh - ia - oo),
      total2026: fulfilled + unfulfilled + programmed + plannedProjection,
    });
  }
  rawRows.sort((a, b) => b.needToOrder - a.needToOrder);

  const sw = salesWindow(scenario);
  return {
    scenario,
    completedRows,
    rawRows,
    salesStart: ymd(sw.start),
    salesEnd: ymd(sw.end),
    comparisonStart: ymd(new Date(scenario.comparisonStart)),
    comparisonEnd: ymd(new Date(scenario.comparisonEnd)),
  };
}

// Pull DtC sales (split fulfilled/unfulfilled) for the sales window, prior-year
// comparable totals, and programmed orders; cache per SKU.
export async function refreshSales(): Promise<number> {
  const scenario = await getOrCreateScenario();
  const sw = salesWindow(scenario);
  const cmpStart = ymd(new Date(scenario.comparisonStart));
  const cmpEnd = ymd(new Date(scenario.comparisonEnd));
  const horizonStart = ymd(new Date(scenario.horizonStart));
  const horizonEnd = ymd(new Date(scenario.horizonEnd));

  const [ytd, prior, programmed] = await Promise.all([
    getSalesBreakdownBySku(ymd(sw.start), ymd(sw.end)),
    getSalesBySku(cmpStart, cmpEnd),
    fetchProgrammedOrders({ from: horizonStart, to: horizonEnd })
      .then((r) => r.bySku)
      .catch(() => [] as { sku: string; quantity: number }[]),
  ]);

  const ytdN = new Map<string, { fulfilled: number; unfulfilled: number }>();
  for (const [k, v] of ytd) {
    const n = norm(k);
    const e = ytdN.get(n) ?? { fulfilled: 0, unfulfilled: 0 };
    e.fulfilled += v.fulfilled;
    e.unfulfilled += v.unfulfilled;
    ytdN.set(n, e);
  }
  const priorN = new Map<string, number>();
  for (const [k, v] of prior) priorN.set(norm(k), (priorN.get(norm(k)) ?? 0) + v);
  const progN = new Map<string, number>();
  for (const row of programmed) progN.set(norm(row.sku), (progN.get(norm(row.sku)) ?? 0) + row.quantity);

  const skus = await prisma.sku.findMany({
    where: { isActive: true, type: "COMPLETED" },
    select: { id: true, sku: true },
  });
  for (const s of skus) {
    const k = norm(s.sku);
    const ytdv = ytdN.get(k) ?? { fulfilled: 0, unfulfilled: 0 };
    const data = {
      ytdFulfilled: Math.round(ytdv.fulfilled),
      ytdUnfulfilled: Math.round(ytdv.unfulfilled),
      priorQty: Math.round(priorN.get(k) ?? 0),
      programmedQty: Math.round(progN.get(k) ?? 0),
    };
    await prisma.projectionSale.upsert({
      where: { skuId: s.id },
      create: { skuId: s.id, ...data },
      update: data,
    });
  }
  await prisma.forecastScenario.update({ where: { id: scenario.id }, data: { salesRefreshedAt: new Date() } });
  return skus.length;
}
