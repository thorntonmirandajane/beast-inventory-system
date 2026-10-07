// ============================================================================
// Unfulfilled Orders view.
//
// Mirrors the Wholesale > Unfulfilled tab in the Bowmar Archery brain: every
// open order that still has shippable units, how long it has been waiting, and
// what could actually go out the door today.
//
// Two differences from that tab, both deliberate:
//   1. It covers BOTH Shopify stores (Bowmar Archery and Beast Broadhead), and
//      says so when one of them isn't configured instead of quietly showing
//      half the picture.
//   2. It answers the shipping question for BOTH warehouses side by side —
//      Gallatin (ShipHero Apex) and the Utah floor — because an order Gallatin
//      can't cover may still be shippable in house.
//
// Stock is allocated OLDEST-ORDER-FIRST, separately per warehouse: an order's
// "fulfillable" figure is what's left after every older order has taken its
// share. Without that, the same unit gets promised to several orders at once
// and every order looks shippable.
// ============================================================================

import prisma from "../db.server";
import { getUnfulfilledOrders, type StoreSource } from "./shopify.server";
import { getOnHandForSkus } from "./shiphero.server";
import { loadSkuMap } from "./sku-mapping.server";

export type ShipStatus = "FULL" | "PARTIAL" | "NONE";

export interface UnfulfilledViewLine {
  /** The inventory SKU this line resolves to (or the raw Shopify code if none). */
  sku: string;
  /** What Shopify actually had on the line, when the two differ. */
  shopifySku?: string;
  title: string;
  needed: number;
  unitPrice: number;
  lineValue: number;
  gallatinOnHand: number | null;
  gallatinFulfillable: number;
  utahOnHand: number | null;
  utahFulfillable: number;
  /** false when this Shopify SKU doesn't correspond to any inventory SKU. */
  known: boolean;
}

export interface UnfulfilledViewOrder {
  orderId: string;
  orderName: string;
  store: StoreSource;
  createdAt: string;
  ageDays: number;
  customerName: string;
  company: string | null;
  totalNeeded: number;
  /** Value of what's still unshipped on this order. */
  unfulfilledValue: number;
  currency: string | null;
  gallatinFulfillable: number;
  utahFulfillable: number;
  /** Best single warehouse — an order split across both isn't one shipment. */
  bestFulfillable: number;
  gallatinStatus: ShipStatus;
  utahStatus: ShipStatus;
  status: ShipStatus;
  lines: UnfulfilledViewLine[];
}

export interface UnfulfilledSkuRow {
  sku: string;
  title: string;
  beastUnits: number;
  archeryUnits: number;
  totalUnits: number;
  totalValue: number;
  gallatinOnHand: number | null;
  gallatinFulfillable: number;
  utahOnHand: number | null;
  utahFulfillable: number;
  orderCount: number;
  oldestAgeDays: number;
  known: boolean;
}

/** A Shopify SKU that was left out, and why. */
export interface SkippedSku {
  shopifySku: string;
  reason: "ORDER_DEFENSE" | "EXCLUDED" | "UNMAPPED";
  note: string | null;
  units: number;
  orders: number;
}

export interface UnfulfilledView {
  generatedAt: string;
  orders: UnfulfilledViewOrder[];
  bySku: UnfulfilledSkuRow[];
  totals: {
    orders: number;
    units: number;
    value: number;
    canShipGallatin: number;
    canShipUtah: number;
    canShipEither: number;
    partial: number;
    blocked: number;
    longestWaitDays: number;
    beastOrders: number;
    archeryOrders: number;
  };
  stores: { archery: StoreState; beast: StoreState };
  problems: string[];
  /** Lines deliberately left out of the numbers above. */
  skipped: SkippedSku[];
  mapping: { aliases: number; patterns: number; exclusions: number; remappedLines: number };
}

export interface StoreState {
  configured: boolean;
  orders: number;
  units: number;
  note: string | null;
}

const norm = (s: string) => s.trim().toUpperCase();
const normSku = norm;
const statusOf = (needed: number, got: number): ShipStatus =>
  needed > 0 && got >= needed ? "FULL" : got > 0 ? "PARTIAL" : "NONE";

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; value: UnfulfilledView } | null = null;

export function clearUnfulfilledViewCache() {
  cache = null;
}

export async function loadUnfulfilledView(
  opts: { force?: boolean } = {}
): Promise<UnfulfilledView> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await build();
  cache = { at: Date.now(), value };
  return value;
}

async function build(): Promise<UnfulfilledView> {
  const problems: string[] = [];

  // A store with no credentials returns nothing rather than failing, so check
  // configuration separately — otherwise "no Beast orders" and "Beast isn't
  // hooked up" look identical on screen.
  const stores = {
    archery: {
      configured: !!(process.env.ARCHERY_SHOPIFY_STORE && process.env.ARCHERY_SHOPIFY_TOKEN),
      orders: 0, units: 0, note: null as string | null,
    },
    beast: {
      configured: !!(process.env.BEAST_SHOPIFY_STORE && process.env.BEAST_SHOPIFY_TOKEN),
      orders: 0, units: 0, note: null as string | null,
    },
  };
  if (!stores.archery.configured) {
    stores.archery.note = "Not configured — set ARCHERY_SHOPIFY_STORE and ARCHERY_SHOPIFY_TOKEN.";
    problems.push("Bowmar Archery store isn't configured, so its orders are missing from these numbers.");
  }
  if (!stores.beast.configured) {
    stores.beast.note = "Not configured — set BEAST_SHOPIFY_STORE and BEAST_SHOPIFY_TOKEN.";
    problems.push("Beast Broadhead store isn't configured, so its orders are missing from these numbers.");
  }

  let raw: Awaited<ReturnType<typeof getUnfulfilledOrders>> = [];
  try {
    raw = await getUnfulfilledOrders();
  } catch (err) {
    problems.push(`Could not load Shopify orders: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Oldest first — the allocation below depends on this order.
  raw = [...raw].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Resolve Shopify codes to inventory SKUs up front, and drop the lines that
  // shouldn't count at all (Order Defense, anything explicitly excluded).
  // Without this the store's spelling of a practice tip never matches stock and
  // every plan built on these numbers is wrong.
  const skuMap = await loadSkuMap();
  const skippedMap = new Map<string, SkippedSku>();
  let remappedLines = 0;
  const noteSkip = (shopifySku: string, reason: SkippedSku["reason"], note: string | null, units: number, orderKey: string) => {
    const k = `${reason}|${normSku(shopifySku)}`;
    const row = skippedMap.get(k) ?? { shopifySku, reason, note, units: 0, orders: 0 };
    row.units += units;
    row.orders += 1;
    skippedMap.set(k, row);
  };

  raw = raw.map((o) => {
    const lineItems = [];
    for (const li of o.lineItems) {
      const res = skuMap.resolve(li.sku);
      if (res.skip) {
        noteSkip(li.sku, res.skip, res.excludedReason ?? null, li.quantity, o.orderId);
        continue;
      }
      if (!res.sku) {
        noteSkip(li.sku, "UNMAPPED", null, li.quantity, o.orderId);
        continue;
      }
      if (res.remapped) remappedLines += 1;
      lineItems.push({
        ...li,
        sku: res.sku,
        shopifySku: res.remapped ? li.sku : undefined,
        title: li.title || res.name || res.sku,
      });
    }
    const unfulfilledValue = Math.round(lineItems.reduce((t, l) => t + (l.lineValue ?? 0), 0) * 100) / 100;
    return { ...o, lineItems, unfulfilledValue };
  }).filter((o) => o.lineItems.length > 0);

  const wantedSkus = [...new Set(raw.flatMap((o) => o.lineItems.map((l) => norm(l.sku))).filter(Boolean))];

  // Utah floor: this system's own count of finished goods ready to pack.
  const utahOnHand = new Map<string, number>();
  const knownSkus = new Set<string>();
  if (wantedSkus.length) {
    const rows = await prisma.sku.findMany({
      where: { isActive: true },
      select: { sku: true, type: true, inventoryItems: { select: { state: true, quantity: true } } },
    });
    for (const r of rows) {
      const key = norm(r.sku);
      knownSkus.add(key);
      const own = r.type === "RAW" ? "RAW" : r.type === "ASSEMBLY" ? "ASSEMBLED" : "COMPLETED";
      const qty = r.inventoryItems.filter((i) => i.state === own).reduce((t, i) => t + i.quantity, 0);
      utahOnHand.set(key, Math.max(0, qty));
    }
  }

  // Gallatin: live on-hand from ShipHero, for just these SKUs.
  const gallatinOnHand = new Map<string, number>();
  if (wantedSkus.length) {
    try {
      const live = await getOnHandForSkus(wantedSkus);
      for (const [s, q] of live) gallatinOnHand.set(norm(s), Math.max(0, q));
    } catch (err) {
      problems.push(`Gallatin on-hand unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return assemble({
    raw, gallatinOnHand, utahOnHand, knownSkus, stores, problems,
    skipped: [...skippedMap.values()].sort((a, b) => b.units - a.units),
    mapping: { ...skuMap.summary, remappedLines },
  });
}

/**
 * The allocation itself — no IO, so it can be exercised directly.
 *
 * Orders must arrive oldest-first; each one draws from what the older orders
 * left behind, per warehouse.
 */
export function assemble(input: {
  raw: Awaited<ReturnType<typeof getUnfulfilledOrders>>;
  gallatinOnHand: Map<string, number>;
  utahOnHand: Map<string, number>;
  knownSkus: Set<string>;
  stores: { archery: StoreState; beast: StoreState };
  problems: string[];
  skipped?: SkippedSku[];
  mapping?: UnfulfilledView["mapping"];
}): UnfulfilledView {
  const { raw, gallatinOnHand, utahOnHand, knownSkus, stores, problems } = input;

  // Separate pools per warehouse — a unit in Gallatin isn't a unit in Utah.
  const gallatinLeft = new Map(gallatinOnHand);
  const utahLeft = new Map(utahOnHand);

  const now = Date.now();
  const skuAgg = new Map<string, UnfulfilledSkuRow & { orders: Set<string> }>();
  const orders: UnfulfilledViewOrder[] = [];

  for (const o of raw) {
    const lines: UnfulfilledViewLine[] = [];
    let totalNeeded = 0;
    let gTotal = 0;
    let uTotal = 0;
    const ageDays = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / 86400000));

    for (const li of o.lineItems) {
      const key = norm(li.sku);
      if (!key || li.quantity <= 0) continue;
      totalNeeded += li.quantity;

      const gPool = gallatinLeft.get(key) ?? 0;
      const gTake = Math.min(li.quantity, gPool);
      gallatinLeft.set(key, gPool - gTake);
      gTotal += gTake;

      const uPool = utahLeft.get(key) ?? 0;
      const uTake = Math.min(li.quantity, uPool);
      utahLeft.set(key, uPool - uTake);
      uTotal += uTake;

      const known = knownSkus.has(key);
      lines.push({
        sku: li.sku,
        title: li.title,
        needed: li.quantity,
        shopifySku: (li as { shopifySku?: string }).shopifySku,
        unitPrice: li.unitPrice ?? 0,
        lineValue: li.lineValue ?? 0,
        gallatinOnHand: gallatinOnHand.has(key) ? gallatinOnHand.get(key)! : null,
        gallatinFulfillable: gTake,
        utahOnHand: known ? utahOnHand.get(key) ?? 0 : null,
        utahFulfillable: uTake,
        known,
      });

      const agg = skuAgg.get(key) ?? {
        sku: li.sku, title: li.title,
        beastUnits: 0, archeryUnits: 0, totalUnits: 0, totalValue: 0,
        gallatinOnHand: gallatinOnHand.has(key) ? gallatinOnHand.get(key)! : null,
        gallatinFulfillable: 0,
        utahOnHand: known ? utahOnHand.get(key) ?? 0 : null,
        utahFulfillable: 0,
        orderCount: 0, oldestAgeDays: 0, known,
        orders: new Set<string>(),
      };
      agg.totalUnits += li.quantity;
      agg.totalValue = Math.round((agg.totalValue + (li.lineValue ?? 0)) * 100) / 100;
      if (o.source === "beast") agg.beastUnits += li.quantity;
      else agg.archeryUnits += li.quantity;
      agg.gallatinFulfillable += gTake;
      agg.utahFulfillable += uTake;
      agg.oldestAgeDays = Math.max(agg.oldestAgeDays, ageDays);
      agg.orders.add(`${o.source}:${o.orderId}`);
      skuAgg.set(key, agg);
    }

    if (lines.length === 0) continue;

    const side = o.source === "beast" ? stores.beast : stores.archery;
    side.orders += 1;
    side.units += totalNeeded;

    // The headline status is the better single warehouse: splitting an order
    // across both isn't one shipment, so "can ship" has to mean one of them
    // covers it on its own.
    const best = Math.max(gTotal, uTotal);
    orders.push({
      orderId: o.orderId,
      orderName: o.orderName,
      store: o.source,
      createdAt: o.createdAt,
      ageDays,
      customerName: o.customerName,
      company: o.company,
      totalNeeded,
      unfulfilledValue: o.unfulfilledValue ?? 0,
      currency: o.currency ?? null,
      gallatinFulfillable: gTotal,
      utahFulfillable: uTotal,
      bestFulfillable: best,
      gallatinStatus: statusOf(totalNeeded, gTotal),
      utahStatus: statusOf(totalNeeded, uTotal),
      status: statusOf(totalNeeded, best),
      lines,
    });
  }

  const bySku = [...skuAgg.values()]
    .map(({ orders: set, ...row }) => ({ ...row, orderCount: set.size }))
    .sort((a, b) => b.totalUnits - a.totalUnits || a.sku.localeCompare(b.sku));

  return {
    generatedAt: new Date().toISOString(),
    orders,
    bySku,
    totals: {
      orders: orders.length,
      units: orders.reduce((t, o) => t + o.totalNeeded, 0),
      value: Math.round(orders.reduce((t, o) => t + o.unfulfilledValue, 0) * 100) / 100,
      canShipGallatin: orders.filter((o) => o.gallatinStatus === "FULL").length,
      canShipUtah: orders.filter((o) => o.utahStatus === "FULL").length,
      canShipEither: orders.filter((o) => o.status === "FULL").length,
      partial: orders.filter((o) => o.status === "PARTIAL").length,
      blocked: orders.filter((o) => o.status === "NONE").length,
      longestWaitDays: orders.reduce((m, o) => Math.max(m, o.ageDays), 0),
      beastOrders: stores.beast.orders,
      archeryOrders: stores.archery.orders,
    },
    stores,
    problems,
    skipped: input.skipped ?? [],
    mapping: input.mapping ?? { aliases: 0, patterns: 0, exclusions: 0, remappedLines: 0 },
  };
}
