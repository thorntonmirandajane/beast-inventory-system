import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { requireBrainAuth } from "../utils/brain-auth.server";

// GET /api/brain/open-purchase-orders?vendor=...
//
// Open POs = status SUBMITTED / PARTIAL / APPROVED (i.e. not RECEIVED, not CANCELLED).
// Each row shows what's coming in, the ETA, and per-item ordered/received quantities so
// the brain can answer "what's still on order?" or "when's the next batch of X arriving?".
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = requireBrainAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const vendor = url.searchParams.get("vendor") || undefined;

  const where: Record<string, unknown> = {
    status: { in: ["SUBMITTED", "PARTIAL", "APPROVED"] },
  };
  if (vendor) where.vendorName = { contains: vendor, mode: "insensitive" };

  const pos = await prisma.purchaseOrder.findMany({
    where,
    orderBy: [{ estimatedArrival: "asc" }, { submittedAt: "desc" }],
    include: {
      items: {
        select: {
          quantityOrdered: true,
          quantityReceived: true,
          notes: true,
          sku: { select: { sku: true, name: true } },
          manufacturer: { select: { name: true } },
        },
      },
    },
  });

  const rows = pos.map((po) => {
    const totalOrdered = po.items.reduce((s, i) => s + i.quantityOrdered, 0);
    const totalReceived = po.items.reduce((s, i) => s + i.quantityReceived, 0);
    return {
      po_number: po.poNumber,
      vendor: po.vendorName,
      status: po.status,
      submitted_at: po.submittedAt,
      estimated_arrival: po.estimatedArrival,
      received_at: po.receivedAt,
      notes: po.notes,
      total_units_ordered: totalOrdered,
      total_units_received: totalReceived,
      total_units_outstanding: totalOrdered - totalReceived,
      items: po.items.map((i) => ({
        sku: i.sku.sku,
        product: i.sku.name,
        manufacturer: i.manufacturer?.name || null,
        ordered: i.quantityOrdered,
        received: i.quantityReceived,
        outstanding: i.quantityOrdered - i.quantityReceived,
        notes: i.notes,
      })),
    };
  });

  return Response.json({
    as_of: new Date().toISOString(),
    count: rows.length,
    purchase_orders: rows,
  });
};
