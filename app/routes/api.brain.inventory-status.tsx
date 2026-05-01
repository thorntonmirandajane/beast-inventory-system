import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { requireBrainAuth } from "../utils/brain-auth.server";

// GET /api/brain/inventory-status?sku=COC-TI-3PACK-100g-2.0in
//
// Returns on-hand inventory broken out by state for one SKU (?sku=...) or all active SKUs.
// States from the InventoryState enum: RECEIVED, RAW, ASSEMBLED, COMPLETED, TRANSFERRED.
// COMPLETED is "ready to ship"; RAW/ASSEMBLED is in-progress; TRANSFERRED has already left.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = requireBrainAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku") || undefined;
  const includeInactive = url.searchParams.get("include_inactive") === "true";

  const skuWhere: Record<string, unknown> = { isActive: includeInactive ? undefined : true };
  if (sku) skuWhere.sku = sku;

  const skus = await prisma.sku.findMany({
    where: skuWhere,
    select: {
      id: true,
      sku: true,
      name: true,
      type: true,
      category: true,
      isActive: true,
      inventoryItems: {
        select: { state: true, quantity: true, location: true },
      },
    },
    orderBy: { sku: "asc" },
    take: sku ? 1 : 1000,
  });

  const rows = skus.map((s) => {
    const totals: Record<string, number> = {
      RECEIVED: 0, RAW: 0, ASSEMBLED: 0, COMPLETED: 0, TRANSFERRED: 0,
    };
    for (const item of s.inventoryItems) {
      totals[item.state] = (totals[item.state] || 0) + item.quantity;
    }
    const onHand = totals.RECEIVED + totals.RAW + totals.ASSEMBLED + totals.COMPLETED;
    return {
      sku: s.sku,
      name: s.name,
      type: s.type,
      category: s.category,
      is_active: s.isActive,
      on_hand_total: onHand,
      ready_to_ship: totals.COMPLETED,
      received_unprocessed: totals.RECEIVED,
      raw: totals.RAW,
      in_assembly: totals.ASSEMBLED,
      transferred_out: totals.TRANSFERRED,
    };
  });

  if (sku) {
    if (rows.length === 0) {
      return Response.json({ error: `No SKU matching "${sku}"` }, { status: 404 });
    }
    return Response.json({ as_of: new Date().toISOString(), inventory: rows[0] });
  }

  return Response.json({
    as_of: new Date().toISOString(),
    count: rows.length,
    inventory: rows,
  });
};
