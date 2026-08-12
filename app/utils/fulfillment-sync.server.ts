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
const stripNorm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
  opts?: { startYmd?: string; dryRun?: boolean }
): Promise<SyncResult> {
  const dryRun = !!opts?.dryRun;
  const state = await prisma.fulfillmentSync.findUnique({ where: { id: SYNC_ID } });

  // Baseline: existing state, else today (or a caller-supplied start). Not
  // persisted during a dry-run preview — only a committed run establishes it.
  const startYmd = state ? mtDay(state.startAt) : opts?.startYmd || mtToday();
  const lastRunAt = state?.lastRunAt ?? null;
  const toYmd = mtToday();

  // Window start: a buffer before the last run, but never before the baseline.
  let fromYmd = startYmd;
  if (lastRunAt) {
    const buffered = mtDay(new Date(lastRunAt.getTime() - BUFFER_DAYS * 86400000));
    fromYmd = buffered > startYmd ? buffered : startYmd;
  }

  // Advance the checkpoint (creating the baseline row on the first committed run).
  const touchLastRun = async () => {
    await prisma.fulfillmentSync.upsert({
      where: { id: SYNC_ID },
      update: { lastRunAt: new Date() },
      create: { id: SYNC_ID, startAt: ymdToDate(startYmd), lastRunAt: new Date() },
    });
  };

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
    if (!dryRun) await touchLastRun();
    return { ...empty, alreadyProcessed };
  }

  // 4. Match to active COMPLETED system SKUs (case-insensitive), plus any learned
  //    aliases (e.g. "PT 3packs" -> a real SKU) confirmed earlier.
  const completed = await prisma.sku.findMany({
    where: { isActive: true, type: "COMPLETED" },
    select: { id: true, sku: true },
  });
  const idToSku = new Map(completed.map((s) => [s.id, s.sku]));
  const bySku = new Map(completed.map((s) => [norm(s.sku), { id: s.id, sku: s.sku }]));
  const aliases = await prisma.skuAlias.findMany();
  for (const a of aliases) {
    const sysSku = idToSku.get(a.skuId);
    if (sysSku) bySku.set(a.alias, { id: a.skuId, sku: sysSku });
  }

  const matched: (typeof fresh[number] & { skuId: string; systemSku: string })[] = [];
  const unmatchedRows: typeof fresh = [];
  for (const f of fresh) {
    const m = bySku.get(norm(f.sku));
    if (m) matched.push({ ...f, skuId: m.id, systemSku: m.sku });
    else unmatchedRows.push(f);
  }

  const transfers: SyncResult["transfers"] = [];
  const fulfilledFrom = ymdToDate(fromYmd);

  // Dry-run preview: aggregate what WOULD be deducted, write nothing.
  if (dryRun) {
    const deductedMapP = new Map<string, number>();
    for (const m of matched) deductedMapP.set(m.systemSku, (deductedMapP.get(m.systemSku) ?? 0) + m.quantity);
    const unmatchedMapP = new Map<string, number>();
    for (const u of unmatchedRows) unmatchedMapP.set(u.sku, (unmatchedMapP.get(u.sku) ?? 0) + u.quantity);
    for (const store of [...new Set(matched.map((m) => m.store))]) {
      const units = matched.filter((m) => m.store === store).reduce((s, r) => s + r.quantity, 0);
      transfers.push({ store, label: storeLabel(store), id: "", number: "(preview)", units });
    }
    const deductedP = [...deductedMapP.entries()].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => b.quantity - a.quantity);
    const unmatchedP = [...unmatchedMapP.entries()].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => b.quantity - a.quantity);
    return {
      ran: true, fromYmd, toYmd, startYmd,
      deducted: deductedP,
      deductedUnits: deductedP.reduce((s, d) => s + d.quantity, 0),
      unmatched: unmatchedP,
      alreadyProcessed,
      transfers,
    };
  }

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

  }, { timeout: 120000, maxWait: 15000 });

  await touchLastRun();

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

// ---- Suggestions + alias mapping for unmatched SKUs ----

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Closest COMPLETED SKU to an unmatched Shopify SKU, if reasonably close. */
export function suggestSku(
  aliasRaw: string,
  candidates: { id: string; sku: string }[]
): { id: string; sku: string } | null {
  const a = stripNorm(aliasRaw);
  if (!a) return null;
  let best: { id: string; sku: string } | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(a, stripNorm(c.sku));
    if (d < bestScore) { bestScore = d; best = c; }
  }
  if (!best) return null;
  const maxLen = Math.max(a.length, stripNorm(best.sku).length);
  return bestScore <= Math.max(3, Math.floor(maxLen * 0.5)) ? best : null;
}

/**
 * Save an alias (Shopify SKU spelling -> system SKU) and immediately deduct any
 * fulfillments that were previously logged UNMATCHED under that spelling. Future
 * syncs match it automatically via the alias.
 */
export async function mapAliasAndDeduct(userId: string, aliasRaw: string, skuId: string) {
  const alias = norm(aliasRaw);
  const sku = await prisma.sku.findUnique({ where: { id: skuId }, select: { id: true, sku: true, type: true } });
  if (!sku) throw new Error("SKU not found.");
  if (sku.type !== "COMPLETED") throw new Error("Alias must map to a COMPLETED product.");

  await prisma.skuAlias.upsert({
    where: { alias },
    update: { skuId },
    create: { alias, skuId },
  });

  const rows = (
    await prisma.fulfillmentDeduction.findMany({ where: { status: "UNMATCHED" } })
  ).filter((r) => norm(r.sku) === alias);

  const transfers: { store: string; label: string; number: string; units: number }[] = [];
  if (rows.length > 0) {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const store of [...new Set(rows.map((r) => r.store))]) {
        const storeRows = rows.filter((r) => r.store === store);
        const units = storeRows.reduce((s, r) => s + r.quantity, 0);
        const transfer = await tx.transfer.create({
          data: {
            destination: `Utah Fulfillment — ${storeLabel(store)}`,
            createdById: userId,
            shippedAt: now,
            fulfilledTo: now,
            notes: `Auto-deducted after mapping ${sku.sku} (${storeRows.length} previously-unmatched fulfillment(s)).`,
            items: { create: [{ skuId: sku.id, quantity: units }] },
          },
        });
        await deductInventory(sku.id, units, ["COMPLETED"], transfer.id, "TRANSFER", "FULFILLMENT_SYNC", userId, tx);
        await tx.fulfillmentDeduction.updateMany({
          where: { id: { in: storeRows.map((r) => r.id) } },
          data: { status: "DEDUCTED", skuId: sku.id, transferId: transfer.id },
        });
        transfers.push({ store, label: storeLabel(store), number: transfer.transferNumber, units });
      }
    }, { timeout: 120000, maxWait: 15000 });
  }

  return { mapped: sku.sku, alias, deductedUnits: transfers.reduce((s, t) => s + t.units, 0), transfers };
}
