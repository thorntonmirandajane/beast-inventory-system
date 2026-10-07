// ============================================================================
// Shopify SKU → inventory SKU mapping, shared by every Operations view.
//
// Store SKUs and inventory SKUs don't always agree: practice tips carry a
// slightly different code in Shopify, Trump variants use a different prefix,
// and some things sold on the store — Order Defense, for one — aren't physical
// stock at all and should never show up as demand.
//
// The Backorder tab already had this logic and its own admin screen for
// managing it. It lives here now so Unfulfilled, Game Plans and Compare Plans
// resolve SKUs exactly the same way, instead of each reading raw Shopify codes
// and quietly disagreeing with the others.
//
// Resolution order, same as it always was:
//   1. an exact alias someone entered
//   2. a direct hit on a real inventory SKU
//   3. a wildcard rewrite rule ("MG-*-BEAST" → "MG-3PACK-*")
// Nothing matches → unmapped, and the caller decides whether to surface it.
// ============================================================================

import prisma from "../db.server";

export const normSku = (s: string) => s.trim().toUpperCase();

/** Digital add-on sold on the store; never a physical line to pick. */
export const isOrderDefenseSku = (sku: string) => /^OD\d*$/i.test(sku.trim());

export interface SkuResolution {
  /** The inventory SKU code this maps to, or null when nothing matches. */
  sku: string | null;
  skuId: string | null;
  name: string | null;
  /** Why this line isn't being counted, when it isn't. */
  skip: "ORDER_DEFENSE" | "EXCLUDED" | null;
  excludedReason?: string | null;
  /** True when the Shopify code differs from the inventory code. */
  remapped: boolean;
}

export interface SkuMap {
  resolve(rawSku: string): SkuResolution;
  /** Every alias and exclusion in play, for showing on screen. */
  summary: { aliases: number; patterns: number; exclusions: number };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(.*)");
  return new RegExp(`^${escaped}$`, "i");
}

function applyReplacement(replacement: string, groups: string[]): string {
  let i = 0;
  return replacement.replace(/\*/g, () => groups[i++] ?? "");
}

const TTL_MS = 60 * 1000;
let cache: { at: number; value: SkuMap } | null = null;

export function clearSkuMapCache() {
  cache = null;
}

export async function loadSkuMap(opts: { force?: boolean } = {}): Promise<SkuMap> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const [aliases, exclusions, skus] = await Promise.all([
    prisma.skuAlias.findMany({ select: { alias: true, skuId: true, isPattern: true, replacement: true } }),
    prisma.backorderExclusion.findMany({ select: { sku: true, reason: true } }),
    prisma.sku.findMany({ select: { id: true, sku: true, name: true } }),
  ]);

  const byId = new Map(skus.map((s) => [s.id, s]));
  const idBySku = new Map(skus.map((s) => [normSku(s.sku), s.id]));
  const exact = new Map<string, string>();
  const patterns: { regex: RegExp; replacement: string }[] = [];
  for (const a of aliases) {
    if (a.isPattern && a.replacement) patterns.push({ regex: patternToRegex(a.alias), replacement: a.replacement });
    else if (!a.isPattern && a.skuId) exact.set(normSku(a.alias), a.skuId);
  }
  const excluded = new Map(exclusions.map((e) => [normSku(e.sku), e.reason ?? null]));

  const miss: SkuResolution = { sku: null, skuId: null, name: null, skip: null, remapped: false };

  const value: SkuMap = {
    summary: { aliases: exact.size, patterns: patterns.length, exclusions: excluded.size },
    resolve(rawSku: string): SkuResolution {
      const raw = (rawSku || "").trim();
      if (!raw) return miss;
      const key = normSku(raw);

      if (isOrderDefenseSku(raw)) {
        return { ...miss, skip: "ORDER_DEFENSE" };
      }

      const hit = (id: string): SkuResolution => {
        const rec = byId.get(id);
        if (!rec) return miss;
        // An exclusion can be written against either spelling.
        if (excluded.has(key) || excluded.has(normSku(rec.sku))) {
          return {
            sku: rec.sku, skuId: rec.id, name: rec.name, skip: "EXCLUDED",
            excludedReason: excluded.get(key) ?? excluded.get(normSku(rec.sku)) ?? null,
            remapped: normSku(rec.sku) !== key,
          };
        }
        return { sku: rec.sku, skuId: rec.id, name: rec.name, skip: null, remapped: normSku(rec.sku) !== key };
      };

      const aliased = exact.get(key);
      if (aliased) return hit(aliased);

      const direct = idBySku.get(key);
      if (direct) return hit(direct);

      for (const p of patterns) {
        const m = p.regex.exec(raw);
        if (m) {
          const candidate = applyReplacement(p.replacement, m.slice(1));
          const id = idBySku.get(normSku(candidate));
          if (id) return hit(id);
        }
      }

      // Unknown to inventory, but an exclusion may still name it directly.
      if (excluded.has(key)) {
        return { ...miss, skip: "EXCLUDED", excludedReason: excluded.get(key) ?? null };
      }
      return miss;
    },
  };

  cache = { at: Date.now(), value };
  return value;
}
