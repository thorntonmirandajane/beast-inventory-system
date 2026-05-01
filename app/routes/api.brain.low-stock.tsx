import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { requireBrainAuth } from "../utils/brain-auth.server";

// GET /api/brain/low-stock?threshold=10&type=COMPLETED
//
// Returns SKUs whose ready-to-ship (InventoryState.COMPLETED) inventory is at or below
// the threshold. Defaults to threshold=10. Filters out inactive SKUs and any non-finished-good
// types unless ?type=ALL is passed; default scope is COMPLETED-type SKUs (final products).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = requireBrainAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const threshold = Math.max(0, parseInt(url.searchParams.get("threshold") || "10", 10) || 10);
  const typeParam = (url.searchParams.get("type") || "COMPLETED").toUpperCase();
  const allowedTypes = ["RAW", "ASSEMBLY", "COMPLETED"];
  const type = allowedTypes.includes(typeParam) ? typeParam : null; // null = all types

  const skus = await prisma.sku.findMany({
    where: {
      isActive: true,
      ...(type ? { type: type as "RAW" | "ASSEMBLY" | "COMPLETED" } : {}),
    },
    select: {
      sku: true,
      name: true,
      type: true,
      category: true,
      inventoryItems: { select: { state: true, quantity: true } },
    },
  });

  const rows = skus
    .map((s) => {
      const ready = s.inventoryItems
        .filter((i) => i.state === "COMPLETED")
        .reduce((sum, i) => sum + i.quantity, 0);
      const onHand = s.inventoryItems
        .filter((i) => i.state !== "TRANSFERRED")
        .reduce((sum, i) => sum + i.quantity, 0);
      return {
        sku: s.sku,
        name: s.name,
        type: s.type,
        category: s.category,
        ready_to_ship: ready,
        on_hand_total: onHand,
      };
    })
    .filter((r) => r.ready_to_ship <= threshold)
    .sort((a, b) => a.ready_to_ship - b.ready_to_ship);

  return Response.json({
    as_of: new Date().toISOString(),
    threshold,
    type_filter: type || "ALL",
    count: rows.length,
    skus: rows,
  });
};
