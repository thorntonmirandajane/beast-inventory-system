// ============================================================================
// Shopify SKU handling for the fulfillment views — Unfulfilled, Game plans and
// Compare plans. These three only.
//
// Backorder and Build Plan have their own SkuAlias / BackorderExclusion rules
// and are untouched by anything here. The two sets are deliberately separate,
// so a mapping entered for fulfillment can't quietly move the Backorder
// numbers, and vice versa.
//
// Nothing is inferred. A Shopify SKU with no row is still counted as demand —
// Beast Inventory only tracks what's manufactured here, while Gallatin stocks
// plenty more that sells and ships perfectly well. All a missing row means is
// that there's no Utah stock to check it against.
//
// Two things a row can do:
//   · map a Shopify SKU to the inventory SKU it means (so Utah stock matches)
//   · ignore it entirely (digital goods, services, anything that isn't picked)
// ============================================================================

import prisma from "../db.server";

export const normSku = (s: string) => s.trim().toUpperCase();

/** Order Defense is a digital add-on; it is never a line anyone picks. */
export const isOrderDefenseSku = (sku: string) => /^OD\d*$/i.test(sku.trim());

export interface SkuResolution {
  /** The inventory SKU this maps to, or null when it isn't something we make. */
  inventorySku: string | null;
  inventoryName: string | null;
  /** Set only when the line should be left out of the numbers. */
  skip: "ORDER_DEFENSE" | "IGNORED" | null;
  ignoreNote?: string | null;
  /** True when a hand-entered mapping changed the SKU. */
  remapped: boolean;
}

export interface SkuMap {
  resolve(rawSku: string): SkuResolution;
  summary: { mapped: number; ignored: number };
}

const TTL_MS = 30 * 1000;
let cache: { at: number; value: SkuMap } | null = null;

export function clearSkuMapCache() {
  cache = null;
}

export async function loadSkuMap(opts: { force?: boolean } = {}): Promise<SkuMap> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const [rows, skus] = await Promise.all([
    prisma.fulfillmentSkuMap.findMany({
      select: { shopifySku: true, inventorySku: true, ignore: true, note: true },
    }),
    prisma.sku.findMany({ select: { sku: true, name: true } }),
  ]);

  const nameBySku = new Map(skus.map((s) => [normSku(s.sku), s]));
  const byShopify = new Map(rows.map((r) => [normSku(r.shopifySku), r]));

  const value: SkuMap = {
    summary: {
      mapped: rows.filter((r) => !r.ignore && r.inventorySku).length,
      ignored: rows.filter((r) => r.ignore).length,
    },
    resolve(rawSku: string): SkuResolution {
      const raw = (rawSku || "").trim();
      const miss: SkuResolution = { inventorySku: null, inventoryName: null, skip: null, remapped: false };
      if (!raw) return miss;
      const key = normSku(raw);

      const row = byShopify.get(key);
      if (row?.ignore) {
        return { ...miss, skip: "IGNORED", ignoreNote: row.note ?? null };
      }
      // Order Defense is the one standing rule, because it's a digital product
      // rather than a judgement call. Add a row for it to override.
      if (!row && isOrderDefenseSku(raw)) {
        return { ...miss, skip: "ORDER_DEFENSE" };
      }

      if (row?.inventorySku) {
        const rec = nameBySku.get(normSku(row.inventorySku));
        return {
          inventorySku: rec?.sku ?? row.inventorySku,
          inventoryName: rec?.name ?? null,
          skip: null,
          remapped: normSku(row.inventorySku) !== key,
        };
      }

      // No row — if the code happens to BE one of ours, use it; otherwise it's
      // a Gallatin-stocked item and we simply have no Utah stock for it.
      const direct = nameBySku.get(key);
      if (direct) {
        return { inventorySku: direct.sku, inventoryName: direct.name, skip: null, remapped: false };
      }
      return miss;
    },
  };

  cache = { at: Date.now(), value };
  return value;
}
