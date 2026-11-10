// STG available stock, by SKU, for external callers (the Dealer Orders app's
// SPS tab). "STG" = our in-house warehouse, tracked right here in the DB:
// available = COMPLETED-state InventoryItem quantity for a finished-goods
// (COMPLETED-type) SKU. This mirrors how the Backorder page reads STG stock.
//
// Incoming SKUs are the Shopify/dealer spellings, so we resolve them to our
// system SKU via the same alias/pattern mapping the Backorder engine uses.

import prisma from "../db.server";
import { loadMapping, resolveSku } from "./backorder.server";

const norm = (s: string) => s.trim().toUpperCase();

export interface StgStockResult {
  // Keyed by the caller's SKU (normalized). Value is available STG units, or
  // null when the SKU isn't a finished-goods item we track (so the caller can
  // show "—" rather than a misleading 0).
  stock: Record<string, number | null>;
}

export async function getStgAvailableForSkus(
  inputSkus: string[],
): Promise<StgStockResult> {
  const wanted = Array.from(new Set(inputSkus.map((s) => norm(s)).filter(Boolean)));
  const stock: Record<string, number | null> = {};
  if (wanted.length === 0) return { stock };

  // Completed (finished-goods) SKUs with their COMPLETED-state inventory.
  const skus = await prisma.sku.findMany({
    where: { type: "COMPLETED" },
    select: {
      id: true,
      sku: true,
      inventoryItems: {
        where: { state: "COMPLETED" },
        select: { quantity: true },
      },
    },
  });

  const stgById = new Map<string, number>();
  const skuIdBySku = new Map<string, string>();
  for (const s of skus) {
    skuIdBySku.set(norm(s.sku), s.id);
    const qty = s.inventoryItems.reduce((sum, i) => sum + i.quantity, 0);
    stgById.set(s.id, Math.max(0, qty));
  }

  const mapping = await loadMapping();
  for (const raw of wanted) {
    const id = resolveSku(raw, mapping, skuIdBySku);
    stock[raw] = id ? stgById.get(id) ?? 0 : null;
  }

  return { stock };
}
