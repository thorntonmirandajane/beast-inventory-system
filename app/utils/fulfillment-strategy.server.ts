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

export type ShipFrom = "GALLATIN" | "UTAH" | "EITHER";

/** How much of one SKU each warehouse would contribute under a strategy. */
export interface SkuSourceRow {
  sku: string;
  title: string;
  fromGallatin: number;
  fromUtah: number;
  total: number;
  stillShort: number;
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
  /** Per SKU, where the shipped units would come from. */
  bySku: SkuSourceRow[];
  unitsFromGallatin: number;
  unitsFromUtah: number;
  /** Every order in the scenario, in the sequence this strategy would work them. */
  orders: {
    /** 1-based position in the pick list; null for orders never reached. */
    position: number | null;
    orderName: string;
    store: string;
    customer: string;
    ageDays: number;
    needed: number;
    shipped: number;
    fromGallatin: number;
    fromUtah: number;
    /** Which shelf (or shelves) this order draws on. */
    source: "GALLATIN" | "UTAH" | "BOTH" | "NONE";
    value: number;
    outcome: "FULL" | "PARTIAL" | "NONE";
    lines: { sku: string; title: string; needed: number; fromGallatin: number; fromUtah: number }[];
  }[];
}

const norm = (s: string) => s.trim().toUpperCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
const emptySplit = (): StoreSplit => ({ ordersFull: 0, ordersPartial: 0, units: 0, value: 0 });

/** The two shelves a strategy can draw on, and which of them it may use. */
interface Shelves {
  gallatin: Map<string, number>;
  utah: Map<string, number>;
  from: ShipFrom;
}

const available = (sh: Shelves, sku: string) =>
  (sh.from !== "UTAH" ? sh.gallatin.get(sku) ?? 0 : 0) +
  (sh.from !== "GALLATIN" ? sh.utah.get(sku) ?? 0 : 0);

/** Can this order be covered in full from what's left across the allowed shelves? */
function coversFully(order: UnfulfilledViewOrder, sh: Shelves): boolean {
  const need = new Map<string, number>();
  for (const l of order.lines) need.set(norm(l.sku), (need.get(norm(l.sku)) ?? 0) + l.needed);
  for (const [sku, qty] of need) if (available(sh, sku) < qty) return false;
  return true;
}

/**
 * Take what this order can get, drawing the shelves down. Gallatin is used
 * first when both are allowed — it's the fulfilment warehouse, so shipping from
 * there is the normal path and Utah is the top-up.
 *
 * `shippedBySku` accumulates across the whole run, per warehouse, so the
 * shortfall and the source breakdown both come from real allocations rather
 * than from reading a drained pool back.
 */
function allocate(
  order: UnfulfilledViewOrder,
  sh: Shelves,
  shippedBySku: Map<string, { g: number; u: number }>
) {
  let units = 0;
  let value = 0;
  let fromG = 0;
  let fromU = 0;
  const lineDetail: { sku: string; title: string; needed: number; fromGallatin: number; fromUtah: number }[] = [];
  for (const l of order.lines) {
    const key = norm(l.sku);
    let want = l.needed;
    let g = 0;
    let u = 0;

    if (sh.from !== "UTAH" && want > 0) {
      const left = sh.gallatin.get(key) ?? 0;
      g = Math.min(want, left);
      if (g > 0) { sh.gallatin.set(key, left - g); want -= g; }
    }
    if (sh.from !== "GALLATIN" && want > 0) {
      const left = sh.utah.get(key) ?? 0;
      u = Math.min(want, left);
      if (u > 0) { sh.utah.set(key, left - u); want -= u; }
    }

    const take = g + u;
    lineDetail.push({ sku: l.sku, title: l.title, needed: l.needed, fromGallatin: g, fromUtah: u });
    if (take <= 0) continue;
    const rec = shippedBySku.get(key) ?? { g: 0, u: 0 };
    rec.g += g;
    rec.u += u;
    shippedBySku.set(key, rec);
    units += take;
    value += (l.unitPrice ?? 0) * take;
    fromG += g;
    fromU += u;
  }
  return { units, value: round2(value), fromGallatin: fromG, fromUtah: fromU, lines: lineDetail };
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
  location: ShipFrom;
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

  // Fresh shelves per run, so every strategy starts from the same stock.
  const titleBySku = new Map<string, string>();
  const shelves: Shelves = { gallatin: new Map(), utah: new Map(), from: input.location };
  for (const o of orders) {
    for (const l of o.lines) {
      const key = norm(l.sku);
      if (!titleBySku.has(key)) titleBySku.set(key, l.title);
      if (shelves.gallatin.has(key)) continue;
      shelves.gallatin.set(key, Math.max(0, l.gallatinOnHand ?? 0));
      shelves.utah.set(key, Math.max(0, l.utahOnHand ?? 0));
    }
  }

  const priority = new Set((input.priorityCustomers ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const sorted = orderOf(input.kind, orders, priority);

  type Got = ReturnType<typeof allocate>;
  const shipped = new Map<string, Got>();
  const shippedBySku = new Map<string, { g: number; u: number }>();
  // The sequence the strategy actually works the backlog in — this is the pick
  // order, which for the two-pass strategies is not the sort order.
  const walked: UnfulfilledViewOrder[] = [];
  const takeOrder = (o: UnfulfilledViewOrder) => {
    walked.push(o);
    // Recorded even at zero units — the row still expands to show what the
    // order wants and why none of it could be covered.
    shipped.set(`${o.store}:${o.orderId}`, allocate(o, shelves, shippedBySku));
  };

  if (input.kind === "FULL_ONLY") {
    for (const o of sorted) if (coversFully(o, shelves)) takeOrder(o);
  } else if (input.kind === "FULL_FIRST_THEN_PARTIAL" || input.kind === "MOST_ORDERS_CLEARED") {
    // Pass 1 — everything that can go out whole.
    const leftovers: UnfulfilledViewOrder[] = [];
    for (const o of sorted) {
      if (coversFully(o, shelves)) takeOrder(o);
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

  // Walked orders first, in pick sequence; anything the strategy never reached
  // (a FULL_ONLY order that didn't qualify, say) follows in its sort order.
  const walkedKeys = new Set(walked.map((o) => `${o.store}:${o.orderId}`));
  const sequence = [...walked, ...sorted.filter((o) => !walkedKeys.has(`${o.store}:${o.orderId}`))];

  // Two passes: number the orders that actually ship, in pick sequence, then
  // append the ones that get nothing. Interleaving them left holes in the
  // numbering and buried the real pick list.
  const ships = (o: UnfulfilledViewOrder) => (shipped.get(`${o.store}:${o.orderId}`)?.units ?? 0) > 0;
  const ordered = [...sequence.filter(ships), ...sequence.filter((o) => !ships(o))];

  let position = 0;
  for (const o of ordered) {
    const got = shipped.get(`${o.store}:${o.orderId}`) ?? {
      units: 0,
      value: 0,
      fromGallatin: 0,
      fromUtah: 0,
      lines: o.lines.map((l) => ({
        sku: l.sku, title: l.title, needed: l.needed, fromGallatin: 0, fromUtah: 0,
      })),
    };
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

    const source: "GALLATIN" | "UTAH" | "BOTH" | "NONE" =
      got.fromGallatin > 0 && got.fromUtah > 0 ? "BOTH"
      : got.fromGallatin > 0 ? "GALLATIN"
      : got.fromUtah > 0 ? "UTAH"
      : "NONE";

    if (got.units > 0) position += 1;
    detail.push({
      position: got.units > 0 ? position : null,
      orderName: o.orderName,
      store: o.store,
      customer: o.company || o.customerName || "",
      ageDays: o.ageDays,
      needed: o.totalNeeded,
      shipped: got.units,
      fromGallatin: got.fromGallatin,
      fromUtah: got.fromUtah,
      source,
      value: got.value,
      outcome,
      lines: got.lines,
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
  const bySku: SkuSourceRow[] = [];
  let unitsFromGallatin = 0;
  let unitsFromUtah = 0;
  for (const [key, entry] of demandBySku) {
    const src = shippedBySku.get(key) ?? { g: 0, u: 0 };
    const out = src.g + src.u;
    const missing = entry.row.stillNeeded - out;
    unitsFromGallatin += src.g;
    unitsFromUtah += src.u;
    if (out > 0 || missing > 0) {
      bySku.push({
        sku: entry.row.sku,
        title: titleBySku.get(key) ?? entry.row.title,
        fromGallatin: src.g,
        fromUtah: src.u,
        total: out,
        stillShort: Math.max(0, missing),
      });
    }
    if (missing <= 0) continue;
    shortBySku.set(key, { ...entry.row, stillNeeded: missing, ordersWaiting: entry.orders.size });
  }
  bySku.sort((a, b) => b.total - a.total || b.stillShort - a.stillShort || a.sku.localeCompare(b.sku));

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
    bySku,
    unitsFromGallatin,
    unitsFromUtah,
    orders: detail,
  };
}

export async function compareStrategies(input: {
  kinds: StrategyKind[];
  location: ShipFrom;
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

const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every order in the scenario, with where its units come from. */
export function ordersToCsv(result: StrategyResult, scenarioName: string): string {
  const header = [
    "Pick order", "Scenario", "Strategy", "Order", "Store", "Customer", "Waiting (days)",
    "Units needed", "Units shipped", "From Gallatin", "From Utah",
    "Ships from", "Outcome", "Value shipped", "Items",
  ];
  const rows = result.orders.map((o) => [
    o.position ?? "",
    scenarioName,
    result.label,
    o.orderName,
    o.store === "beast" ? "Beast" : "Archery",
    o.customer,
    o.ageDays,
    o.needed,
    o.shipped,
    o.fromGallatin,
    o.fromUtah,
    o.source === "BOTH" ? "Both" : o.source === "NONE" ? "—" : o.source === "UTAH" ? "Utah" : "Gallatin",
    o.outcome === "FULL" ? "Ships complete" : o.outcome === "PARTIAL" ? "Part-fills" : "Nothing available",
    o.value,
    o.lines.filter((l) => l.fromGallatin + l.fromUtah > 0).map((l) => `${l.fromGallatin + l.fromUtah}x ${l.sku}`).join("; "),
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}
