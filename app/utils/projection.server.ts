import prisma from "../db.server";
import { getSalesBySku, getSalesBreakdownBySku } from "./shopify.server";
import { fetchProgrammedOrders } from "./queued-orders-client.server";

const norm = (s: string) => s.trim().toUpperCase();

// Get the single live scenario, creating it with sensible defaults if absent:
// global multiplier 2.0, comparison = prior-year remaining-year (today→Dec 31
// of last year), horizon = today→Dec 31 this year.
export async function getOrCreateScenario() {
  let sc = await prisma.forecastScenario.findFirst({ orderBy: { createdAt: "asc" } });
  if (!sc) {
    const now = new Date();
    const ly = now.getFullYear() - 1;
    sc = await prisma.forecastScenario.create({
      data: {
        globalMultiplier: 2.0,
        comparisonStart: new Date(Date.UTC(ly, now.getMonth(), now.getDate())),
        comparisonEnd: new Date(Date.UTC(ly, 11, 31)),
        horizonStart: now,
        horizonEnd: new Date(Date.UTC(now.getFullYear(), 11, 31)),
      },
    });
  }
  return sc;
}

export interface ProjectionRow {
  skuId: string;
  sku: string;
  name: string;
  fulfilled: number; // YTD shipped
  unfulfilled: number; // YTD placed, not yet shipped
  programmed: number; // future dealer/programmed orders
  priorComp: number; // prior-year comparable units
  multiplier: number;
  plannedProjected: number; // multiplier × priorComp
  formulaTotal: number; // fulfilled + unfulfilled + programmed + plannedProjected
  override: number | null;
  note: string | null;
  final: number;
}
export interface RawAdequacyRow {
  skuId: string;
  sku: string;
  name: string;
  material: string;
  projectedNeed: number;
  onHand: number;
  onOrder: number;
  net: number;
}

// Classify a raw by its SKU/name. COC checked first (a COC ferrule can also
// carry "TI"). Canonical buckets for David's Al / Ti / COC lit test.
function materialOf(sku: string, name: string): string {
  const s = `${sku} ${name}`.toUpperCase();
  if (s.includes("COC")) return "Cut-on-Contact";
  if (/\bTI\b/.test(s) || s.includes("-TI-") || s.startsWith("TI") || s.includes("TITANIUM")) return "Titanium";
  if (/\bAL\b/.test(s) || s.includes("-AL-") || s.startsWith("AL") || s.includes("ALUMINUM")) return "Aluminum";
  if (/\bCB\b/.test(s) || s.includes("CARBON")) return "Carbon";
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

  // Projection rows (completed SKUs). Override always wins over the formula.
  const rows: ProjectionRow[] = [];
  const finalBySku = new Map<string, number>();
  for (const s of skus) {
    if (s.type !== "COMPLETED") continue;
    const sale = salesBySku.get(s.id);
    const fulfilled = sale?.ytdFulfilled ?? 0;
    const unfulfilled = sale?.ytdUnfulfilled ?? 0;
    const programmed = sale?.programmedQty ?? 0;
    const priorComp = sale?.priorQty ?? 0;
    const mult = scenario.globalMultiplier;
    const plannedProjected = Math.round(mult * priorComp);
    const formulaTotal = fulfilled + unfulfilled + programmed + plannedProjected;
    const ov = overrideBySku.get(s.id);
    const override = ov ? ov.overrideQty : null;
    const final = override ?? formulaTotal;
    rows.push({
      skuId: s.id,
      sku: s.sku,
      name: s.name,
      fulfilled,
      unfulfilled,
      programmed,
      priorComp,
      multiplier: mult,
      plannedProjected,
      formulaTotal,
      override,
      note: ov?.note ?? null,
      final,
    });
    if (final > 0) finalBySku.set(s.id, final);
  }
  rows.sort((a, b) => b.final - a.final);

  // Gross-explode final demand down to raws (in-memory, cycle-guarded, depth 10).
  const rawNeed = new Map<string, number>();
  function explode(skuId: string, qty: number, visited: Set<string>, depth: number) {
    if (qty <= 0 || depth > 10 || visited.has(skuId)) return;
    visited.add(skuId);
    const sku = skuById.get(skuId);
    if (!sku) return;
    for (const c of sku.bomComponents) {
      const child = skuById.get(c.componentSkuId);
      if (!child) continue;
      const need = c.quantity * qty;
      if (child.type === "RAW") rawNeed.set(child.id, (rawNeed.get(child.id) ?? 0) + need);
      else explode(child.id, need, new Set(visited), depth + 1);
    }
  }
  for (const [skuId, qty] of finalBySku) explode(skuId, qty, new Set(), 0);

  // On-hand = RAW available state only (not RECEIVED-pending). On-order = open
  // PO remainder, skipping split parents (children carry the real open qty).
  const onHand = new Map<string, number>();
  for (const r of invRows) {
    if (r.state === "RAW") onHand.set(r.skuId, (onHand.get(r.skuId) ?? 0) + (r._sum.quantity ?? 0));
  }
  const onOrder = new Map<string, number>();
  for (const it of openItems) {
    if (it.purchaseOrder.children.length > 0) continue;
    onOrder.set(it.skuId, (onOrder.get(it.skuId) ?? 0) + Math.max(0, it.quantityOrdered - it.quantityReceived));
  }

  const adequacy: RawAdequacyRow[] = [];
  for (const [skuId, need] of rawNeed) {
    const sku = skuById.get(skuId);
    if (!sku) continue;
    const oh = onHand.get(skuId) ?? 0;
    const oo = onOrder.get(skuId) ?? 0;
    adequacy.push({
      skuId,
      sku: sku.sku,
      name: sku.name,
      material: materialOf(sku.sku, sku.name),
      projectedNeed: need,
      onHand: oh,
      onOrder: oo,
      net: oh + oo - need,
    });
  }
  adequacy.sort((a, b) => a.net - b.net);

  const groupMap = new Map<string, { material: string; projectedNeed: number; onHand: number; onOrder: number; net: number }>();
  for (const r of adequacy) {
    const g = groupMap.get(r.material) ?? { material: r.material, projectedNeed: 0, onHand: 0, onOrder: 0, net: 0 };
    g.projectedNeed += r.projectedNeed;
    g.onHand += r.onHand;
    g.onOrder += r.onOrder;
    g.net += r.net;
    groupMap.set(r.material, g);
  }
  const materialGroups = Array.from(groupMap.values()).sort((a, b) => a.net - b.net);

  return { scenario, rows, adequacy, materialGroups };
}

// Pull DtC sales for YTD + the comparison window from Shopify and cache per SKU.
// Returns the count of completed SKUs refreshed.
export async function refreshSales(): Promise<number> {
  const scenario = await getOrCreateScenario();
  const now = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;
  const ytdEnd = now.toISOString().split("T")[0];
  const cmpStart = scenario.comparisonStart.toISOString().split("T")[0];
  const cmpEnd = scenario.comparisonEnd.toISOString().split("T")[0];
  const horizonStart = scenario.horizonStart.toISOString().split("T")[0];
  const horizonEnd = scenario.horizonEnd.toISOString().split("T")[0];

  // YTD split by fulfilled/unfulfilled, prior-year total, and programmed (B2B
  // dealer) orders over the horizon. Programmed degrades to 0 if unavailable.
  const [ytd, prior, programmed] = await Promise.all([
    getSalesBreakdownBySku(ytdStart, ytdEnd),
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
  await prisma.forecastScenario.update({ where: { id: scenario.id }, data: { salesRefreshedAt: now } });
  return skus.length;
}
