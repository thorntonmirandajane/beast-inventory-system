// Operations build plan.
//
// Answers: with current component inventory (plus any expected incoming material
// in a what-if), how much of each completed pack can we build, and what demand
// does it cover? Shared components are finite, so we ALLOCATE them oldest-order
// first: fill unfulfilled orders (by order date), then programmed orders, drawing
// down one shared pool exactly like the forecasting page. "Buildable" respects
// the full BOM — limited by whichever component runs out first at any level.

import prisma from "../db.server";
import { getUnfulfilledLineItems, getGallatinInventory } from "./shopify.server";
import { fetchProgrammedOrders } from "./queued-orders-client.server";

const norm = (s: string) => s.trim().toUpperCase();

type Node = {
  id: string;
  sku: string;
  name: string;
  type: string;
  bom: { componentSkuId: string; quantity: number }[];
};

// Max units of `id` buildable from the pool (on-hand of self + build from
// children), without consuming. RAW/leaf = on-hand only.
function capacity(id: string, pool: Map<string, number>, nodes: Map<string, Node>): number {
  const node = nodes.get(id);
  const onHand = Math.max(0, pool.get(id) ?? 0);
  if (!node || node.bom.length === 0) return onHand;
  let fromChildren = Infinity;
  for (const c of node.bom) {
    if (c.quantity <= 0) continue;
    fromChildren = Math.min(fromChildren, Math.floor(capacity(c.componentSkuId, pool, nodes) / c.quantity));
  }
  return onHand + (isFinite(fromChildren) ? fromChildren : 0);
}

// Consume `n` units of `id` from the pool (assumes n <= capacity): use on-hand
// first, then build the rest from children.
function consume(id: string, n: number, pool: Map<string, number>, nodes: Map<string, Node>): void {
  if (n <= 0) return;
  const node = nodes.get(id);
  const onHand = Math.max(0, pool.get(id) ?? 0);
  const useOnHand = Math.min(n, onHand);
  pool.set(id, onHand - useOnHand);
  const remaining = n - useOnHand;
  if (remaining > 0 && node && node.bom.length > 0) {
    for (const c of node.bom) consume(c.componentSkuId, remaining * c.quantity, pool, nodes);
  }
}

// The raw material that limits building one more unit of `id` (for display).
function bindingRaw(id: string, pool: Map<string, number>, nodes: Map<string, Node>): Node | null {
  const node = nodes.get(id);
  if (!node || node.bom.length === 0) return null;
  let worst: { child: Node; ratio: number } | null = null;
  for (const c of node.bom) {
    if (c.quantity <= 0) continue;
    const child = nodes.get(c.componentSkuId);
    if (!child) continue;
    const ratio = Math.floor(capacity(c.componentSkuId, pool, nodes) / c.quantity);
    if (!worst || ratio < worst.ratio) worst = { child, ratio };
  }
  if (!worst) return null;
  return worst.child.bom.length === 0 ? worst.child : bindingRaw(worst.child.id, pool, nodes) ?? worst.child;
}

export interface BuildPlanRow {
  skuId: string;
  sku: string;
  name: string;
  unfulfilled: number;
  programmed: number;
  stockLocal: number;
  stockGallatin: number;
  coveredFromStock: number;
  built: number;
  short: number;
  bindingSku: string | null;
  bindingName: string | null;
}

export interface BuildPlan {
  rows: BuildPlanRow[];
  totals: { unfulfilled: number; programmed: number; coveredFromStock: number; built: number; short: number };
  unmatchedDemand: { sku: string; qty: number }[];
  componentOptions: { id: string; sku: string; name: string; type: string }[];
}

export interface BuildPlanOpts {
  /** Expected incoming components to add to the pool (what-if), as {skuId, qty}. */
  extra?: { skuId: string; qty: number }[];
  /** Include programmed (future) orders in demand. Default true. */
  includeProgrammed?: boolean;
  /** Programmed-orders window (YYYY-MM-DD). Defaults today → +365d. */
  programmedFrom?: string;
  programmedTo?: string;
}

export async function computeBuildPlan(opts: BuildPlanOpts = {}): Promise<BuildPlan> {
  const extra = opts.extra ?? [];
  const includeProgrammed = opts.includeProgrammed ?? true;
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true, sku: true, name: true, type: true,
      bomComponents: { select: { componentSkuId: true, quantity: true } },
      inventoryItems: { where: { quantity: { not: 0 } }, select: { quantity: true } },
    },
  });

  const nodes = new Map<string, Node>();
  const onHand = new Map<string, number>();
  for (const s of skus) {
    nodes.set(s.id, { id: s.id, sku: s.sku, name: s.name, type: s.type, bom: s.bomComponents });
    onHand.set(s.id, s.inventoryItems.reduce((sum, i) => sum + i.quantity, 0));
  }

  // Build pool: components (RAW + ASSEMBLY) on-hand. Completed on-hand is finished
  // stock (coverage), not a build input, so it stays out of the pool.
  const pool = new Map<string, number>();
  for (const s of skus) pool.set(s.id, s.type === "COMPLETED" ? 0 : Math.max(0, onHand.get(s.id) ?? 0));
  for (const e of extra) pool.set(e.skuId, (pool.get(e.skuId) ?? 0) + Math.max(0, e.qty));

  // Completed-SKU lookup (by normalized SKU + learned aliases).
  const completed = skus.filter((s) => s.type === "COMPLETED");
  const skuIdByKey = new Map<string, string>();
  for (const s of completed) skuIdByKey.set(norm(s.sku), s.id);
  for (const a of await prisma.skuAlias.findMany({ select: { alias: true, skuId: true } })) {
    if (nodes.get(a.skuId)?.type === "COMPLETED") skuIdByKey.set(norm(a.alias), a.skuId);
  }

  // Finished stock available to cover demand: local completed + Gallatin.
  const ymd = (d: Date) => d.toISOString().split("T")[0];
  const progFrom = opts.programmedFrom || ymd(new Date());
  const progTo = opts.programmedTo || ymd(new Date(Date.now() + 365 * 86400000));
  const [unfulfilledR, programmedR, gallatinR] = await Promise.allSettled([
    getUnfulfilledLineItems(),
    includeProgrammed
      ? fetchProgrammedOrders({ from: progFrom, to: progTo }).then((r) => r.bySku).catch(() => [] as { sku: string; quantity: number }[])
      : Promise.resolve([] as { sku: string; quantity: number }[]),
    getGallatinInventory().catch(() => new Map<string, number>()),
  ]);
  const unfulfilled = unfulfilledR.status === "fulfilled" ? unfulfilledR.value : [];
  const programmed = programmedR.status === "fulfilled" ? programmedR.value : [];
  const gallatin = gallatinR.status === "fulfilled" ? gallatinR.value : new Map<string, number>();

  const gallatinByKey = new Map<string, number>();
  for (const [s, q] of gallatin) gallatinByKey.set(norm(s), (gallatinByKey.get(norm(s)) ?? 0) + q);

  const rows = new Map<string, BuildPlanRow>();
  const row = (skuId: string): BuildPlanRow => {
    let r = rows.get(skuId);
    if (!r) {
      const n = nodes.get(skuId)!;
      r = {
        skuId, sku: n.sku, name: n.name,
        unfulfilled: 0, programmed: 0,
        stockLocal: Math.max(0, onHand.get(skuId) ?? 0),
        stockGallatin: Math.max(0, gallatinByKey.get(norm(n.sku)) ?? 0),
        coveredFromStock: 0, built: 0, short: 0, bindingSku: null, bindingName: null,
      };
      rows.set(skuId, r);
    }
    return r;
  };

  // Finished stock ledger (local + Gallatin), drawn down as we cover demand.
  const finished = new Map<string, number>();
  for (const s of completed) finished.set(s.id, (onHand.get(s.id) ?? 0) + (gallatinByKey.get(norm(s.sku)) ?? 0));

  const unmatched = new Map<string, number>();

  // Demand queue: unfulfilled oldest-first, then programmed.
  type Demand = { skuId: string; qty: number; kind: "unfulfilled" | "programmed" };
  const queue: Demand[] = [];
  const sortedUnfulfilled = [...unfulfilled].sort(
    (a, b) => new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime()
  );
  for (const it of sortedUnfulfilled) {
    const skuId = skuIdByKey.get(norm(it.sku));
    if (!skuId) {
      unmatched.set(it.sku, (unmatched.get(it.sku) ?? 0) + it.quantity);
      continue;
    }
    row(skuId).unfulfilled += it.quantity;
    queue.push({ skuId, qty: it.quantity, kind: "unfulfilled" });
  }
  for (const p of programmed) {
    const skuId = skuIdByKey.get(norm(p.sku));
    if (!skuId) {
      unmatched.set(p.sku, (unmatched.get(p.sku) ?? 0) + p.quantity);
      continue;
    }
    row(skuId).programmed += p.quantity;
    queue.push({ skuId, qty: p.quantity, kind: "programmed" });
  }

  // Allocate in priority order: cover from finished stock, then build.
  for (const d of queue) {
    const r = row(d.skuId);
    let need = d.qty;

    const fin = finished.get(d.skuId) ?? 0;
    const fromStock = Math.min(need, fin);
    finished.set(d.skuId, fin - fromStock);
    r.coveredFromStock += fromStock;
    need -= fromStock;

    if (need > 0) {
      const canBuild = Math.min(need, capacity(d.skuId, pool, nodes));
      if (canBuild > 0) {
        consume(d.skuId, canBuild, pool, nodes);
        r.built += canBuild;
        need -= canBuild;
      }
      if (need > 0 && !r.bindingSku) {
        const b = bindingRaw(d.skuId, pool, nodes);
        if (b) {
          r.bindingSku = b.sku;
          r.bindingName = b.name;
        }
      }
    }
    r.short += need;
  }

  const allRows = [...rows.values()].sort((a, b) => b.short - a.short || b.unfulfilled - a.unfulfilled || a.sku.localeCompare(b.sku));
  const totals = allRows.reduce(
    (t, r) => ({
      unfulfilled: t.unfulfilled + r.unfulfilled,
      programmed: t.programmed + r.programmed,
      coveredFromStock: t.coveredFromStock + r.coveredFromStock,
      built: t.built + r.built,
      short: t.short + r.short,
    }),
    { unfulfilled: 0, programmed: 0, coveredFromStock: 0, built: 0, short: 0 }
  );

  const componentOptions = skus
    .filter((s) => s.type === "RAW" || s.type === "ASSEMBLY")
    .map((s) => ({ id: s.id, sku: s.sku, name: s.name, type: s.type }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  return {
    rows: allRows,
    totals,
    unmatchedDemand: [...unmatched.entries()].map(([sku, qty]) => ({ sku, qty })).sort((a, b) => b.qty - a.qty),
    componentOptions,
  };
}
