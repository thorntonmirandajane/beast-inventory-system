// Utah fulfillment auto-deduction.
//
// As Utah (in-house) ships orders on either Shopify store, this deducts the
// matching COMPLETED packs from inventory so you don't have to reconcile by
// hand. It's fully idempotent: every deducted fulfillment line is recorded in
// FulfillmentDeduction keyed by (store, fulfillmentId, sku), so re-running can
// never double-deduct. ShipHero/Gallatin fulfillments are ignored (they ship
// from Gallatin's own stock).

import prisma from "../db.server";
import { getFulfilledInRange } from "./shopify.server";
import { deductInventory } from "./inventory.server";

const SYNC_ID = "utah";
const BUFFER_DAYS = 2; // re-scan a couple days back to catch late-registered fulfillments

const MT_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const mtDay = (d: Date) => MT_DAY.format(d);
const mtToday = () => mtDay(new Date());
const norm = (s: string) => s.trim().toUpperCase();
// Noon UTC on a YMD is always the same MT calendar day (MT is UTC-6/-7).
const ymdToDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const storeLabel = (store: string) =>
  store === "archery" ? "Bowmar Archery" : store === "beast" ? "Beast" : store;

export type SyncResult = {
  ran: boolean;
  reason?: string;
  fromYmd: string;
  toYmd: string;
  startYmd: string;
  deducted: { sku: string; quantity: number }[];
  deductedUnits: number;
  unmatched: { sku: string; quantity: number }[];
  alreadyProcessed: number;
  transfers: { store: string; label: string; id: string; number: string; units: number }[];
};

export async function getSyncState() {
  return prisma.fulfillmentSync.findUnique({ where: { id: SYNC_ID } });
}

/**
 * Run the Utah auto-deduction. On the very first run, `startYmd` sets the
 * baseline — nothing fulfilled before it is ever processed (so we don't
 * retroactively deduct history already reconciled). Defaults to today.
 */
export async function runFulfillmentSync(
  userId: string,
  opts?: { startYmd?: string }
): Promise<SyncResult> {
  let state = await prisma.fulfillmentSync.findUnique({ where: { id: SYNC_ID } });
  if (!state) {
    const startYmd = opts?.startYmd || mtToday();
    state = await prisma.fulfillmentSync.create({
      data: { id: SYNC_ID, startAt: ymdToDate(startYmd) },
    });
  }

  const startYmd = mtDay(state.startAt);
  const toYmd = mtToday();

  // Window start: a buffer before the last run, but never before the baseline.
  let fromYmd = startYmd;
  if (state.lastRunAt) {
    const buffered = mtDay(new Date(state.lastRunAt.getTime() - BUFFER_DAYS * 86400000));
    fromYmd = buffered > startYmd ? buffered : startYmd;
  }

  const empty: SyncResult = {
    ran: true, fromYmd, toYmd, startYmd,
    deducted: [], deductedUnits: 0, unmatched: [], alreadyProcessed: 0, transfers: [],
  };

  if (fromYmd > toYmd) {
    return { ...empty, ran: false, reason: `Baseline ${startYmd} is in the future.` };
  }

  // 1. Pull fresh Utah fulfillments in the window (both stores).
  const items = (await getFulfilledInRange(fromYmd, toYmd, { fresh: true })).filter(
    (i) => i.channel === "utah" && mtDay(new Date(i.fulfilledAt)) >= startYmd
  );

  // 2. Collapse to one row per (store, fulfillmentId, sku), summing quantity.
  const byKey = new Map<
    string,
    { store: string; fulfillmentId: string; sku: string; quantity: number; orderName: string; fulfilledAt: string }
  >();
  for (const i of items) {
    const key = `${i.store}|${i.fulfillmentId}|${i.sku}`;
    const cur = byKey.get(key);
    if (cur) cur.quantity += i.quantity;
    else byKey.set(key, {
      store: i.store, fulfillmentId: i.fulfillmentId, sku: i.sku,
      quantity: i.quantity, orderName: i.orderName, fulfilledAt: i.fulfilledAt,
    });
  }

  // 3. Drop anything already in the ledger (the idempotency guarantee).
  const fulfillmentIds = [...new Set([...byKey.values()].map((v) => v.fulfillmentId))];
  const existing = fulfillmentIds.length
    ? await prisma.fulfillmentDeduction.findMany({
        where: { fulfillmentId: { in: fulfillmentIds } },
        select: { store: true, fulfillmentId: true, sku: true },
      })
    : [];
  const seen = new Set(existing.map((e) => `${e.store}|${e.fulfillmentId}|${e.sku}`));

  const fresh = [...byKey.entries()].filter(([k]) => !seen.has(k)).map(([, v]) => v);
  const alreadyProcessed = byKey.size - fresh.length;

  if (fresh.length === 0) {
    await prisma.fulfillmentSync.update({ where: { id: SYNC_ID }, data: { lastRunAt: new Date() } });
    return { ...empty, alreadyProcessed };
  }

  // 4. Match to active COMPLETED system SKUs (case-insensitive).
  const completed = await prisma.sku.findMany({
    where: { isActive: true, type: "COMPLETED" },
    select: { id: true, sku: true },
  });
  const bySku = new Map(completed.map((s) => [norm(s.sku), s]));

  const matched: (typeof fresh[number] & { skuId: string; systemSku: string })[] = [];
  const unmatchedRows: typeof fresh = [];
  for (const f of fresh) {
    const m = bySku.get(norm(f.sku));
    if (m) matched.push({ ...f, skuId: m.id, systemSku: m.sku });
    else unmatchedRows.push(f);
  }

  const transfers: SyncResult["transfers"] = [];
  const fulfilledFrom = ymdToDate(fromYmd);

  await prisma.$transaction(async (tx) => {
    const now = new Date();

    // One auto Transfer per store, deducting the aggregated packs.
    const stores = [...new Set(matched.map((m) => m.store))];
    const transferIdByStore = new Map<string, string>();

    for (const store of stores) {
      const rows = matched.filter((m) => m.store === store);
      // Aggregate per system SKU for clean Transfer items.
      const perSku = new Map<string, { systemSku: string; qty: number }>();
      for (const r of rows) {
        const cur = perSku.get(r.skuId);
        if (cur) cur.qty += r.quantity;
        else perSku.set(r.skuId, { systemSku: r.systemSku, qty: r.quantity });
      }

      const transfer = await tx.transfer.create({
        data: {
          destination: `Utah Fulfillment — ${storeLabel(store)}`,
          createdById: userId,
          shippedAt: now,
          fulfilledFrom,
          fulfilledTo: now,
          notes: `Auto-deducted from ${rows.length} ${storeLabel(store)} Shopify fulfillment(s).`,
          items: {
            create: [...perSku.entries()].map(([skuId, v]) => ({ skuId, quantity: v.qty })),
          },
        },
      });
      transferIdByStore.set(store, transfer.id);

      let units = 0;
      for (const [skuId, v] of perSku) {
        await deductInventory(skuId, v.qty, ["COMPLETED"], transfer.id, "TRANSFER", "FULFILLMENT_SYNC", userId, tx);
        units += v.qty;
      }
      transfers.push({ store, label: storeLabel(store), id: transfer.id, number: transfer.transferNumber, units });
    }

    // Record every processed line in the idempotency ledger.
    await tx.fulfillmentDeduction.createMany({
      skipDuplicates: true,
      data: [
        ...matched.map((m) => ({
          store: m.store, fulfillmentId: m.fulfillmentId, sku: m.sku, skuId: m.skuId,
          quantity: m.quantity, orderName: m.orderName, fulfilledAt: new Date(m.fulfilledAt),
          status: "DEDUCTED", transferId: transferIdByStore.get(m.store) ?? null,
        })),
        ...unmatchedRows.map((u) => ({
          store: u.store, fulfillmentId: u.fulfillmentId, sku: u.sku, skuId: null,
          quantity: u.quantity, orderName: u.orderName, fulfilledAt: new Date(u.fulfilledAt),
          status: "UNMATCHED", transferId: null,
        })),
      ],
    });

    await tx.fulfillmentSync.update({ where: { id: SYNC_ID }, data: { lastRunAt: now } });
  }, { timeout: 120000, maxWait: 15000 });

  // 5. Summaries for the UI.
  const deductedMap = new Map<string, number>();
  for (const m of matched) deductedMap.set(m.systemSku, (deductedMap.get(m.systemSku) ?? 0) + m.quantity);
  const unmatchedMap = new Map<string, number>();
  for (const u of unmatchedRows) unmatchedMap.set(u.sku, (unmatchedMap.get(u.sku) ?? 0) + u.quantity);

  const deducted = [...deductedMap.entries()].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => b.quantity - a.quantity);
  const unmatched = [...unmatchedMap.entries()].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => b.quantity - a.quantity);

  return {
    ran: true, fromYmd, toYmd, startYmd,
    deducted,
    deductedUnits: deducted.reduce((s, d) => s + d.quantity, 0),
    unmatched,
    alreadyProcessed,
    transfers,
  };
}
