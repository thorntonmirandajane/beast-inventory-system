// ============================================================================
// Strategy comparison.
//
// A game plan says WHAT to pull off each order. A strategy says WHICH ORDERS
// get the stock, and in what order — which matters just as much when there
// isn't enough to go round.
//
// Every strategy is run against the SAME starting stock, so the results are
// directly comparable: ship the orders that can go out whole first, or chase
// your biggest customers, or simply work oldest to newest, and see what each
// one actually clears.
//
// What a strategy never does is invent stock. Whatever it can't cover is
// reported as the shortfall per SKU — the purchase/build list for clearing
// everything that's left.
// ============================================================================

import { loadUnfulfilledView, type UnfulfilledViewOrder } from "./unfulfilled-view.server";
import { STRATEGIES, type StrategyKind } from "./strategy-kinds";

export type { StrategyKind };
export { STRATEGIES };

export interface StoreSplit {
  ordersFull: number;
  ordersPartial: number;
  units: number;
  value: number;
}

export interface ShortfallRow {
  sku: string;
  title: string;
  stillNeeded: number;
  ordersWaiting: number;
}

export interface StrategyResult {
  kind: StrategyKind;
  label: string;
  blurb: string;
  ordersFull: number;
  ordersPartial: number;
  ordersUntouched: number;
  unitsShipped: number;
  unitsRemaining: number;
  valueShipped: number;
  valueRemaining: number;
  byStore: { beast: StoreSplit; archery: StoreSplit };
  /** What it would take to clear everything this strategy leaves behind. */
  shortfall: ShortfallRow[];
  shortfallUnits: number;
  /** Per-order outcome, newest-first truncation handled by the caller. */
  orders: {
    orderName: string;
    store: string;
    ageDays: number;
    needed: number;
    shipped: number;
    outcome: "FULL" | "PARTIAL" | "NONE";
  }[];
}

const norm = (s: string) => s.trim().toUpperCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
const emptySplit = (): StoreSplit => ({ ordersFull: 0, ordersPartial: 0, units: 0, value: 0 });

/** Can this order be covered in full from what's left? */
function coversFully(order: UnfulfilledViewOrder, pool: Map<string, number>): boolean {
  const need = new Map<string, number>();
  for (const l of order.lines) need.set(norm(l.sku), (need.get(norm(l.sku)) ?? 0) + l.needed);
  for (const [sku, qty] of need) if ((pool.get(sku) ?? 0) < qty) return false;
  return true;
}

/**
 * Take what this order can get from the pool, drawing it down. `shippedBySku`
 * accumulates across the whole run so the shortfall can be worked out as
 * demand minus what actually went out.
 */
function allocate(
  order: UnfulfilledViewOrder,
  pool: Map<string, number>,
  shippedBySku: Map<string, number>
) {
  let units = 0;
  let value = 0;
  for (const l of order.lines) {
    const key = norm(l.sku);
    const left = pool.get(key) ?? 0;
    const take = Math.min(l.needed, left);
    if (take <= 0) continue;
    pool.set(key, left - take);
    shippedBySku.set(key, (shippedBySku.get(key) ?? 0) + take);
    units += take;
    value += (l.unitPrice ?? 0) * take;
  }
  return { units, value: round2(value) };
}

function orderOf(kind: StrategyKind, orders: UnfulfilledViewOrder[], priority: Set<string>) {
  const byAge = [...orders].sort((a, b) => b.ageDays - a.ageDays);
  switch (kind) {
    case "HIGHEST_VALUE_FIRST":
      return [...orders].sort((a, b) => b.unfulfilledValue - a.unfulfilledValue || b.ageDays - a.ageDays);
    case "MOST_ORDERS_CLEARED":
      // Smallest first clears the greatest count from a fixed pool.
      return [...orders].sort((a, b) => a.totalNeeded - b.totalNeeded || b.ageDays - a.ageDays);
    case "CUSTOMERS_FIRST": {
      const isPriority = (o: UnfulfilledViewOrder) => {
        const hay = `${o.company ?? ""} ${o.customerName ?? ""}`.toLowerCase();
        return [...priority].some((p) => p && hay.includes(p));
      };
      return [...byAge].sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)));
    }
    default:
      return byAge;
  }
}

export interface RunStrategyInput {
  kind: StrategyKind;
  location: "GALLATIN" | "UTAH";
  storeFilter?: string;
  /** Names or companies to favour, for CUSTOMERS_FIRST. */
  priorityCustomers?: string[];
  view?: Awaited<ReturnType<typeof loadUnfulfilledView>>;
}

export async function runStrategy(input: RunStrategyInput): Promise<StrategyResult> {
  const view = input.view ?? (await loadUnfulfilledView());
  const meta = STRATEGIES.find((s) => s.kind === input.kind)!;

  let orders = view.orders;
  if (input.storeFilter === "beast" || input.storeFilter === "archery") {
    orders = orders.filter((o) => o.store === input.storeFilter);
  }

  // One pool per run, so every strategy starts from the same shelf.
  const pool = new Map<string, number>();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = norm(l.sku);
      if (pool.has(key)) continue;
      pool.set(key, Math.max(0, (input.location === "UTAH" ? l.utahOnHand : l.gallatinOnHand) ?? 0));
    }
  }

  const priority = new Set((input.priorityCustomers ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const sorted = orderOf(input.kind, orders, priority);

  const shipped = new Map<string, { units: number; value: number }>();
  const shippedBySku = new Map<string, number>();
  const takeOrder = (o: UnfulfilledViewOrder) => {
    const got = allocate(o, pool, shippedBySku);
    if (got.units > 0) shipped.set(`${o.store}:${o.orderId}`, got);
  };

  if (input.kind === "FULL_ONLY") {
    for (const o of sorted) if (coversFully(o, pool)) takeOrder(o);
  } else if (input.kind === "FULL_FIRST_THEN_PARTIAL" || input.kind === "MOST_ORDERS_CLEARED") {
    // Pass 1 — everything that can go out whole.
    const leftovers: UnfulfilledViewOrder[] = [];
    for (const o of sorted) {
      if (coversFully(o, pool)) takeOrder(o);
      else leftovers.push(o);
    }
    // Pass 2 — part-fill the rest with whatever survived, oldest first.
    for (const o of leftovers.sort((a, b) => b.ageDays - a.ageDays)) takeOrder(o);
  } else {
    for (const o of sorted) takeOrder(o);
  }

  // Tally outcomes and what each order still wants.
  const byStore = { beast: emptySplit(), archery: emptySplit() };
  const shortBySku = new Map<string, ShortfallRow>();
  let ordersFull = 0, ordersPartial = 0, ordersUntouched = 0;
  let unitsShipped = 0, valueShipped = 0, unitsRemaining = 0, valueRemaining = 0;
  const detail: StrategyResult["orders"] = [];

  for (const o of orders) {
    const got = shipped.get(`${o.store}:${o.orderId}`) ?? { units: 0, value: 0 };
    const outcome: "FULL" | "PARTIAL" | "NONE" =
      got.units >= o.totalNeeded && o.totalNeeded > 0 ? "FULL" : got.units > 0 ? "PARTIAL" : "NONE";

    if (outcome === "FULL") ordersFull++;
    else if (outcome === "PARTIAL") ordersPartial++;
    else ordersUntouched++;

    unitsShipped += got.units;
    valueShipped += got.value;
    unitsRemaining += o.totalNeeded - got.units;
    valueRemaining += Math.max(0, o.unfulfilledValue - got.value);

    const side = o.store === "beast" ? byStore.beast : byStore.archery;
    if (outcome === "FULL") side.ordersFull++;
    else if (outcome === "PARTIAL") side.ordersPartial++;
    side.units += got.units;
    side.value = round2(side.value + got.value);

    detail.push({
      orderName: o.orderName, store: o.store, ageDays: o.ageDays,
      needed: o.totalNeeded, shipped: got.units, outcome,
    });
  }

  // Shortfall: demand minus what this strategy actually shipped. It has to be
  // measured against what went OUT, not against the pool — by this point the
  // pool has been drawn down, so reading it back reports the whole demand again.
  const demandBySku = new Map<string, { row: ShortfallRow; orders: Set<string> }>();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = norm(l.sku);
      const entry = demandBySku.get(key) ?? {
        row: { sku: l.sku, title: l.title, stillNeeded: 0, ordersWaiting: 0 },
        orders: new Set<string>(),
      };
      entry.row.stillNeeded += l.needed;
      entry.orders.add(`${o.store}:${o.orderId}`);
      demandBySku.set(key, entry);
    }
  }
  for (const [key, entry] of demandBySku) {
    const out = shippedBySku.get(key) ?? 0;
    const missing = entry.row.stillNeeded - out;
    if (missing <= 0) continue;
    shortBySku.set(key, { ...entry.row, stillNeeded: missing, ordersWaiting: entry.orders.size });
  }

  const shortfall = [...shortBySku.values()].sort((a, b) => b.stillNeeded - a.stillNeeded);

  return {
    kind: input.kind,
    label: meta.label,
    blurb: meta.blurb,
    ordersFull, ordersPartial, ordersUntouched,
    unitsShipped, unitsRemaining,
    valueShipped: round2(valueShipped),
    valueRemaining: round2(valueRemaining),
    byStore,
    shortfall,
    shortfallUnits: shortfall.reduce((t, r) => t + r.stillNeeded, 0),
    orders: detail,
  };
}

export async function compareStrategies(input: {
  kinds: StrategyKind[];
  location: "GALLATIN" | "UTAH";
  storeFilter?: string;
  priorityCustomers?: string[];
}): Promise<{ results: StrategyResult[]; totalOrders: number; totalUnits: number; totalValue: number }> {
  // Load the backlog once and hand the same snapshot to every strategy —
  // otherwise they'd each see slightly different stock and wouldn't compare.
  const view = await loadUnfulfilledView();
  const results: StrategyResult[] = [];
  for (const kind of input.kinds) {
    results.push(await runStrategy({ ...input, kind, view }));
  }
  let orders = view.orders;
  if (input.storeFilter === "beast" || input.storeFilter === "archery") {
    orders = orders.filter((o) => o.store === input.storeFilter);
  }
  return {
    results,
    totalOrders: orders.length,
    totalUnits: orders.reduce((t, o) => t + o.totalNeeded, 0),
    totalValue: round2(orders.reduce((t, o) => t + o.unfulfilledValue, 0)),
  };
}
