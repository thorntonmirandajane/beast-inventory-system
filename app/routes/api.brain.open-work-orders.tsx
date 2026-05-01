import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { requireBrainAuth } from "../utils/brain-auth.server";

// GET /api/brain/open-work-orders?sku=...
//
// Open WOs = status PENDING / IN_PROGRESS (not COMPLETED, not CANCELLED). Each row shows
// the output SKU being produced, target qty, qty already built, and progress %.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = requireBrainAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku") || undefined;

  const where: Record<string, unknown> = {
    status: { in: ["PENDING", "IN_PROGRESS"] },
  };
  if (sku) where.outputSku = { sku };

  const wos = await prisma.workOrder.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    include: {
      outputSku: { select: { sku: true, name: true, type: true } },
    },
  });

  const rows = wos.map((wo) => {
    const remaining = Math.max(0, wo.quantityToBuild - wo.quantityBuilt);
    const progressPct = wo.quantityToBuild > 0
      ? Math.round((wo.quantityBuilt / wo.quantityToBuild) * 100)
      : 0;
    return {
      order_number: wo.orderNumber,
      output_sku: wo.outputSku.sku,
      output_product: wo.outputSku.name,
      status: wo.status,
      target_qty: wo.quantityToBuild,
      built_qty: wo.quantityBuilt,
      remaining_qty: remaining,
      progress_percent: progressPct,
      created_at: wo.createdAt,
      started_at: wo.startedAt,
      completed_at: wo.completedAt,
      notes: wo.notes,
    };
  });

  return Response.json({
    as_of: new Date().toISOString(),
    count: rows.length,
    work_orders: rows,
  });
};
