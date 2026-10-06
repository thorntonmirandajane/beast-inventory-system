// ============================================================================
// Fulfillment "game plans".
//
// A plan is a short list of rules for partially shipping a backlog — "one COC
// and all the practice tips on every order". Applying it to the open orders
// produces one ACTION per order: the exact lines to pick, and the note the
// warehouse reads.
//
// Two things keep it honest:
//   · Stock is drawn oldest-order-first from the chosen warehouse, so a plan
//     can never promise the same unit to two orders.
//   · Every order carries whatever actions it already has, from ANY plan. Change
//     the rules from 1 COC to 2 and the orders you already actioned stay
//     flagged, so nothing gets picked twice by accident.
// ============================================================================

import prisma from "../db.server";
import { loadUnfulfilledView, type UnfulfilledViewOrder } from "./unfulfilled-view.server";

export type PlanLocation = "GALLATIN" | "UTAH";
export type RuleMatch =
  | "CONTAINS"
  | "NOT_CONTAINS"
  | "PREFIX"
  | "EXACT"
  | "IN_LIST"      // has SKUs — one of the chosen SKUs
  | "NOT_IN_LIST"; // does not have SKUs — anything except the chosen SKUs
export type RuleMode = "QTY" | "ALL";

export interface PlanRule {
  id: string;
  /** How this rule decides which lines it covers. */
  matchType: RuleMatch;
  /** The text to match, for the CONTAINS / PREFIX / EXACT forms. */
  match: string;
  /** The chosen SKUs, for the IN_LIST / NOT_IN_LIST forms. */
  skus: string[];
  /** QTY = up to `qty` units per order; ALL = everything the order still needs. */
  mode: RuleMode;
  qty: number;
}

export const LIST_MATCHES: RuleMatch[] = ["IN_LIST", "NOT_IN_LIST"];
export const usesSkuList = (m: RuleMatch) => LIST_MATCHES.includes(m);

export interface PlannedLine {
  sku: string;
  title: string;
  qty: number;
  /** Which rule put it here, for the "why is this on the list" question. */
  rule: string;
}

export interface ExistingAction {
  planId: string;
  planName: string;
  status: string;
  units: number;
  exportedAt: string | null;
  createdAt: string;
}

export interface PlanPreviewOrder {
  store: string;
  orderId: string;
  orderName: string;
  customer: string;
  ageDays: number;
  totalNeeded: number;
  unfulfilledValue: number;
  lines: PlannedLine[];
  units: number;
  value: number;
  note: string;
  /** Actions this order already has, from this plan or any other. */
  existing: ExistingAction[];
  /** True when an action for THIS plan already exists. */
  inThisPlan: boolean;
}

export interface PlanPreview {
  location: PlanLocation;
  orders: PlanPreviewOrder[];
  totals: { orders: number; units: number; value: number; skipped: number };
  shortOf: { sku: string; wanted: number; available: number }[];
}

const norm = (s: string) => s.trim().toUpperCase();

const ALL_MATCHES: RuleMatch[] = ["CONTAINS", "NOT_CONTAINS", "PREFIX", "EXACT", "IN_LIST", "NOT_IN_LIST"];

export function parseRules(raw: unknown): PlanRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: any, i: number) => {
      const skus = Array.isArray(r?.skus) ? r.skus.map((x: any) => String(x)).filter(Boolean) : [];
      // A rule saved before the picker existed has text but no matchType of the
      // list kind; default those to CONTAINS as they always behaved.
      const matchType: RuleMatch = ALL_MATCHES.includes(r?.matchType)
        ? r.matchType
        : skus.length > 0
        ? "IN_LIST"
        : "CONTAINS";
      return {
        id: String(r?.id ?? `r${i}`),
        matchType,
        match: typeof r?.match === "string" ? String(r.match).trim() : "",
        skus,
        mode: (r?.mode === "ALL" ? "ALL" : "QTY") as RuleMode,
        qty: Math.max(0, Math.floor(Number(r?.qty) || 0)),
      };
    })
    // A rule with nothing to match on would either do nothing (list forms) or
    // match everything (text forms) — neither is what anyone meant.
    .filter((r) => (usesSkuList(r.matchType) ? r.skus.length > 0 : !!r.match));
}

function ruleMatches(rule: PlanRule, sku: string, title: string): boolean {
  const s = norm(sku);

  if (usesSkuList(rule.matchType)) {
    const inList = rule.skus.some((x) => norm(x) === s);
    return rule.matchType === "IN_LIST" ? inList : !inList;
  }

  if (!rule.match) return false;
  const needle = norm(rule.match);
  if (rule.matchType === "EXACT") return s === needle;
  if (rule.matchType === "PREFIX") return s.startsWith(needle);
  const contains = s.includes(needle) || norm(title).includes(needle);
  return rule.matchType === "NOT_CONTAINS" ? !contains : contains;
}

/** How a rule reads back on the preview, so a picked line can be traced to it. */
export function describeRule(rule: PlanRule): string {
  const act = rule.mode === "ALL" ? "all" : `up to ${rule.qty}`;
  switch (rule.matchType) {
    case "IN_LIST": return `${act} · ${rule.skus.length} chosen SKU(s)`;
    case "NOT_IN_LIST": return `${act} · anything except ${rule.skus.length} SKU(s)`;
    case "NOT_CONTAINS": return `${act} · not containing "${rule.match}"`;
    case "PREFIX": return `${act} · starting "${rule.match}"`;
    case "EXACT": return `${act} · exactly "${rule.match}"`;
    default: return `${act} · containing "${rule.match}"`;
  }
}

/** Render the warehouse note from the plan's template. */
export function renderNote(
  template: string,
  ctx: { plan: string; location: string; order: string; lines: PlannedLine[] }
): string {
  const items = ctx.lines.map((l) => `${l.qty}x ${l.sku}`).join(", ");
  return (template || "{plan}: ship {items} from {location}")
    .replaceAll("{plan}", ctx.plan)
    .replaceAll("{location}", ctx.location === "UTAH" ? "Utah" : "Gallatin")
    .replaceAll("{order}", ctx.order)
    .replaceAll("{items}", items)
    .trim();
}

/**
 * Apply a plan's rules to the current open orders.
 *
 * Orders are walked oldest-first and each takes from what's left of the chosen
 * warehouse's stock, so the preview is a list that could actually be picked —
 * not a wish list that runs out halfway down.
 */
export async function previewPlan(input: {
  planId?: string | null;
  planName: string;
  location: PlanLocation;
  storeFilter: string;
  noteTemplate: string;
  rules: PlanRule[];
  /** Leave out orders that already have an action from any plan. */
  skipActioned?: boolean;
  /** Supply the backlog directly instead of fetching it (tests). */
  view?: Awaited<ReturnType<typeof loadUnfulfilledView>>;
}): Promise<PlanPreview> {
  const view = input.view ?? (await loadUnfulfilledView());
  const rules = input.rules.filter((r) => r.mode === "ALL" || r.qty > 0);

  let orders: UnfulfilledViewOrder[] = [...view.orders].sort((a, b) => b.ageDays - a.ageDays);
  if (input.storeFilter === "beast" || input.storeFilter === "archery") {
    orders = orders.filter((o) => o.store === input.storeFilter);
  }

  // Everything this order list has ever been actioned with, any plan.
  const actions = await prisma.fulfillmentPlanAction.findMany({
    where: { orderId: { in: [...new Set(orders.map((o) => o.orderId))] }, status: { not: "CANCELLED" } },
    include: { plan: { select: { id: true, name: true } } },
  });
  const actionsByOrder = new Map<string, ExistingAction[]>();
  for (const a of actions) {
    const list = actionsByOrder.get(a.orderId) ?? [];
    list.push({
      planId: a.plan.id,
      planName: a.plan.name,
      status: a.status,
      units: a.units,
      exportedAt: a.exportedAt ? a.exportedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    });
    actionsByOrder.set(a.orderId, list);
  }

  // Stock left at the chosen warehouse, drawn down as we go.
  const pool = new Map<string, number>();
  for (const o of view.orders) {
    for (const l of o.lines) {
      const key = norm(l.sku);
      if (pool.has(key)) continue;
      const onHand = input.location === "UTAH" ? l.utahOnHand : l.gallatinOnHand;
      pool.set(key, Math.max(0, onHand ?? 0));
    }
  }

  const wanted = new Map<string, number>();
  const out: PlanPreviewOrder[] = [];
  let skipped = 0;

  for (const o of orders) {
    const existing = actionsByOrder.get(o.orderId) ?? [];
    const inThisPlan = !!input.planId && existing.some((e) => e.planId === input.planId);
    if (input.skipActioned && existing.length > 0 && !inThisPlan) {
      skipped++;
      continue;
    }

    const lines: PlannedLine[] = [];
    for (const l of o.lines) {
      const rule = rules.find((r) => ruleMatches(r, l.sku, l.title));
      if (!rule) continue;
      const askFor = rule.mode === "ALL" ? l.needed : Math.min(rule.qty, l.needed);
      if (askFor <= 0) continue;

      const key = norm(l.sku);
      wanted.set(key, (wanted.get(key) ?? 0) + askFor);
      const left = pool.get(key) ?? 0;
      const take = Math.min(askFor, left);
      if (take <= 0) continue;
      pool.set(key, left - take);

      lines.push({
        sku: l.sku,
        title: l.title,
        qty: take,
        rule: describeRule(rule),
      });
    }

    if (lines.length === 0) continue;

    const units = lines.reduce((t, l) => t + l.qty, 0);
    const value =
      Math.round(
        lines.reduce((t, l) => {
          const src = o.lines.find((x) => norm(x.sku) === norm(l.sku));
          return t + (src?.unitPrice ?? 0) * l.qty;
        }, 0) * 100
      ) / 100;

    out.push({
      store: o.store,
      orderId: o.orderId,
      orderName: o.orderName,
      customer: o.company || o.customerName || "",
      ageDays: o.ageDays,
      totalNeeded: o.totalNeeded,
      unfulfilledValue: o.unfulfilledValue,
      lines,
      units,
      value,
      note: renderNote(input.noteTemplate, {
        plan: input.planName,
        location: input.location,
        order: o.orderName,
        lines,
      }),
      existing,
      inThisPlan,
    });
  }

  // Where the rules asked for more than the warehouse holds.
  const shortOf: PlanPreview["shortOf"] = [];
  for (const [sku, want] of wanted) {
    const start = view.orders
      .flatMap((o) => o.lines)
      .find((l) => norm(l.sku) === sku);
    const available = Math.max(0, (input.location === "UTAH" ? start?.utahOnHand : start?.gallatinOnHand) ?? 0);
    if (want > available) shortOf.push({ sku, wanted: want, available });
  }
  shortOf.sort((a, b) => b.wanted - b.available - (a.wanted - a.available));

  return {
    location: input.location,
    orders: out,
    totals: {
      orders: out.length,
      units: out.reduce((t, o) => t + o.units, 0),
      value: Math.round(out.reduce((t, o) => t + o.value, 0) * 100) / 100,
      skipped,
    },
    shortOf,
  };
}

/** Write the preview down as actions, so these orders are marked as handled. */
export async function commitPlan(planId: string, preview: PlanPreview): Promise<number> {
  const plan = await prisma.fulfillmentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("Plan not found");

  let saved = 0;
  for (const o of preview.orders) {
    await prisma.fulfillmentPlanAction.upsert({
      where: { planId_store_orderId: { planId, store: o.store, orderId: o.orderId } },
      create: {
        planId, store: o.store, orderId: o.orderId, orderName: o.orderName,
        location: preview.location, lines: o.lines as any, units: o.units, note: o.note,
      },
      update: { lines: o.lines as any, units: o.units, note: o.note, location: preview.location },
    });
    saved++;
  }
  await prisma.fulfillmentPlan.update({ where: { id: planId }, data: { status: "ACTIVE" } });
  return saved;
}

const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Matrixify-shaped CSV: one row per line to pick, repeating the order name, with
 * the warehouse note on the first row of each order (Matrixify applies a
 * command's order-level fields from the first row of the group).
 */
export function toMatrixifyCsv(preview: PlanPreview, planName: string): string {
  const header = [
    "Name",
    "Line: SKU",
    "Line: Title",
    "Line: Quantity",
    "Fulfillment: Location",
    "Fulfillment: Send Notification",
    "Note",
    "Tags Command",
    "Tags",
  ];
  const locationName = preview.location === "UTAH" ? "Utah" : "Gallatin";
  const rows: (string | number)[][] = [];
  for (const o of preview.orders) {
    o.lines.forEach((l, i) => {
      rows.push([
        o.orderName,
        l.sku,
        l.title,
        l.qty,
        locationName,
        i === 0 ? "FALSE" : "",
        i === 0 ? o.note : "",
        i === 0 ? "MERGE" : "",
        i === 0 ? `plan:${planName.replace(/[,"]/g, " ").trim()}` : "",
      ]);
    });
  }
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}
