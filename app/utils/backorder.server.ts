// Backorder allocation & production planning.
//
// When open demand across both Shopify stores exceeds completed inventory at
// STG + Gallatin for any build-plan SKU, we're "backordered". This module:
//   1. pulls unfulfilled orders (read-only) from both stores,
//   2. maps Shopify SKUs -> inventory SKUs (exact + wildcard aliases),
//   3. scopes to build-plan (COMPLETED) SKUs,
//   4. allocates STG completed stock to the gap Gallatin can't cover,
//      oldest-order-first, via a pluggable rules engine (Phase 1 = one rule),
//   5. produces the dashboard outputs: STG tag list, explanation sheet,
//      shortfall reports, exceptions, reconciliation, ETAs, and a build plan.
//
// READ-ONLY: nothing here tags/edits/fulfills Shopify. All outputs are data.

import prisma from "../db.server";
import { getUnfulfilledOrders, type UnfulfilledOrder } from "./shopify.server";
import { getOnHandForSkus } from "./shiphero.server";
import { computeBuildPlan, type BuildPlan } from "./operations.server";

const norm = (s: string) => s.trim().toUpperCase();

// OrderDefense shipping-protection lines are not physical goods.
const isOrderDefenseSku = (sku: string) => /^OD\d*$/i.test(sku.trim());

// ============================================================
// SKU mapping (exact + wildcard patterns), reusing SkuAlias
// ============================================================

interface Mapping {
  exact: Map<string, string>; // normalized alias -> inventory skuId
  // Rewrite rules: match `regex`, substitute captured wildcard(s) into
  // `replacement`, then resolve the resulting SKU string to an inventory SKU.
  patterns: { regex: RegExp; replacement: string; raw: string }[];
}

// Turn a wildcard alias like "MG-*-BEAST" into a case-insensitive regex with one
// capture group per "*".
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(.*)");
  return new RegExp(`^${escaped}$`, "i");
}

// Substitute captured groups into a "to" template ("TRUMP-*") in order.
function applyReplacement(replacement: string, groups: string[]): string {
  let i = 0;
  return replacement.replace(/\*/g, () => groups[i++] ?? "");
}

async function loadMapping(): Promise<Mapping> {
  const aliases = await prisma.skuAlias.findMany({
    select: { alias: true, skuId: true, isPattern: true, replacement: true },
  });
  const exact = new Map<string, string>();
  const patterns: Mapping["patterns"] = [];
  for (const a of aliases) {
    if (a.isPattern && a.replacement) {
      patterns.push({ regex: patternToRegex(a.alias), replacement: a.replacement, raw: a.alias });
    } else if (!a.isPattern && a.skuId) {
      exact.set(norm(a.alias), a.skuId);
    }
  }
  return { exact, patterns };
}

// Resolve any Shopify/ShipHero SKU to an inventory skuId. Order: exact alias ->
// direct match to a known inventory SKU -> wildcard rewrite rule. Returns null
// if nothing matches (caller decides: unmapped exception).
function resolveSku(
  raw: string,
  mapping: Mapping,
  skuIdBySku: Map<string, string>
): string | null {
  const key = norm(raw);
  const exact = mapping.exact.get(key);
  if (exact) return exact;
  const direct = skuIdBySku.get(key);
  if (direct) return direct;
  for (const p of mapping.patterns) {
    const m = p.regex.exec(raw.trim());
    if (m) {
      const candidate = applyReplacement(p.replacement, m.slice(1));
      const id = skuIdBySku.get(norm(candidate));
      if (id) return id;
    }
  }
  return null;
}

// ============================================================
// Origin date (oldest-first ordering)
// ============================================================
//
// Prefer a per-order origin date (for re-created / edited orders) when present,
// else fall back to Shopify createdAt. The origin-date source isn't finalized
// yet, so for now we read an "origin:YYYY-MM-DD" order tag if one exists. When
// the real field (metafield/tag) is confirmed, update ONLY this function.
function orderOriginDate(order: UnfulfilledOrder): string {
  for (const tag of order.tags) {
    const m = /^origin[:=]\s*(\d{4}-\d{2}-\d{2})/i.exec(tag.trim());
    if (m) return `${m[1]}T12:00:00`;
  }
  return order.createdAt;
}

// ============================================================
// Allocation rules engine (Phase 1: one rule)
// ============================================================
//
// A rule decides, for one order line, how many units STG ships. Phase 2 will
// add tiered/situational rules; the engine runs rules in order and the first to
// return a decision wins. Phase 1 has a single gap-coverage rule.

export interface LineContext {
  invSkuId: string;
  need: number; // units still needed on this line after Gallatin coverage
  stgRemaining: number; // STG completed units left for this SKU
  order: ScopedOrder;
}

export interface AllocationRule {
  name: string;
  // Returns units STG should ship for this line (0..need), or null to defer to
  // the next rule.
  decide(ctx: LineContext): number | null;
}

// Phase 1: STG covers only the gap Gallatin couldn't, limited by STG stock,
// as much as available. (Gallatin is drawn down before this runs.)
const gapCoverageRule: AllocationRule = {
  name: "gap-coverage-oldest-first",
  decide: (ctx) => Math.min(ctx.need, ctx.stgRemaining),
};

const PHASE1_RULES: AllocationRule[] = [gapCoverageRule];

function runRules(ctx: LineContext, rules: AllocationRule[]): number {
  for (const rule of rules) {
    const d = rule.decide(ctx);
    if (d != null) return Math.max(0, Math.min(ctx.need, d));
  }
  return 0;
}

// ============================================================
// Types
// ============================================================

interface ScopedLine {
  shopifySku: string;
  invSkuId: string;
  invSku: string;
  invName: string;
  qty: number;
}

interface ScopedOrder {
  orderId: string;
  orderName: string;
  source: string;
  originDate: string;
  createdAt: string;
  customerName: string;
  company: string | null;
  email: string | null;
  shippingState: string | null;
  tags: string[];
  lines: ScopedLine[];
}

export interface TagListRow {
  orderName: string;
  store: string;
  customer: string; // company or customer name
  existingTags: string[];
  tagsToApply: string[];
  ships: { shopifySku: string; invSku: string; qty: number }[];
  partial: boolean;
}

export interface ShortfallSkuRow {
  invSku: string;
  name: string;
  demand: number;
  available: number; // STG + Gallatin completed
  stgCompleted: number;
  gallatinCompleted: number;
  short: number;
}

export interface ShortfallOrderRow {
  orderName: string;
  store: string;
  who: string; // company, else customer name
  email: string | null;
  invSku: string;
  shopifySku: string;
  qtyShort: number;
  orderDate: string;
}

export interface OrderLineEta {
  orderName: string;
  store: string;
  who: string;
  email: string | null;
  invSku: string;
  shopifySku: string;
  qty: number;
  materialsReady: string | null; // ISO date all materials on hand, or null
  shipDate: string | null; // materialsReady + N business days
  gating: string; // component/PO description, or "No ETA — materials not on order"
}

export interface ReconRow {
  invSku: string;
  demand: number;
  gallatinCovered: number;
  stgAllocated: number;
  short: number;
  balances: boolean;
}

export interface BackorderExceptions {
  unmapped: { shopifySku: string; qty: number; orders: string[] }[];
  excluded: { sku: string; reason: string | null; demand: number; orders: string[] }[];
  dataProblems: string[];
}

export interface BackorderSnapshot {
  generatedAt: string;
  backorder: boolean;
  dataHealth: { archeryOk: boolean; beastOk: boolean; shipheroOk: boolean };
  etaBusinessDays: number;
  tagList: TagListRow[];
  shortfallBySku: ShortfallSkuRow[];
  shortfallByOrder: ShortfallOrderRow[];
  exceptions: BackorderExceptions;
  reconciliation: ReconRow[];
  etas: OrderLineEta[];
  buildPlan: BuildPlan;
  poMatches: { poNumber: string; componentSku: string; componentName: string; incoming: number; eta: string | null }[];
}

// ============================================================
// Business-day helper
// ============================================================

function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

// ============================================================
// Config
// ============================================================

export async function getBackorderConfig(): Promise<{ etaBusinessDays: number }> {
  const cfg = await prisma.backorderConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
    select: { etaBusinessDays: true },
  });
  return cfg;
}

// ============================================================
// Seed the four known mappings (idempotent)
// ============================================================

export async function seedBackorderMappings(): Promise<void> {
  // Exact pairs (Shopify alias -> inventory sku), resolved by SKU string.
  const exactPairs: [string, string][] = [
    ["3PACK-PT-100G", "PT-3PACK-100G"],
    ["3PACK-PT-125G", "PT-3PACK-125G"],
    ["ST-3PACK-150G-2.0IN", "3PACK-150g-2.0in"],
  ];
  // Wildcard rewrite rules (from-pattern -> to-template). The "*" captured from
  // the Shopify SKU is substituted into the template, then resolved to whatever
  // inventory SKU matches.
  const patternPairs: [string, string][] = [
    ["TR-*", "TRUMP-*"],
    ["MG-*-BEAST", "MG-3PACK-*"],
  ];

  const skus = await prisma.sku.findMany({ select: { id: true, sku: true } });
  const idBySku = new Map(skus.map((s) => [norm(s.sku), s.id]));

  for (const [alias, invSku] of exactPairs) {
    const skuId = idBySku.get(norm(invSku));
    if (!skuId) continue;
    await prisma.skuAlias.upsert({
      where: { alias },
      create: { alias, skuId, isPattern: false },
      update: { skuId, isPattern: false, replacement: null },
    });
  }
  for (const [alias, replacement] of patternPairs) {
    await prisma.skuAlias.upsert({
      where: { alias },
      create: { alias, isPattern: true, replacement },
      update: { isPattern: true, replacement, skuId: null },
    });
  }
}

// ============================================================
// Core computation
// ============================================================

export async function computeBackorder(): Promise<BackorderSnapshot> {
  const dataHealth = { archeryOk: true, beastOk: true, shipheroOk: true };
  const dataProblems: string[] = [];

  const cfg = await getBackorderConfig();
  const etaBusinessDays = cfg.etaBusinessDays;

  // --- Load inventory SKUs, BOMs, completed stock (STG) ---
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
      bomComponents: { select: { componentSkuId: true, quantity: true } },
      inventoryItems: { select: { quantity: true, state: true } },
    },
  });
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const skuIdBySku = new Map(skus.map((s) => [norm(s.sku), s.id]));
  const isBuildPlan = (id: string) => skuById.get(id)?.type === "COMPLETED";

  // STG completed stock = in-house DB COMPLETED-state inventory (Gallatin isn't
  // stored in the DB; it's the live ShipHero feed below).
  const stgCompleted = new Map<string, number>();
  for (const s of skus) {
    if (s.type !== "COMPLETED") continue;
    const qty = s.inventoryItems
      .filter((i) => i.state === "COMPLETED")
      .reduce((sum, i) => sum + i.quantity, 0);
    stgCompleted.set(s.id, Math.max(0, qty));
  }

  const mapping = await loadMapping();

  // --- Load exclusions ---
  const exclusions = await prisma.backorderExclusion.findMany({
    select: { sku: true, reason: true },
  });
  const excludedSet = new Set(exclusions.map((e) => norm(e.sku)));
  const exclusionReason = new Map(exclusions.map((e) => [norm(e.sku), e.reason]));

  // --- Pull unfulfilled orders (read-only) ---
  let rawOrders: UnfulfilledOrder[] = [];
  try {
    rawOrders = await getUnfulfilledOrders();
  } catch (err) {
    dataHealth.archeryOk = false;
    dataHealth.beastOk = false;
    dataProblems.push(
      `Could not load Shopify orders: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // --- Scope orders to build-plan lines; bucket unmapped / excluded ---
  const unmapped = new Map<string, { qty: number; orders: Set<string> }>();
  const excludedHits = new Map<string, { demand: number; orders: Set<string> }>();
  const scoped: ScopedOrder[] = [];
  const demandBySku = new Map<string, number>(); // invSkuId -> total in-scope demand

  for (const o of rawOrders) {
    const lines: ScopedLine[] = [];
    for (const li of o.lineItems) {
      const sku = li.sku.trim();
      if (!sku || isOrderDefenseSku(sku)) continue;

      if (excludedSet.has(norm(sku))) {
        const hit = excludedHits.get(norm(sku)) ?? { demand: 0, orders: new Set<string>() };
        hit.demand += li.quantity;
        hit.orders.add(o.orderName);
        excludedHits.set(norm(sku), hit);
        continue;
      }

      const invSkuId = resolveSku(sku, mapping, skuIdBySku);
      if (!invSkuId) {
        const hit = unmapped.get(sku) ?? { qty: 0, orders: new Set<string>() };
        hit.qty += li.quantity;
        hit.orders.add(o.orderName);
        unmapped.set(sku, hit);
        continue;
      }
      // Mapped but not a build-plan SKU => intentionally out of scope (archery-
      // only items etc.). Silently ignored per spec (not an accidental drop).
      if (!isBuildPlan(invSkuId)) continue;

      const inv = skuById.get(invSkuId)!;
      lines.push({ shopifySku: sku, invSkuId, invSku: inv.sku, invName: inv.name, qty: li.quantity });
      demandBySku.set(invSkuId, (demandBySku.get(invSkuId) ?? 0) + li.quantity);
    }
    if (lines.length === 0) continue;
    scoped.push({
      orderId: o.orderId,
      orderName: o.orderName,
      source: o.source,
      originDate: orderOriginDate(o),
      createdAt: o.createdAt,
      customerName: o.customerName,
      company: o.company,
      email: o.email,
      shippingState: o.shippingState,
      tags: o.tags,
      lines,
    });
  }

  // --- Gallatin completed stock (ShipHero Apex), attributed to inventory SKUs ---
  const gallatinCompleted = new Map<string, number>(); // invSkuId -> units
  // Query ShipHero for every distinct in-scope Shopify SKU plus the completed
  // inventory SKUs themselves; attribute each returned SKU to its inventory SKU.
  const shipheroQuery = new Set<string>();
  for (const o of scoped) for (const l of o.lines) shipheroQuery.add(l.shopifySku);
  for (const s of skus) if (s.type === "COMPLETED") shipheroQuery.add(s.sku);

  if (shipheroQuery.size > 0) {
    try {
      const onHand = await getOnHandForSkus([...shipheroQuery]);
      const counted = new Set<string>();
      for (const [rawSku, qty] of onHand) {
        if (qty <= 0) continue;
        if (counted.has(norm(rawSku))) continue;
        counted.add(norm(rawSku));
        const invSkuId = resolveSku(rawSku, mapping, skuIdBySku);
        if (!invSkuId || !isBuildPlan(invSkuId)) continue;
        gallatinCompleted.set(invSkuId, (gallatinCompleted.get(invSkuId) ?? 0) + qty);
      }
    } catch (err) {
      dataHealth.shipheroOk = false;
      dataProblems.push(
        `Could not load Gallatin (ShipHero) stock: ${err instanceof Error ? err.message : String(err)}. Gallatin treated as 0.`
      );
    }
  }

  // --- Backorder mode: any build-plan SKU with demand > STG + Gallatin ---
  let backorder = false;
  for (const [invSkuId, demand] of demandBySku) {
    const avail = (stgCompleted.get(invSkuId) ?? 0) + (gallatinCompleted.get(invSkuId) ?? 0);
    if (demand > avail) {
      backorder = true;
      break;
    }
  }

  // --- Allocation (oldest-first): Gallatin covers first, STG covers the gap ---
  const stgRemaining = new Map(stgCompleted);
  const gallatinRemaining = new Map(gallatinCompleted);
  const reconGallatin = new Map<string, number>();
  const reconStg = new Map<string, number>();

  const sortedOrders = [...scoped].sort(
    (a, b) => new Date(a.originDate).getTime() - new Date(b.originDate).getTime()
  );

  const tagList: TagListRow[] = [];
  const shortfallByOrder: ShortfallOrderRow[] = [];

  for (const o of sortedOrders) {
    const ships: { shopifySku: string; invSku: string; qty: number }[] = [];
    let anyShort = false;

    for (const line of o.lines) {
      let need = line.qty;

      // Gallatin covers what it can (no STG action for that portion).
      const gAvail = gallatinRemaining.get(line.invSkuId) ?? 0;
      const gCov = Math.min(need, gAvail);
      gallatinRemaining.set(line.invSkuId, gAvail - gCov);
      need -= gCov;
      reconGallatin.set(line.invSkuId, (reconGallatin.get(line.invSkuId) ?? 0) + gCov);

      // STG covers the remaining gap via the rules engine.
      const stgAvail = stgRemaining.get(line.invSkuId) ?? 0;
      const stgShip = runRules(
        { invSkuId: line.invSkuId, need, stgRemaining: stgAvail, order: o },
        PHASE1_RULES
      );
      stgRemaining.set(line.invSkuId, stgAvail - stgShip);
      need -= stgShip;
      reconStg.set(line.invSkuId, (reconStg.get(line.invSkuId) ?? 0) + stgShip);

      if (stgShip > 0) {
        ships.push({ shopifySku: line.shopifySku, invSku: line.invSku, qty: stgShip });
      }
      if (need > 0) {
        anyShort = true;
        shortfallByOrder.push({
          orderName: o.orderName,
          store: o.source,
          who: o.company || o.customerName,
          email: o.email,
          invSku: line.invSku,
          shopifySku: line.shopifySku,
          qtyShort: need,
          orderDate: o.originDate,
        });
      }
    }

    if (ships.length === 0) continue; // Gallatin handled it (or fully short/no STG stock)

    // STGFULL when STG completes the order's outstanding demand (nothing short);
    // otherwise STGPART + one "91"+shopifySku tag per SKU STG ships.
    const full = !anyShort;
    const tagsToApply = full
      ? ["STGFULL"]
      : ["STGPART", ...ships.map((s) => `91${s.shopifySku.toLowerCase()}`)];

    tagList.push({
      orderName: o.orderName,
      store: o.source,
      customer: o.company || o.customerName,
      existingTags: o.tags,
      tagsToApply,
      ships,
      partial: !full,
    });
  }

  // --- Shortfall by SKU (aggregate) ---
  const shortfallBySku: ShortfallSkuRow[] = [];
  for (const [invSkuId, demand] of demandBySku) {
    const stg = stgCompleted.get(invSkuId) ?? 0;
    const gal = gallatinCompleted.get(invSkuId) ?? 0;
    const avail = stg + gal;
    const short = Math.max(0, demand - avail);
    const inv = skuById.get(invSkuId)!;
    shortfallBySku.push({
      invSku: inv.sku,
      name: inv.name,
      demand,
      available: avail,
      stgCompleted: stg,
      gallatinCompleted: gal,
      short,
    });
  }
  shortfallBySku.sort((a, b) => b.short - a.short || b.demand - a.demand || a.invSku.localeCompare(b.invSku));

  // --- Reconciliation: demand = Gallatin + STG + short ---
  const reconciliation: ReconRow[] = [];
  for (const [invSkuId, demand] of demandBySku) {
    const gal = reconGallatin.get(invSkuId) ?? 0;
    const stg = reconStg.get(invSkuId) ?? 0;
    const short = Math.max(0, demand - gal - stg);
    const inv = skuById.get(invSkuId)!;
    reconciliation.push({
      invSku: inv.sku,
      demand,
      gallatinCovered: gal,
      stgAllocated: stg,
      short,
      balances: gal + stg + short === demand,
    });
  }
  reconciliation.sort((a, b) => a.invSku.localeCompare(b.invSku));

  // --- Incoming POs (component supply timeline) ---
  const incomingPOs = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["SUBMITTED", "IN_ROUTE", "PARTIAL"] } },
    select: {
      poNumber: true,
      estimatedArrival: true,
      items: { select: { skuId: true, quantityOrdered: true, quantityReceived: true } },
    },
  });

  // extra components (incoming) for the build plan what-if
  const extraBySku = new Map<string, number>();
  const poMatches: BackorderSnapshot["poMatches"] = [];
  for (const po of incomingPOs) {
    for (const it of po.items) {
      const incoming = Math.max(0, it.quantityOrdered - it.quantityReceived);
      if (incoming <= 0) continue;
      extraBySku.set(it.skuId, (extraBySku.get(it.skuId) ?? 0) + incoming);
      const comp = skuById.get(it.skuId);
      poMatches.push({
        poNumber: po.poNumber,
        componentSku: comp?.sku ?? it.skuId,
        componentName: comp?.name ?? "",
        incoming,
        eta: po.estimatedArrival ? po.estimatedArrival.toISOString() : null,
      });
    }
  }

  // --- Production plan (reuse build-plan engine, with incoming POs as what-if) ---
  let buildPlan: BuildPlan;
  try {
    buildPlan = await computeBuildPlan({
      extra: [...extraBySku.entries()].map(([skuId, qty]) => ({ skuId, qty })),
      includeProgrammed: false,
      // Use the same Gallatin source (ShipHero Apex) as the rest of this page,
      // so the plan's "still short" doesn't ignore stock sitting in Gallatin.
      gallatinBySkuId: gallatinCompleted,
    });
  } catch (err) {
    dataProblems.push(
      `Build plan unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    buildPlan = { rows: [], totals: { unfulfilled: 0, programmed: 0, coveredFromStock: 0, built: 0, short: 0 }, unmatchedDemand: [], componentOptions: [] };
  }

  // --- ETAs: when will each backordered line's materials be on hand ---
  const etas = computeEtas(sortedOrders, skuById, stgCompleted, gallatinCompleted, incomingPOs, etaBusinessDays);

  const exceptions: BackorderExceptions = {
    unmapped: [...unmapped.entries()]
      .map(([shopifySku, v]) => ({ shopifySku, qty: v.qty, orders: [...v.orders] }))
      .sort((a, b) => b.qty - a.qty),
    excluded: [...excludedHits.entries()].map(([sku, v]) => ({
      sku,
      reason: exclusionReason.get(sku) ?? null,
      demand: v.demand,
      orders: [...v.orders],
    })),
    dataProblems,
  };

  return {
    generatedAt: new Date().toISOString(),
    backorder,
    dataHealth,
    etaBusinessDays,
    tagList,
    shortfallBySku,
    shortfallByOrder,
    exceptions,
    reconciliation,
    etas,
    buildPlan,
    poMatches,
  };
}

// ============================================================
// ETA computation (material-on-hand timeline, oldest-first reservation)
// ============================================================

type SkuRec = {
  id: string;
  sku: string;
  name: string;
  type: string;
  bomComponents: { componentSkuId: string; quantity: number }[];
  inventoryItems: { quantity: number; state: string }[];
};

// Explode an inventory SKU into leaf-component requirements per 1 unit.
function explodeToLeaves(
  skuId: string,
  qty: number,
  skuById: Map<string, SkuRec>,
  acc: Map<string, number>
): void {
  const node = skuById.get(skuId);
  if (!node || node.bomComponents.length === 0) {
    acc.set(skuId, (acc.get(skuId) ?? 0) + qty);
    return;
  }
  for (const c of node.bomComponents) {
    explodeToLeaves(c.componentSkuId, qty * c.quantity, skuById, acc);
  }
}

function componentOnHand(rec: SkuRec | undefined): number {
  if (!rec) return 0;
  // components live in RAW/ASSEMBLED/RECEIVED states; sum all on-hand.
  return Math.max(0, rec.inventoryItems.reduce((s, i) => s + i.quantity, 0));
}

function computeEtas(
  sortedOrders: ScopedOrder[],
  skuById: Map<string, SkuRec>,
  stgCompleted: Map<string, number>,
  gallatinCompleted: Map<string, number>,
  incomingPOs: { poNumber: string; estimatedArrival: Date | null; items: { skuId: string; quantityOrdered: number; quantityReceived: number }[] }[],
  etaBusinessDays: number
): OrderLineEta[] {
  // Per-component supply timeline: [{date, qty}] sorted; "now" first then PO ETAs.
  const supply = new Map<string, { date: number; qty: number }[]>();
  const ensureSupply = (skuId: string) => {
    if (!supply.has(skuId)) {
      supply.set(skuId, [{ date: 0, qty: componentOnHand(skuById.get(skuId)) }]);
    }
    return supply.get(skuId)!;
  };
  for (const po of incomingPOs) {
    const etaMs = po.estimatedArrival ? po.estimatedArrival.getTime() : null;
    for (const it of po.items) {
      const incoming = Math.max(0, it.quantityOrdered - it.quantityReceived);
      if (incoming <= 0 || etaMs == null) continue;
      const arr = ensureSupply(it.skuId);
      arr.push({ date: etaMs, qty: incoming });
    }
  }
  for (const arr of supply.values()) arr.sort((a, b) => a.date - b.date);

  // running consumed per component (oldest-order-first across all backorders)
  const consumed = new Map<string, number>();
  // completed-stock ledger (STG + Gallatin) drawn down first — a line covered by
  // finished stock needs no build and ships now.
  const finished = new Map<string, number>();
  for (const [id, q] of stgCompleted) finished.set(id, (finished.get(id) ?? 0) + q);
  for (const [id, q] of gallatinCompleted) finished.set(id, (finished.get(id) ?? 0) + q);

  const now = Date.now();
  const etas: OrderLineEta[] = [];

  for (const o of sortedOrders) {
    for (const line of o.lines) {
      let need = line.qty;
      // Cover from finished stock first (no materials needed).
      const fin = finished.get(line.invSkuId) ?? 0;
      const fromStock = Math.min(need, fin);
      finished.set(line.invSkuId, fin - fromStock);
      need -= fromStock;
      if (need <= 0) continue; // fully covered by finished stock — not backordered

      // Explode the build-need into leaf components.
      const leaves = new Map<string, number>();
      explodeToLeaves(line.invSkuId, need, skuById, leaves);

      let latest = now;
      let gating = "In stock";
      let anyMissing = false;

      for (const [compId, qtyNeeded] of leaves) {
        if (qtyNeeded <= 0) continue;
        const arr = ensureSupply(compId);
        const already = consumed.get(compId) ?? 0;
        const target = already + qtyNeeded;
        // Walk supply events accumulating until we reach `target`.
        let cum = 0;
        let readyMs: number | null = null;
        for (const ev of arr) {
          cum += ev.qty;
          if (cum >= target) {
            readyMs = ev.date === 0 ? now : ev.date;
            break;
          }
        }
        consumed.set(compId, target);
        const comp = skuById.get(compId);
        if (readyMs == null) {
          anyMissing = true;
          gating = `No PO covers ${comp?.sku ?? compId}`;
          latest = Infinity;
        } else if (readyMs > latest) {
          latest = readyMs;
          if (readyMs > now) {
            // find which PO ETA this corresponds to
            const po = incomingPOs.find(
              (p) => p.estimatedArrival && p.estimatedArrival.getTime() === readyMs && p.items.some((i) => i.skuId === compId)
            );
            gating = po
              ? `${comp?.sku ?? compId} — ${po.poNumber} ETA ${po.estimatedArrival!.toISOString().split("T")[0]}`
              : `${comp?.sku ?? compId} (incoming)`;
          }
        }
      }

      const who = o.company || o.customerName;
      if (anyMissing) {
        etas.push({
          orderName: o.orderName, store: o.source, who, email: o.email,
          invSku: line.invSku, shopifySku: line.shopifySku, qty: need,
          materialsReady: null, shipDate: null,
          gating: "No ETA — materials not on order",
        });
      } else {
        const readyDate = new Date(latest);
        const ship = addBusinessDays(readyDate, etaBusinessDays);
        etas.push({
          orderName: o.orderName, store: o.source, who, email: o.email,
          invSku: line.invSku, shopifySku: line.shopifySku, qty: need,
          materialsReady: readyDate.toISOString(),
          shipDate: ship.toISOString(),
          gating,
        });
      }
    }
  }

  return etas;
}

// ============================================================
// Snapshot persistence + run-if-stale
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackorderView {
  snapshot: BackorderSnapshot | null;
  ranAt: string | null;
  stale: boolean;
}

// Load the last snapshot; recompute if forced, missing, or older than 24h.
export async function loadBackorderView(opts: { force?: boolean } = {}): Promise<BackorderView> {
  const existing = await prisma.backorderRun.findUnique({ where: { id: "singleton" } });
  const stale = !existing || Date.now() - existing.ranAt.getTime() > DAY_MS;

  if (opts.force || stale) {
    const snapshot = await computeBackorder();
    const saved = await prisma.backorderRun.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", backorder: snapshot.backorder, snapshot: snapshot as unknown as object },
      update: { ranAt: new Date(), backorder: snapshot.backorder, snapshot: snapshot as unknown as object },
    });
    return { snapshot, ranAt: saved.ranAt.toISOString(), stale: false };
  }

  return {
    snapshot: (existing!.snapshot as unknown as BackorderSnapshot) ?? null,
    ranAt: existing!.ranAt.toISOString(),
    stale: false,
  };
}
