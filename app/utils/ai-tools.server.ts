// ============================================================================
// AI CHAT TOOL SURFACE — READ-ONLY
//
// Every tool the assistant can call lives here. Two rules hold for all of them:
//
//   1. Read-only. No tool writes to the database or to any external system.
//      The chat can answer questions and run hypotheticals; it can never move
//      inventory, approve time, or create a PO.
//   2. Bounded. Every result is capped and shaped into small, flat JSON so a
//      long conversation doesn't blow up the context window.
//
// SKU is the join key everywhere (names change, SKUs don't).
// ============================================================================

import type Anthropic from "@anthropic-ai/sdk";
import type { InventoryState, SkuType } from "@prisma/client";
import prisma from "../db.server";
import {
  getUnfulfilledLineItems,
  aggregateUnfulfilledBySku,
  getFulfilledInRange,
  aggregateFulfilled,
} from "./shopify.server";
import { getOnHandForSkus } from "./shiphero.server";
import { calculateBuildEligibility, getAllBuildEligibility } from "./inventory.server";
import { fetchProgrammedOrders } from "./queued-orders-client.server";
import { resolveProcessConfig } from "./process";

// ============================================================
// Shared helpers
// ============================================================

const MAX_ROWS = 200;
const EXTERNAL_TIMEOUT_MS = 25000;

const norm = (s: string) => s.trim().toUpperCase();
const ymd = (d: Date | null | undefined) =>
  d ? new Date(d).toISOString().split("T")[0] : null;

/** The inventory state a SKU is "available" in, from its type. */
function availableStateFor(type: SkuType): InventoryState {
  return type === "RAW" ? "RAW" : type === "ASSEMBLY" ? "ASSEMBLED" : "COMPLETED";
}

/** Start-of-day / end-of-day Date for a YYYY-MM-DD string, with a fallback. */
function dayStart(s: string | undefined, fallbackDaysAgo: number): Date {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`);
  return new Date(Date.now() - fallbackDaysAgo * 24 * 60 * 60 * 1000);
}
function dayEnd(s: string | undefined): Date {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59`);
  return new Date();
}

/** Cap an external call so one slow integration can't hang the whole answer. */
async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${EXTERNAL_TIMEOUT_MS / 1000}s`)),
        EXTERNAL_TIMEOUT_MS
      )
    ),
  ]);
}

type SkuRow = {
  id: string;
  sku: string;
  name: string;
  type: SkuType;
  category: string | null;
  material: string | null;
  isActive: boolean;
};

/**
 * Resolve user/model-supplied SKU strings to real SKU records. Exact
 * (case-insensitive) match wins; otherwise anything containing the string is
 * returned, so "COC-TI" or a partial code still finds its family. Unmatched
 * strings come back in `missing` so the assistant can say so instead of
 * silently answering about the wrong part.
 */
async function resolveSkus(
  patterns: string[]
): Promise<{ rows: SkuRow[]; missing: string[] }> {
  const select = {
    id: true, sku: true, name: true, type: true,
    category: true, material: true, isActive: true,
  } as const;

  const rows: SkuRow[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const raw of patterns) {
    const p = raw?.trim();
    if (!p) continue;
    let found = await prisma.sku.findMany({
      where: { sku: { equals: p, mode: "insensitive" } },
      select,
    });
    if (found.length === 0) {
      found = await prisma.sku.findMany({
        where: {
          OR: [
            { sku: { contains: p, mode: "insensitive" } },
            { name: { contains: p, mode: "insensitive" } },
          ],
        },
        select,
        take: 25,
        orderBy: { sku: "asc" },
      });
    }
    if (found.length === 0) {
      missing.push(p);
      continue;
    }
    for (const f of found) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      rows.push(f);
    }
  }
  return { rows, missing };
}

// ============================================================
// Tool definitions (what the model sees)
// ============================================================

export const AI_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_skus",
    description:
      "Find SKUs by code, name, category, or type. Use this first when the user names a product loosely (\"the 100 grain 3 packs\") so you can work with real SKU codes afterward. Returns SKU code, name, type (RAW/ASSEMBLY/COMPLETED), category, and the process that builds it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match against SKU code or name. Omit to list everything." },
        type: { type: "string", enum: ["RAW", "ASSEMBLY", "COMPLETED"], description: "Restrict to one SKU type." },
        category: { type: "string", description: "Restrict to a category." },
        include_inactive: { type: "boolean", description: "Include deactivated SKUs (default false)." },
        limit: { type: "number", description: "Max rows (default 50, max 200)." },
      },
    },
  },
  {
    name: "get_inventory",
    description:
      "On-hand inventory. Utah numbers are this system's perpetual count on the production floor, broken out by state (RECEIVED = received but not signed off, RAW, ASSEMBLED, COMPLETED = finished goods, TRANSFERRED = already shipped out). Set include_gallatin to also pull live on-hand from the Gallatin fulfillment warehouse (ShipHero Apex) — that is what is actually available to ship to customers.",
    input_schema: {
      type: "object",
      properties: {
        skus: { type: "array", items: { type: "string" }, description: "Specific SKUs. Omit for all." },
        type: { type: "string", enum: ["RAW", "ASSEMBLY", "COMPLETED"] },
        search: { type: "string", description: "Match SKU code or name." },
        include_gallatin: { type: "boolean", description: "Also fetch live ShipHero on-hand (slower, a few seconds)." },
        only_nonzero: { type: "boolean", description: "Drop rows with nothing on hand (default false)." },
        limit: { type: "number", description: "Max rows (default 100, max 200)." },
      },
    },
  },
  {
    name: "get_sku_detail",
    description:
      "Everything about one SKU: inventory by state, its bill of materials (direct components), the parent products it feeds into, manufacturers with cost and lead time, process times, open purchase-order quantity, and recent inventory movements.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string", description: "SKU code (partial is allowed)." } },
      required: ["sku"],
    },
  },
  {
    name: "get_unfulfilled_orders",
    description:
      "Live open customer demand from Shopify — units ordered and not yet shipped, across both the Bowmar Archery and Beast Broadhead stores. group_by 'sku' gives total unfulfilled units per SKU; group_by 'order' lists individual orders oldest first (useful for 'what is the oldest order waiting' questions).",
    input_schema: {
      type: "object",
      properties: {
        group_by: { type: "string", enum: ["sku", "order"], description: "Default 'sku'." },
        sku: { type: "string", description: "Restrict to one SKU." },
        store: { type: "string", enum: ["archery", "beast"], description: "Restrict to one store." },
        limit: { type: "number", description: "Max rows (default 100, max 200)." },
      },
    },
  },
  {
    name: "get_programmed_orders",
    description:
      "Scheduled/queued dealer orders from the Queued Orders app for a date window — demand that is committed but has not hit Shopify as an open order yet. Returns totals by SKU plus the individual scheduled orders.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD (default today)." },
        to: { type: "string", description: "YYYY-MM-DD (default 30 days out)." },
      },
    },
  },
  {
    name: "get_build_capacity",
    description:
      "How many units can be built right now from parts on hand, one level of the bill of materials down. Returns max buildable and the bottleneck component for each assembly/finished SKU. For a multi-product or multi-level question, use simulate_build instead.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "One SKU. Omit for every buildable SKU." },
        limit: { type: "number", description: "Max rows when listing all (default 50)." },
      },
    },
  },
  {
    name: "simulate_build",
    description:
      "HYPOTHETICAL PLANNER. Given a wish list of finished quantities, explode every bill of materials to the raw parts, drawing from ONE shared pool of on-hand stock so parts shared between products are never counted twice. Returns which sub-assemblies must be built, which raw materials are short and by how many, and the labor hours per process. This is the tool for 'what if we needed to build X of A and Y of B — what would we run out of?'",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The build wish list.",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              quantity: { type: "number" },
            },
            required: ["sku", "quantity"],
          },
        },
        net_of_on_hand: {
          type: "boolean",
          description:
            "When true, subtract the finished units already on hand (Utah COMPLETED + Gallatin) from each requested quantity before exploding, so the answer is what still has to be BUILT rather than what the total order needs. Default false.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "get_purchase_orders",
    description:
      "Purchase orders — what is on order from vendors, what is still outstanding, and when it is expected. Statuses: SUBMITTED, IN_ROUTE, PARTIAL, RECEIVED, APPROVED, CANCELLED. Use open_only for incoming supply.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["SUBMITTED", "IN_ROUTE", "PARTIAL", "RECEIVED", "APPROVED", "CANCELLED"] },
        open_only: { type: "boolean", description: "Only POs with units still outstanding (default true)." },
        sku: { type: "string", description: "Only POs containing this SKU." },
        limit: { type: "number", description: "Max POs (default 50)." },
      },
    },
  },
  {
    name: "get_work_orders",
    description: "Production work orders: what is queued or in progress on the floor, quantity to build vs built.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"] },
        limit: { type: "number", description: "Max rows (default 50)." },
      },
    },
  },
  {
    name: "get_transfers",
    description: "Shipments of finished goods out of Utah to a destination (normally the Gallatin fulfillment warehouse), with the SKUs and quantities on each.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look back this many days (default 60)." },
        sku: { type: "string", description: "Only transfers containing this SKU." },
        limit: { type: "number", description: "Max transfers (default 50)." },
      },
    },
  },
  {
    name: "get_production_history",
    description:
      "What was actually produced, from approved worker time entries. Accepted quantity = submitted (or admin-adjusted) minus anything rejected in QC. Group by day, sku, process, or worker to answer throughput and rate questions.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "YYYY-MM-DD (default 30 days ago)." },
        end: { type: "string", description: "YYYY-MM-DD (default today)." },
        sku: { type: "string" },
        process: { type: "string", description: "Process name, e.g. TIPPING." },
        group_by: { type: "string", enum: ["day", "sku", "process", "worker"], description: "Default 'sku'." },
      },
    },
  },
  {
    name: "get_inventory_movements",
    description:
      "The inventory audit trail: every RECEIVED / CONSUMED / PRODUCED / TRANSFERRED_OUT / TRANSFERRED_IN / ADJUSTED / DISPOSED movement, newest first. Use this to explain why a count changed or to find disposals and manual adjustments.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        days: { type: "number", description: "Look back this many days (default 30)." },
        action: {
          type: "string",
          enum: ["RECEIVED", "CONSUMED", "PRODUCED", "TRANSFERRED_OUT", "TRANSFERRED_IN", "ADJUSTED", "DISPOSED"],
        },
        limit: { type: "number", description: "Max rows (default 100, max 200)." },
      },
    },
  },
  {
    name: "get_fulfilled_orders",
    description:
      "Units actually shipped to customers in a date range, split by channel: 'shiphero' (Gallatin warehouse) vs 'utah' (shipped in house). Gives per-SKU totals and per-service totals. Use it for sell-through and demand-rate questions. Ranges longer than a few weeks are slow.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD (default 30 days ago)." },
        to: { type: "string", description: "YYYY-MM-DD (default today)." },
      },
    },
  },
  {
    name: "get_labor_capacity",
    description:
      "Process configuration (seconds per unit for each production process, and which inventory state it consumes and produces) plus scheduled labor hours available in a date range from the active worker schedules. Pair with simulate_build's labor hours to answer 'can we get it done by Friday'.",
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "YYYY-MM-DD (default today)." },
        end: { type: "string", description: "YYYY-MM-DD (default 7 days out)." },
      },
    },
  },
];

// ============================================================
// Tool implementations
// ============================================================

const clamp = (n: unknown, def: number, max = MAX_ROWS) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : def;
  return Math.max(1, Math.min(v, max));
};

async function toolSearchSkus(input: any) {
  const take = clamp(input.limit, 50);
  const where: any = {};
  if (!input.include_inactive) where.isActive = true;
  if (input.type) where.type = input.type;
  if (input.category) where.category = { equals: input.category, mode: "insensitive" };
  if (input.query) {
    where.OR = [
      { sku: { contains: input.query, mode: "insensitive" } },
      { name: { contains: input.query, mode: "insensitive" } },
    ];
  }
  const rows = await prisma.sku.findMany({
    where,
    select: { sku: true, name: true, type: true, category: true, material: true, grain: true, diameter: true, isActive: true },
    orderBy: { sku: "asc" },
    take,
  });
  const total = await prisma.sku.count({ where });
  return {
    count: rows.length,
    total_matching: total,
    truncated: total > rows.length,
    skus: rows.map((r) => ({
      sku: r.sku, name: r.name, type: r.type, category: r.category,
      built_by_process: r.material, grain: r.grain, diameter: r.diameter,
      active: r.isActive,
    })),
  };
}

async function toolGetInventory(input: any) {
  const take = clamp(input.limit, 100);
  const where: any = { isActive: true };
  if (input.type) where.type = input.type;
  if (input.search) {
    where.OR = [
      { sku: { contains: input.search, mode: "insensitive" } },
      { name: { contains: input.search, mode: "insensitive" } },
    ];
  }
  if (Array.isArray(input.skus) && input.skus.length > 0) {
    const { rows, missing } = await resolveSkus(input.skus);
    where.id = { in: rows.map((r) => r.id) };
    if (rows.length === 0) return { error: `No SKU matched: ${missing.join(", ")}` };
  }

  const skus = await prisma.sku.findMany({
    where,
    select: {
      sku: true, name: true, type: true, category: true, material: true,
      inventoryItems: { select: { state: true, quantity: true } },
    },
    orderBy: { sku: "asc" },
    take,
  });

  let gallatin: Map<string, number> | null = null;
  let gallatinError: string | null = null;
  if (input.include_gallatin) {
    try {
      const live = await withTimeout(getOnHandForSkus(skus.map((s) => s.sku)), "ShipHero on-hand");
      gallatin = new Map();
      for (const [s, q] of live) gallatin.set(norm(s), q);
    } catch (err) {
      gallatinError = err instanceof Error ? err.message : String(err);
    }
  }

  let rows = skus.map((s) => {
    const states: Record<string, number> = { RECEIVED: 0, RAW: 0, ASSEMBLED: 0, COMPLETED: 0, TRANSFERRED: 0 };
    for (const i of s.inventoryItems) states[i.state] = (states[i.state] ?? 0) + i.quantity;
    const available = states[availableStateFor(s.type)] ?? 0;
    return {
      sku: s.sku,
      name: s.name,
      type: s.type,
      built_by_process: s.material,
      utah_available: available,
      utah_by_state: states,
      gallatin_on_hand: gallatin ? gallatin.get(norm(s.sku)) ?? 0 : undefined,
    };
  });

  if (input.only_nonzero) {
    rows = rows.filter((r) => r.utah_available !== 0 || (r.gallatin_on_hand ?? 0) !== 0);
  }

  return {
    as_of: new Date().toISOString(),
    count: rows.length,
    gallatin_error: gallatinError,
    note: "utah_available is this system's floor count in the SKU's own state. gallatin_on_hand is live ShipHero (only present when include_gallatin was set).",
    inventory: rows,
  };
}

async function toolGetSkuDetail(input: any) {
  const { rows, missing } = await resolveSkus([input.sku]);
  if (rows.length === 0) return { error: `No SKU matched "${missing[0] ?? input.sku}"` };
  const target = rows[0];

  const [sku, movements, poItems, processTimes] = await Promise.all([
    prisma.sku.findUnique({
      where: { id: target.id },
      include: {
        inventoryItems: { select: { state: true, quantity: true, location: true } },
        bomComponents: {
          include: { componentSku: { select: { sku: true, name: true, type: true } } },
        },
        usedInBoms: {
          include: { parentSku: { select: { sku: true, name: true, type: true } } },
        },
        manufacturers: {
          include: { manufacturer: { select: { name: true } } },
        },
      },
    }),
    prisma.inventoryLog.findMany({
      where: { skuId: target.id },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { action: true, quantity: true, fromState: true, toState: true, processName: true, notes: true, createdAt: true },
    }),
    prisma.pOItem.findMany({
      where: { skuId: target.id, purchaseOrder: { status: { in: ["SUBMITTED", "IN_ROUTE", "PARTIAL"] } } },
      select: {
        quantityOrdered: true, quantityReceived: true, unitCost: true,
        purchaseOrder: { select: { poNumber: true, vendorName: true, status: true, estimatedArrival: true } },
      },
    }),
    prisma.processTime.findMany({
      where: { skuId: target.id },
      select: { processType: true, minutesPerUnit: true },
    }),
  ]);
  if (!sku) return { error: "SKU disappeared mid-query" };

  const states: Record<string, number> = { RECEIVED: 0, RAW: 0, ASSEMBLED: 0, COMPLETED: 0, TRANSFERRED: 0 };
  for (const i of sku.inventoryItems) states[i.state] = (states[i.state] ?? 0) + i.quantity;

  return {
    sku: sku.sku,
    name: sku.name,
    type: sku.type,
    category: sku.category,
    built_by_process: sku.material,
    grain: sku.grain,
    diameter: sku.diameter,
    upc: sku.upc,
    active: sku.isActive,
    utah_available: states[availableStateFor(sku.type)] ?? 0,
    utah_by_state: states,
    bill_of_materials: sku.bomComponents.map((b) => ({
      component_sku: b.componentSku.sku,
      name: b.componentSku.name,
      type: b.componentSku.type,
      qty_per_unit: b.quantity,
    })),
    used_in: sku.usedInBoms.map((b) => ({
      parent_sku: b.parentSku.sku,
      name: b.parentSku.name,
      type: b.parentSku.type,
      qty_per_parent: b.quantity,
    })),
    manufacturers: sku.manufacturers.map((m) => ({
      name: m.manufacturer.name,
      unit_cost: m.cost,
      lead_time_days: m.leadTimeDays,
      preferred: m.isPreferred,
    })),
    process_times_minutes_per_unit: processTimes.map((p) => ({ process: p.processType, minutes_per_unit: p.minutesPerUnit })),
    on_order: poItems.map((p) => ({
      po_number: p.purchaseOrder.poNumber,
      vendor: p.purchaseOrder.vendorName,
      status: p.purchaseOrder.status,
      ordered: p.quantityOrdered,
      received: p.quantityReceived,
      outstanding: Math.max(0, p.quantityOrdered - p.quantityReceived),
      expected: ymd(p.purchaseOrder.estimatedArrival),
      unit_cost: p.unitCost,
    })),
    recent_movements: movements.map((m) => ({
      date: m.createdAt.toISOString(),
      action: m.action,
      quantity: m.quantity,
      from_state: m.fromState,
      to_state: m.toState,
      process: m.processName,
      notes: m.notes,
    })),
  };
}

async function toolGetUnfulfilled(input: any) {
  let items;
  try {
    items = await withTimeout(getUnfulfilledLineItems(), "Shopify unfulfilled orders");
  } catch (err) {
    return { error: `Could not reach Shopify: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (input.store) items = items.filter((i) => i.source === input.store);
  if (input.sku) {
    const needle = norm(input.sku);
    items = items.filter((i) => norm(i.sku).includes(needle));
  }
  const take = clamp(input.limit, 100);

  if (input.group_by === "order") {
    const byOrder = new Map<string, { order: string; store: string; created: string; units: number; lines: { sku: string; qty: number }[] }>();
    for (const it of items) {
      const key = `${it.source}:${it.orderId}`;
      let o = byOrder.get(key);
      if (!o) {
        o = { order: it.orderName, store: it.source, created: it.orderCreatedAt, units: 0, lines: [] };
        byOrder.set(key, o);
      }
      o.units += it.quantity;
      o.lines.push({ sku: it.sku, qty: it.quantity });
    }
    const orders = Array.from(byOrder.values()).sort((a, b) => a.created.localeCompare(b.created));
    const now = Date.now();
    return {
      as_of: new Date().toISOString(),
      total_open_orders: orders.length,
      total_unfulfilled_units: items.reduce((s, i) => s + i.quantity, 0),
      orders: orders.slice(0, take).map((o) => ({
        ...o,
        age_days: Math.floor((now - new Date(o.created).getTime()) / 86400000),
      })),
      truncated: orders.length > take,
    };
  }

  const agg = aggregateUnfulfilledBySku(items);
  const rows = Array.from(agg.entries())
    .map(([sku, a]) => ({
      sku,
      unfulfilled_units: a.quantity,
      beast_store: a.beastQuantity,
      archery_store: a.archeryQuantity,
      open_orders: a.orderCount,
    }))
    .sort((a, b) => b.unfulfilled_units - a.unfulfilled_units);

  return {
    as_of: new Date().toISOString(),
    total_unfulfilled_units: rows.reduce((s, r) => s + r.unfulfilled_units, 0),
    sku_count: rows.length,
    by_sku: rows.slice(0, take),
    truncated: rows.length > take,
  };
}

async function toolGetProgrammed(input: any) {
  const from = input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from)
    ? input.from
    : new Date().toISOString().split("T")[0];
  const to = input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to)
    ? input.to
    : new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  try {
    const res = await withTimeout(fetchProgrammedOrders({ from, to }), "Programmed orders");
    return {
      from: res.from,
      to: res.to,
      order_count: res.count,
      total_units: res.totalUnits,
      total_amount: res.totalAmount,
      by_sku: res.bySku.slice(0, MAX_ROWS),
      orders: res.orders.slice(0, 50).map((o) => ({
        scheduled_date: o.scheduledDate,
        customer: o.customerName,
        company: o.companyName,
        po_number: o.poNumber,
        amount: o.totalAmount,
        held: o.holdAutoConvert,
        lines: o.lineItems.map((l) => ({ sku: l.sku, qty: l.quantity })),
      })),
    };
  } catch (err) {
    return { error: `Programmed orders unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function toolGetBuildCapacity(input: any) {
  if (input.sku) {
    const { rows, missing } = await resolveSkus([input.sku]);
    if (rows.length === 0) return { error: `No SKU matched "${missing[0] ?? input.sku}"` };
    const e = await calculateBuildEligibility(rows[0].id);
    return {
      sku: e.sku, name: e.name, type: e.type,
      max_buildable_now: e.maxBuildable,
      bottleneck: e.bottleneck,
      components: e.components,
      note: "One BOM level down — sub-assemblies are counted as stock on hand, not exploded. Use simulate_build for the full explosion.",
    };
  }
  const all = await getAllBuildEligibility();
  const take = clamp(input.limit, 50);
  return {
    count: all.length,
    buildable: all.slice(0, take).map((e) => ({
      sku: e.sku, name: e.name, type: e.type,
      max_buildable_now: e.maxBuildable,
      bottleneck_sku: e.bottleneck?.sku ?? null,
      bottleneck_available: e.bottleneck?.available ?? null,
    })),
    truncated: all.length > take,
  };
}

// --- simulate_build ---------------------------------------------------------
// Mirrors the Forecasting tab's shared-pool BOM explosion: every requested
// product draws from ONE availability pool, so a component used by several
// products is never promised twice and shortfalls add up honestly.

type ExplosionSku = {
  id: string; sku: string; name: string; type: string; material: string | null;
  bomComponents: { componentSkuId: string; quantity: number }[];
};

function explodeShared(
  skuId: string,
  quantity: number,
  raws: Map<string, { sku: string; name: string; needed: number; allocated: number }>,
  assemblies: Map<string, { sku: string; name: string; material: string | null; needed: number; allocated: number }>,
  skuInfo: Map<string, ExplosionSku>,
  pool: Map<string, number>,
  visited: Set<string> = new Set()
): void {
  if (quantity <= 0 || visited.has(skuId)) return;
  visited.add(skuId);
  const parent = skuInfo.get(skuId);
  if (!parent) return;

  for (const line of parent.bomComponents) {
    const comp = skuInfo.get(line.componentSkuId);
    if (!comp) continue;
    const needed = line.quantity * quantity;
    const availNow = Math.max(0, pool.get(comp.id) ?? 0);
    const allocated = Math.min(needed, availNow);
    pool.set(comp.id, availNow - allocated);
    const shortfall = needed - allocated;

    if (comp.type === "RAW") {
      const e = raws.get(comp.id);
      if (e) { e.needed += needed; e.allocated += allocated; }
      else raws.set(comp.id, { sku: comp.sku, name: comp.name, needed, allocated });
    } else {
      const e = assemblies.get(comp.id);
      if (e) { e.needed += needed; e.allocated += allocated; }
      else assemblies.set(comp.id, { sku: comp.sku, name: comp.name, material: comp.material, needed, allocated });
      if (shortfall > 0) {
        explodeShared(comp.id, shortfall, raws, assemblies, skuInfo, pool, new Set(visited));
      }
    }
  }
}

async function toolSimulateBuild(input: any) {
  const wanted: { sku: string; quantity: number }[] = Array.isArray(input.items) ? input.items : [];
  if (wanted.length === 0) return { error: "items is required: [{sku, quantity}]" };

  const { rows: resolved, missing } = await resolveSkus(wanted.map((w) => w.sku));
  if (resolved.length === 0) return { error: `No SKU matched: ${missing.join(", ")}` };

  const all = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true, sku: true, name: true, type: true, material: true,
      bomComponents: { select: { componentSkuId: true, quantity: true } },
      inventoryItems: { where: { quantity: { not: 0 } }, select: { quantity: true, state: true } },
    },
  });
  const skuInfo = new Map<string, ExplosionSku>();
  const pool = new Map<string, number>();
  // Finished stock in the SKU's own state — used for netting only. The pool
  // itself sums every state, matching the Forecasting tab exactly so the chat
  // and that screen never disagree on a shortage.
  const finishedStock = new Map<string, number>();
  for (const s of all) {
    skuInfo.set(s.id, { id: s.id, sku: s.sku, name: s.name, type: s.type, material: s.material, bomComponents: s.bomComponents });
    pool.set(s.id, s.inventoryItems.reduce((sum, i) => sum + i.quantity, 0));
    const own = availableStateFor(s.type);
    finishedStock.set(
      s.id,
      s.inventoryItems.filter((i) => i.state === own).reduce((sum, i) => sum + i.quantity, 0)
    );
  }

  // Optional: only plan what still has to be built, netting off finished units
  // already sitting in Utah and (best effort) in Gallatin.
  let gallatin: Map<string, number> | null = null;
  let gallatinError: string | null = null;
  if (input.net_of_on_hand) {
    try {
      const live = await withTimeout(
        getOnHandForSkus(resolved.map((r) => r.sku)),
        "ShipHero on-hand"
      );
      gallatin = new Map();
      for (const [s, q] of live) gallatin.set(norm(s), q);
    } catch (err) {
      gallatinError = err instanceof Error ? err.message : String(err);
    }
  }

  const raws = new Map<string, { sku: string; name: string; needed: number; allocated: number }>();
  const assemblies = new Map<string, { sku: string; name: string; material: string | null; needed: number; allocated: number }>();

  const plan: any[] = [];
  for (const want of wanted) {
    const match = resolved.find(
      (r) => norm(r.sku) === norm(want.sku)
    ) ?? resolved.find((r) => norm(r.sku).includes(norm(want.sku)));
    if (!match) continue;

    const requested = Math.max(0, Math.floor(want.quantity || 0));
    let toBuild = requested;
    let onHandUtah = 0;
    let onHandGallatin = 0;
    if (input.net_of_on_hand) {
      onHandUtah = Math.max(0, finishedStock.get(match.id) ?? 0);
      onHandGallatin = Math.max(0, gallatin?.get(norm(match.sku)) ?? 0);
      toBuild = Math.max(0, requested - onHandUtah - onHandGallatin);
      // Netting consumes those finished units, so take them out of the pool too.
      pool.set(match.id, Math.max(0, (pool.get(match.id) ?? 0) - Math.min(onHandUtah, requested)));
    }

    explodeShared(match.id, toBuild, raws, assemblies, skuInfo, pool);
    plan.push({
      sku: match.sku,
      name: match.name,
      requested,
      on_hand_utah: input.net_of_on_hand ? onHandUtah : undefined,
      on_hand_gallatin: input.net_of_on_hand ? onHandGallatin : undefined,
      to_build: toBuild,
    });
  }

  // Labor: the final stage for each product plus every sub-assembly shortfall.
  const configs = await prisma.processConfig.findMany({ where: { isActive: true } });
  const labor: Record<string, { units: number; hours: number }> = {};
  const addLabor = (material: string | null, units: number) => {
    if (units <= 0) return;
    const cfg = resolveProcessConfig(material, configs);
    if (!cfg) return;
    const key = cfg.displayName;
    if (!labor[key]) labor[key] = { units: 0, hours: 0 };
    labor[key].units += units;
    labor[key].hours += (units * (cfg.secondsPerUnit || 0)) / 3600;
  };
  for (const p of plan) {
    const info = Array.from(skuInfo.values()).find((s) => s.sku === p.sku);
    addLabor(info?.material ?? null, p.to_build);
  }
  for (const a of assemblies.values()) addLabor(a.material, Math.max(0, a.needed - a.allocated));
  for (const k of Object.keys(labor)) labor[k].hours = Math.round(labor[k].hours * 100) / 100;

  const rawRows = Array.from(raws.values())
    .map((r) => ({ sku: r.sku, name: r.name, needed: r.needed, on_hand: r.allocated, short: Math.max(0, r.needed - r.allocated) }))
    .sort((a, b) => b.short - a.short || a.sku.localeCompare(b.sku));
  const asmRows = Array.from(assemblies.values())
    .map((a) => ({ sku: a.sku, name: a.name, needed: a.needed, on_hand: a.allocated, must_build: Math.max(0, a.needed - a.allocated) }))
    .sort((a, b) => b.must_build - a.must_build || a.sku.localeCompare(b.sku));

  const shortages = rawRows.filter((r) => r.short > 0);
  return {
    plan,
    can_build_everything: shortages.length === 0,
    raw_material_shortages: shortages,
    raw_materials_all: rawRows.slice(0, MAX_ROWS),
    sub_assemblies_to_build: asmRows.filter((a) => a.must_build > 0),
    labor_hours_by_process: labor,
    total_labor_hours: Math.round(Object.values(labor).reduce((s, l) => s + l.hours, 0) * 100) / 100,
    gallatin_error: gallatinError,
    note: "All products draw from one shared stock pool, so a part used by several products is only promised once. The on_hand on each line is the amount ALLOCATED to that need, not total stock. The pool counts every inventory state, including RECEIVED units not yet signed off — same basis as the Forecasting tab.",
  };
}

async function toolGetPurchaseOrders(input: any) {
  const take = clamp(input.limit, 50);
  const where: any = {};
  if (input.status) where.status = input.status;
  else if (input.open_only !== false) where.status = { in: ["SUBMITTED", "IN_ROUTE", "PARTIAL"] };
  if (input.sku) {
    const { rows } = await resolveSkus([input.sku]);
    if (rows.length === 0) return { error: `No SKU matched "${input.sku}"` };
    where.items = { some: { skuId: { in: rows.map((r) => r.id) } } };
  }

  const pos = await prisma.purchaseOrder.findMany({
    where,
    include: {
      items: { include: { sku: { select: { sku: true, name: true } }, manufacturer: { select: { name: true } } } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { submittedAt: "desc" },
    take,
  });

  return {
    count: pos.length,
    purchase_orders: pos.map((po) => ({
      po_number: po.poNumber,
      vendor: po.vendorName,
      status: po.status,
      submitted: ymd(po.submittedAt),
      expected_arrival: ymd(po.estimatedArrival),
      received_at: ymd(po.receivedAt),
      tracking: po.trackingNumber,
      carrier: po.carrier,
      has_variance: po.hasVariance,
      notes: po.notes,
      created_by: `${po.createdBy.firstName} ${po.createdBy.lastName}`,
      items: po.items.map((i) => ({
        sku: i.sku.sku,
        name: i.sku.name,
        manufacturer: i.manufacturer?.name ?? null,
        ordered: i.quantityOrdered,
        received: i.quantityReceived,
        outstanding: Math.max(0, i.quantityOrdered - i.quantityReceived),
        unit_cost: i.unitCost,
      })),
    })),
  };
}

async function toolGetWorkOrders(input: any) {
  const take = clamp(input.limit, 50);
  const where: any = {};
  if (input.status) where.status = input.status;
  const wos = await prisma.workOrder.findMany({
    where,
    include: {
      outputSku: { select: { sku: true, name: true } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return {
    count: wos.length,
    work_orders: wos.map((w) => ({
      order_number: w.orderNumber,
      sku: w.outputSku.sku,
      name: w.outputSku.name,
      status: w.status,
      quantity_to_build: w.quantityToBuild,
      quantity_built: w.quantityBuilt,
      remaining: Math.max(0, w.quantityToBuild - w.quantityBuilt),
      created: ymd(w.createdAt),
      started: ymd(w.startedAt),
      completed: ymd(w.completedAt),
      created_by: `${w.createdBy.firstName} ${w.createdBy.lastName}`,
      notes: w.notes,
    })),
  };
}

async function toolGetTransfers(input: any) {
  const take = clamp(input.limit, 50);
  const days = typeof input.days === "number" ? input.days : 60;
  const where: any = { shippedAt: { gte: new Date(Date.now() - days * 86400000) } };
  if (input.sku) {
    const { rows } = await resolveSkus([input.sku]);
    if (rows.length === 0) return { error: `No SKU matched "${input.sku}"` };
    where.items = { some: { skuId: { in: rows.map((r) => r.id) } } };
  }
  const transfers = await prisma.transfer.findMany({
    where,
    include: {
      items: { include: { sku: { select: { sku: true, name: true } } } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { shippedAt: "desc" },
    take,
  });
  return {
    count: transfers.length,
    window_days: days,
    transfers: transfers.map((t) => ({
      transfer_number: t.transferNumber,
      destination: t.destination,
      shipped: ymd(t.shippedAt),
      tracking: t.trackingNumber,
      carrier: t.carrier,
      shipped_by: `${t.createdBy.firstName} ${t.createdBy.lastName}`,
      total_units: t.items.reduce((s, i) => s + i.quantity, 0),
      items: t.items.map((i) => ({ sku: i.sku.sku, name: i.sku.name, quantity: i.quantity })),
    })),
  };
}

async function toolGetProductionHistory(input: any) {
  const from = dayStart(input.start, 30);
  const to = dayEnd(input.end);
  const where: any = {
    isMisc: false,
    timeEntry: { status: "APPROVED", clockInTime: { gte: from, lte: to } },
  };
  if (input.process) where.processName = { equals: input.process, mode: "insensitive" };
  if (input.sku) {
    const { rows } = await resolveSkus([input.sku]);
    if (rows.length === 0) return { error: `No SKU matched "${input.sku}"` };
    where.skuId = { in: rows.map((r) => r.id) };
  }

  const lines = await prisma.timeEntryLine.findMany({
    where,
    select: {
      quantityCompleted: true, adminAdjustedQuantity: true,
      isRejected: true, rejectionQuantity: true,
      processName: true, expectedSeconds: true,
      sku: { select: { sku: true, name: true } },
      timeEntry: {
        select: { clockInTime: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
    take: 5000,
  });

  const groupBy = input.group_by || "sku";
  const buckets = new Map<string, { key: string; accepted: number; rejected: number; submitted: number; hours: number }>();
  for (const l of lines) {
    const base = l.adminAdjustedQuantity ?? l.quantityCompleted;
    const rejected = l.isRejected ? l.rejectionQuantity ?? base : 0;
    const accepted = Math.max(0, base - rejected);
    const key =
      groupBy === "day" ? (ymd(l.timeEntry.clockInTime) ?? "unknown")
      : groupBy === "process" ? l.processName
      : groupBy === "worker" ? `${l.timeEntry.user.firstName} ${l.timeEntry.user.lastName}`
      : l.sku?.sku ?? "(no SKU)";
    let b = buckets.get(key);
    if (!b) { b = { key, accepted: 0, rejected: 0, submitted: 0, hours: 0 }; buckets.set(key, b); }
    b.accepted += accepted;
    b.rejected += rejected;
    b.submitted += l.quantityCompleted;
    b.hours += (l.expectedSeconds || 0) / 3600;
  }

  const rows = Array.from(buckets.values())
    .map((b) => ({ ...b, hours: Math.round(b.hours * 100) / 100 }))
    .sort((a, b) => (groupBy === "day" ? a.key.localeCompare(b.key) : b.accepted - a.accepted));

  const totalAccepted = rows.reduce((s, r) => s + r.accepted, 0);
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000));
  return {
    from: ymd(from), to: ymd(to), grouped_by: groupBy,
    line_count: lines.length,
    total_accepted_units: totalAccepted,
    avg_accepted_per_day: Math.round((totalAccepted / days) * 10) / 10,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    note: "accepted = submitted (or admin-adjusted) minus QC rejections. hours = expected standard hours for that work, not clocked time.",
  };
}

async function toolGetMovements(input: any) {
  const take = clamp(input.limit, 100);
  const days = typeof input.days === "number" ? input.days : 30;
  const where: any = { createdAt: { gte: new Date(Date.now() - days * 86400000) } };
  if (input.action) where.action = input.action;
  if (input.sku) {
    const { rows } = await resolveSkus([input.sku]);
    if (rows.length === 0) return { error: `No SKU matched "${input.sku}"` };
    where.skuId = { in: rows.map((r) => r.id) };
  }
  const logs = await prisma.inventoryLog.findMany({
    where,
    include: { sku: { select: { sku: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
  const total = await prisma.inventoryLog.count({ where });
  return {
    window_days: days,
    count: logs.length,
    total_matching: total,
    truncated: total > logs.length,
    movements: logs.map((l) => ({
      date: l.createdAt.toISOString(),
      sku: l.sku.sku,
      name: l.sku.name,
      action: l.action,
      quantity: l.quantity,
      from_state: l.fromState,
      to_state: l.toState,
      process: l.processName,
      source: l.relatedResourceType,
      notes: l.notes,
    })),
  };
}

async function toolGetFulfilled(input: any) {
  const from = input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from)
    ? input.from
    : ymd(new Date(Date.now() - 30 * 86400000))!;
  const to = input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : ymd(new Date())!;
  try {
    const items = await withTimeout(getFulfilledInRange(from, to), "Shopify fulfilled orders");
    const report = aggregateFulfilled(items, from, to);
    const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
    return {
      from: report.from,
      to: report.to,
      days,
      total_orders: report.totalOrders,
      total_units: report.totalUnits,
      units_per_day: Math.round((report.totalUnits / days) * 10) / 10,
      gallatin_shiphero: report.shiphero,
      utah_in_house: report.utah,
      store_units: report.storeUnits,
      by_sku: report.bySku.slice(0, MAX_ROWS),
      by_service: report.byService,
    };
  } catch (err) {
    return { error: `Could not reach Shopify: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function toolGetLaborCapacity(input: any) {
  const start = input.start && /^\d{4}-\d{2}-\d{2}$/.test(input.start) ? new Date(`${input.start}T00:00:00`) : new Date();
  const end = input.end && /^\d{4}-\d{2}-\d{2}$/.test(input.end)
    ? new Date(`${input.end}T23:59:59`)
    : new Date(Date.now() + 7 * 86400000);
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));

  const [configs, workers] = await Promise.all([
    prisma.processConfig.findMany({ where: { isActive: true }, orderBy: { processOrder: "asc" } }),
    prisma.user.findMany({
      where: { role: "WORKER", isActive: true },
      select: {
        firstName: true, lastName: true,
        schedules: { where: { isActive: true, scheduleType: "RECURRING" }, select: { startTime: true, endTime: true } },
      },
    }),
  ]);

  const parseTime = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h || 0) + (m || 0) / 60;
  };
  const perWorker = workers.map((w) => {
    const weekly = w.schedules.reduce((sum, s) => sum + Math.max(0, parseTime(s.endTime) - parseTime(s.startTime)), 0);
    return {
      worker: `${w.firstName} ${w.lastName}`,
      scheduled_hours_per_week: Math.round(weekly * 10) / 10,
      hours_in_window: Math.round(((weekly / 7) * days) * 10) / 10,
    };
  });

  return {
    from: ymd(start), to: ymd(end), days,
    total_scheduled_labor_hours: Math.round(perWorker.reduce((s, w) => s + w.hours_in_window, 0) * 10) / 10,
    workers: perWorker,
    processes: configs.map((c) => ({
      process: c.displayName,
      internal_name: c.processName,
      seconds_per_unit: c.secondsPerUnit,
      units_per_hour: c.secondsPerUnit > 0 ? Math.round(3600 / c.secondsPerUnit) : null,
      consumes_state: c.consumesState,
      produces_state: c.producesState,
      order: c.processOrder,
    })),
    note: "Scheduled hours come from active recurring worker schedules, prorated across the window. It is capacity on paper, not clocked time.",
  };
}

// ============================================================
// Dispatch
// ============================================================

const HANDLERS: Record<string, (input: any) => Promise<unknown>> = {
  search_skus: toolSearchSkus,
  get_inventory: toolGetInventory,
  get_sku_detail: toolGetSkuDetail,
  get_unfulfilled_orders: toolGetUnfulfilled,
  get_programmed_orders: toolGetProgrammed,
  get_build_capacity: toolGetBuildCapacity,
  simulate_build: toolSimulateBuild,
  get_purchase_orders: toolGetPurchaseOrders,
  get_work_orders: toolGetWorkOrders,
  get_transfers: toolGetTransfers,
  get_production_history: toolGetProductionHistory,
  get_inventory_movements: toolGetMovements,
  get_fulfilled_orders: toolGetFulfilled,
  get_labor_capacity: toolGetLaborCapacity,
};

/**
 * Run one tool call. Never throws — a failed tool comes back as an error
 * payload so the assistant can explain the gap instead of the chat 500ing.
 */
export async function runAiTool(
  name: string,
  input: unknown
): Promise<{ ok: boolean; result: string }> {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, result: JSON.stringify({ error: `Unknown tool "${name}"` }) };
  try {
    const value = await handler((input ?? {}) as any);
    return { ok: true, result: JSON.stringify(value) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-chat] tool ${name} failed:`, message);
    return { ok: false, result: JSON.stringify({ error: message }) };
  }
}
