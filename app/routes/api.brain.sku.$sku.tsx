import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { requireBrainAuth } from "../utils/brain-auth.server";

// GET /api/brain/sku/:sku
//
// Full record for one SKU: master fields, on-hand by state, BOM components, manufacturers,
// open POs covering this SKU, open work orders producing it, and the most recent inventory log
// entries. Used after inventory-status / low-stock identifies a SKU and the user wants the deep dive.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = requireBrainAuth(request);
  if (!auth.ok) return auth.response;

  const skuCode = params.sku;
  if (!skuCode) return Response.json({ error: "Missing sku" }, { status: 400 });

  const sku = await prisma.sku.findUnique({
    where: { sku: skuCode },
    include: {
      inventoryItems: { select: { state: true, quantity: true, location: true } },
      bomComponents: {
        select: {
          quantity: true,
          componentSku: { select: { sku: true, name: true, type: true } },
        },
      },
      manufacturers: {
        select: {
          isPreferred: true,
          leadTimeDays: true,
          cost: true,
          notes: true,
          manufacturer: { select: { name: true } },
        },
      },
      poItems: {
        where: { purchaseOrder: { status: { in: ["SUBMITTED", "PARTIAL", "APPROVED"] } } },
        select: {
          quantityOrdered: true,
          quantityReceived: true,
          purchaseOrder: { select: { poNumber: true, vendorName: true, status: true, estimatedArrival: true } },
        },
      },
      workOrdersProducing: {
        where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
        select: { orderNumber: true, status: true, quantityToBuild: true, quantityBuilt: true, createdAt: true },
      },
      inventoryLogs: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          action: true,
          quantity: true,
          fromState: true,
          toState: true,
          notes: true,
          createdAt: true,
        },
      },
    },
  });

  if (!sku) return Response.json({ error: `No SKU matching "${skuCode}"` }, { status: 404 });

  const totals: Record<string, number> = { RECEIVED: 0, RAW: 0, ASSEMBLED: 0, COMPLETED: 0, TRANSFERRED: 0 };
  for (const item of sku.inventoryItems) {
    totals[item.state] = (totals[item.state] || 0) + item.quantity;
  }

  return Response.json({
    as_of: new Date().toISOString(),
    sku: {
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      category: sku.category,
      material: sku.material,
      upc: sku.upc,
      is_active: sku.isActive,
      description: sku.description,
      inventory: {
        on_hand_total: totals.RECEIVED + totals.RAW + totals.ASSEMBLED + totals.COMPLETED,
        ready_to_ship: totals.COMPLETED,
        received_unprocessed: totals.RECEIVED,
        raw: totals.RAW,
        in_assembly: totals.ASSEMBLED,
        transferred_out: totals.TRANSFERRED,
      },
      bom_components: sku.bomComponents.map((c) => ({
        component_sku: c.componentSku.sku,
        component_name: c.componentSku.name,
        component_type: c.componentSku.type,
        quantity_per_unit: c.quantity,
      })),
      suppliers: sku.manufacturers.map((m) => ({
        manufacturer: m.manufacturer.name,
        is_preferred: m.isPreferred,
        lead_time_days: m.leadTimeDays,
        unit_cost: m.cost,
        notes: m.notes,
      })),
      open_purchase_orders: sku.poItems.map((p) => ({
        po_number: p.purchaseOrder.poNumber,
        vendor: p.purchaseOrder.vendorName,
        status: p.purchaseOrder.status,
        estimated_arrival: p.purchaseOrder.estimatedArrival,
        ordered: p.quantityOrdered,
        received: p.quantityReceived,
        outstanding: p.quantityOrdered - p.quantityReceived,
      })),
      open_work_orders: sku.workOrdersProducing.map((w) => ({
        order_number: w.orderNumber,
        status: w.status,
        target_qty: w.quantityToBuild,
        built_qty: w.quantityBuilt,
        remaining_qty: Math.max(0, w.quantityToBuild - w.quantityBuilt),
        created_at: w.createdAt,
      })),
      recent_inventory_log: sku.inventoryLogs.map((l) => ({
        action: l.action,
        quantity: l.quantity,
        from_state: l.fromState,
        to_state: l.toState,
        notes: l.notes,
        at: l.createdAt,
      })),
    },
  });
};
