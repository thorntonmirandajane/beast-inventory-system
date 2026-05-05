import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  useLoaderData,
  useActionData,
  Form,
  Link,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useEffect, useState, useMemo } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory } from "../utils/inventory.server";
import { ImageUpload } from "../components/ImageUpload";
import { MultiImageUpload } from "../components/MultiImageUpload";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { id } = params;
  if (!id) throw new Response("Not found", { status: 404 });

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          sku: true,
          manufacturer: true,
        },
        orderBy: { id: "asc" },
      },
      shipments: {
        include: {
          items: {
            include: {
              poItem: { include: { sku: true } },
            },
          },
          createdBy: true,
          approvedBy: true,
        },
        orderBy: { shipmentNumber: "asc" },
      },
      createdBy: true,
      approvedBy: true,
    },
  });

  if (!po) throw new Response("PO not found", { status: 404 });

  return { user, po };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { id: poId } = params;
  if (!poId) return { error: "Missing PO id" };

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create-shipment") {
    const trackingNumber = (formData.get("trackingNumber") as string) || null;
    const carrier = (formData.get("carrier") as string) || null;
    const tariffAmount = parseFloat((formData.get("tariffAmount") as string) || "0") || 0;
    const shippingCost = parseFloat((formData.get("shippingCost") as string) || "0") || 0;
    const receivedAt = (formData.get("receivedAt") as string) || null;
    const notes = (formData.get("notes") as string) || null;
    const varianceNotes = (formData.get("varianceNotes") as string) || null;
    const packingSlipImageUrl = (formData.get("packingSlipImageUrl") as string) || null;
    const boxImageUrls = formData.getAll("boxImageUrls").map((v) => String(v)).filter(Boolean);

    const itemsJson = formData.get("itemsJson") as string;
    const items: { poItemId: string; quantityReceived: number; actualUnitCost?: number | null }[] =
      itemsJson ? JSON.parse(itemsJson) : [];

    const lineItems = items.filter((it) => it.quantityReceived > 0);
    if (lineItems.length === 0) {
      return { error: "Enter a quantity for at least one line item" };
    }

    if (!packingSlipImageUrl) {
      return { error: "Packing slip image is required" };
    }

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true, shipments: true },
    });
    if (!po) return { error: "PO not found" };

    let hasVariance = false;
    for (const li of lineItems) {
      const poItem = po.items.find((i) => i.id === li.poItemId);
      if (!poItem) return { error: "Invalid line item" };
      const remaining = poItem.quantityOrdered - poItem.quantityReceived;
      if (li.quantityReceived !== remaining) hasVariance = true;
    }

    if (hasVariance) {
      if (!varianceNotes || varianceNotes.trim().length === 0) {
        return {
          error: "Variance detected — notes are required when received qty doesn't match expected",
        };
      }
      if (boxImageUrls.length === 0) {
        return {
          error: "Variance detected — at least one box/items photo is required",
        };
      }
    }

    const nextShipmentNumber =
      po.shipments.reduce((max, s) => Math.max(max, s.shipmentNumber), 0) + 1;

    const shipment = await prisma.pOShipment.create({
      data: {
        purchaseOrderId: poId,
        shipmentNumber: nextShipmentNumber,
        trackingNumber,
        carrier,
        tariffAmount,
        shippingCost,
        receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
        notes,
        varianceNotes,
        hasVariance,
        packingSlipImageUrl,
        boxImageUrls,
        createdById: user.id,
        items: {
          create: lineItems.map((li) => ({
            poItemId: li.poItemId,
            quantityReceived: li.quantityReceived,
            actualUnitCost:
              li.actualUnitCost != null && li.actualUnitCost > 0 ? li.actualUnitCost : null,
          })),
        },
      },
    });

    await createAuditLog(user.id, "CREATE_SHIPMENT", "POShipment", shipment.id, {
      poNumber: po.poNumber,
      shipmentNumber: nextShipmentNumber,
      itemCount: lineItems.length,
      hasVariance,
    });

    return {
      success: true,
      message: hasVariance
        ? `Shipment #${nextShipmentNumber} recorded with variance — pending approval`
        : `Shipment #${nextShipmentNumber} recorded — pending approval`,
    };
  }

  if (intent === "approve-shipment") {
    const shipmentId = formData.get("shipmentId") as string;

    const shipment = await prisma.pOShipment.findUnique({
      where: { id: shipmentId },
      include: {
        items: { include: { poItem: { include: { sku: true } } } },
        purchaseOrder: { include: { items: true } },
      },
    });
    if (!shipment) return { error: "Shipment not found" };
    if (shipment.purchaseOrderId !== poId) return { error: "Shipment does not belong to this PO" };
    if (shipment.status !== "PENDING") return { error: "Shipment already processed" };

    await prisma.$transaction(async (tx) => {
      for (const si of shipment.items) {
        await tx.pOItem.update({
          where: { id: si.poItemId },
          data: { quantityReceived: { increment: si.quantityReceived } },
        });
        await addInventory(
          si.poItem.skuId,
          si.quantityReceived,
          "RAW",
          undefined,
          `Shipment #${shipment.shipmentNumber} of ${shipment.purchaseOrder.poNumber}`,
          shipmentId,
          "PURCHASE_ORDER",
          undefined,
          user.id,
          tx
        );
      }

      await tx.pOShipment.update({
        where: { id: shipmentId },
        data: {
          status: "APPROVED",
          approvedById: user.id,
          approvedAt: new Date(),
        },
      });

      // Recompute PO status
      const refreshed = await tx.purchaseOrder.findUnique({
        where: { id: poId },
        include: { items: true },
      });
      if (refreshed) {
        const allFull = refreshed.items.every(
          (i) => i.quantityReceived >= i.quantityOrdered
        );
        const anyReceived = refreshed.items.some((i) => i.quantityReceived > 0);
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            status: allFull ? "RECEIVED" : anyReceived ? "PARTIAL" : "SUBMITTED",
            receivedAt: allFull ? new Date() : null,
          },
        });
      }
    });

    await createAuditLog(user.id, "APPROVE_SHIPMENT", "POShipment", shipmentId, {
      poNumber: shipment.purchaseOrder.poNumber,
      shipmentNumber: shipment.shipmentNumber,
    });

    return {
      success: true,
      message: `Shipment #${shipment.shipmentNumber} approved — inventory updated`,
    };
  }

  if (intent === "reject-shipment") {
    const shipmentId = formData.get("shipmentId") as string;
    const reason = (formData.get("reason") as string) || null;

    const shipment = await prisma.pOShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) return { error: "Shipment not found" };
    if (shipment.purchaseOrderId !== poId) return { error: "Shipment does not belong to this PO" };
    if (shipment.status !== "PENDING") return { error: "Shipment already processed" };

    await prisma.pOShipment.update({
      where: { id: shipmentId },
      data: {
        status: "REJECTED",
        approvedById: user.id,
        approvedAt: new Date(),
        varianceNotes: reason
          ? `${shipment.varianceNotes ? shipment.varianceNotes + "\n\n" : ""}REJECTED: ${reason}`
          : shipment.varianceNotes,
      },
    });

    await createAuditLog(user.id, "REJECT_SHIPMENT", "POShipment", shipmentId, {
      shipmentNumber: shipment.shipmentNumber,
      reason,
    });

    return { success: true, message: `Shipment #${shipment.shipmentNumber} rejected` };
  }

  if (intent === "delete-shipment") {
    const shipmentId = formData.get("shipmentId") as string;

    const shipment = await prisma.pOShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) return { error: "Shipment not found" };
    if (shipment.purchaseOrderId !== poId) return { error: "Shipment does not belong to this PO" };
    if (shipment.status === "APPROVED") {
      return { error: "Cannot delete an approved shipment — inventory has been recorded" };
    }

    await prisma.pOShipmentItem.deleteMany({ where: { shipmentId } });
    await prisma.pOShipment.delete({ where: { id: shipmentId } });

    await createAuditLog(user.id, "DELETE_SHIPMENT", "POShipment", shipmentId, {
      shipmentNumber: shipment.shipmentNumber,
    });

    return { success: true, message: `Shipment #${shipment.shipmentNumber} deleted` };
  }

  return { error: "Invalid action" };
};

function getStatusColor(status: string) {
  switch (status) {
    case "SUBMITTED": return "bg-yellow-100 text-yellow-800";
    case "PARTIAL": return "bg-orange-100 text-orange-800";
    case "RECEIVED": return "bg-blue-100 text-blue-800";
    case "APPROVED": return "bg-green-100 text-green-800";
    case "PENDING": return "bg-yellow-100 text-yellow-800";
    case "REJECTED": return "bg-red-100 text-red-800";
    case "CANCELLED": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-800";
  }
}

export default function POShow() {
  const { user, po } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [searchParams, setSearchParams] = useSearchParams();
  const canReceive =
    po.status !== "RECEIVED" && po.status !== "APPROVED" && po.status !== "CANCELLED";
  const initiallyOpen =
    canReceive && (searchParams.get("new") === "1" || po.shipments.length === 0);
  const [showNewShipment, setShowNewShipment] = useState(initiallyOpen);

  useEffect(() => {
    if (showNewShipment && searchParams.get("new") === "1") {
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [showNewShipment, searchParams, setSearchParams]);

  // Per-item draft state for the new-shipment form
  const initialDraft = useMemo(() => {
    const map: Record<string, { qty: number; cost: string }> = {};
    for (const item of po.items) {
      map[item.id] = { qty: 0, cost: item.unitCost != null ? String(item.unitCost) : "" };
    }
    return map;
  }, [po.items]);
  const [draftItems, setDraftItems] = useState<Record<string, { qty: number; cost: string }>>(initialDraft);

  const [packingSlipUrl, setPackingSlipUrl] = useState<string>("");
  const [boxImageUrls, setBoxImageUrls] = useState<string[]>([]);
  const [varianceNotes, setVarianceNotes] = useState("");

  const remainingByItem = useMemo(() => {
    const m: Record<string, number> = {};
    for (const item of po.items) {
      m[item.id] = Math.max(0, item.quantityOrdered - item.quantityReceived);
    }
    return m;
  }, [po.items]);

  const variancePerItem = useMemo(() => {
    const v: Record<string, "match" | "short" | "over" | "none"> = {};
    for (const item of po.items) {
      const qty = draftItems[item.id]?.qty || 0;
      const remaining = remainingByItem[item.id];
      if (qty === 0) v[item.id] = "none";
      else if (qty === remaining) v[item.id] = "match";
      else if (qty < remaining) v[item.id] = "short";
      else v[item.id] = "over";
    }
    return v;
  }, [draftItems, po.items, remainingByItem]);

  const hasVariance = Object.values(variancePerItem).some((v) => v === "short" || v === "over");
  const hasAnyQty = Object.values(draftItems).some((d) => d.qty > 0);

  const canSubmit =
    hasAnyQty &&
    !!packingSlipUrl &&
    (!hasVariance || (varianceNotes.trim().length > 0 && boxImageUrls.length > 0));

  // Cost summary so far across approved shipments
  const approvedShipments = po.shipments.filter((s) => s.status === "APPROVED");
  const totalApprovedCost = approvedShipments.reduce((sum, s) => {
    const itemCost = s.items.reduce(
      (subtotal, si) =>
        subtotal +
        (si.actualUnitCost ?? si.poItem.unitCost ?? 0) * si.quantityReceived,
      0
    );
    return sum + itemCost + s.tariffAmount + s.shippingCost;
  }, 0);

  const totalOrdered = po.items.reduce((s, i) => s + i.quantityOrdered, 0);
  const totalReceived = po.items.reduce((s, i) => s + i.quantityReceived, 0);

  const itemsJsonValue = JSON.stringify(
    Object.entries(draftItems)
      .filter(([_, d]) => d.qty > 0)
      .map(([poItemId, d]) => ({
        poItemId,
        quantityReceived: d.qty,
        actualUnitCost: d.cost ? parseFloat(d.cost) : null,
      }))
  );

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/po" className="text-sm text-blue-600 hover:underline">
              ← All POs
            </Link>
          </div>
          <h1 className="page-title font-mono">{po.poNumber}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`badge ${getStatusColor(po.status)}`}>{po.status}</span>
            <span className="text-sm text-gray-500">
              {po.items.length} item{po.items.length !== 1 ? "s" : ""} ·{" "}
              {totalReceived}/{totalOrdered} received
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Link to={`/po/${po.id}/pdf`} className="btn btn-ghost">View PDF</Link>
          {po.status !== "RECEIVED" && po.status !== "APPROVED" && po.status !== "CANCELLED" && (
            <button
              type="button"
              onClick={() => setShowNewShipment((v) => !v)}
              className="btn btn-primary"
            >
              {showNewShipment ? "Close" : "+ Receive Shipment"}
            </button>
          )}
        </div>
      </div>

      {actionData?.error && <div className="alert alert-error">{actionData.error}</div>}
      {actionData?.success && <div className="alert alert-success">{actionData.message}</div>}

      {/* PO Summary */}
      <div className="card mb-6">
        <div className="card-body grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-500">Submitted</div>
            <div>{new Date(po.submittedAt).toLocaleDateString()}</div>
            <div className="text-xs text-gray-400">
              by {po.createdBy.firstName} {po.createdBy.lastName}
            </div>
          </div>
          {po.estimatedArrival && (
            <div>
              <div className="text-gray-500">ETA</div>
              <div>{new Date(po.estimatedArrival).toLocaleDateString()}</div>
            </div>
          )}
          <div>
            <div className="text-gray-500">Shipments</div>
            <div>
              {approvedShipments.length} approved / {po.shipments.length} total
            </div>
          </div>
          <div>
            <div className="text-gray-500">Total received cost</div>
            <div className="font-semibold">${totalApprovedCost.toFixed(2)}</div>
            <div className="text-xs text-gray-400">incl. tariffs + shipping</div>
          </div>
          {po.notes && (
            <div className="col-span-2 md:col-span-4">
              <div className="text-gray-500">Notes</div>
              <div>{po.notes}</div>
            </div>
          )}
        </div>
      </div>

      {/* Items table */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Line Items</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Manufacturer</th>
                <th className="text-right">Ordered</th>
                <th className="text-right">Received</th>
                <th className="text-right">Remaining</th>
                <th className="text-right">$/unit</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((item) => (
                <tr key={item.id}>
                  <td className="font-mono text-sm">{item.sku.sku.toUpperCase()}</td>
                  <td>{item.sku.name}</td>
                  <td className="text-sm">{item.manufacturer?.name || "—"}</td>
                  <td className="text-right">{item.quantityOrdered}</td>
                  <td className="text-right">
                    <span className={
                      item.quantityReceived >= item.quantityOrdered
                        ? "text-green-600 font-semibold"
                        : item.quantityReceived > 0
                        ? "text-orange-600"
                        : "text-gray-400"
                    }>
                      {item.quantityReceived}
                    </span>
                  </td>
                  <td className="text-right">{remainingByItem[item.id]}</td>
                  <td className="text-right">
                    {item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Shipment Form */}
      {showNewShipment && (
        <div className="card mb-6 border-2 border-blue-300">
          <div className="card-header">
            <h2 className="card-title">Receive Shipment</h2>
            <p className="text-sm text-gray-500 mt-1">
              Record a partial or full delivery. Photos and notes are required when received qty
              doesn't match what's expected.
            </p>
          </div>
          <div className="card-body">
            <Form method="post" id="new-shipment-form">
              <input type="hidden" name="intent" value="create-shipment" />
              <input type="hidden" name="itemsJson" value={itemsJsonValue} />
              <input type="hidden" name="packingSlipImageUrl" value={packingSlipUrl} />
              {boxImageUrls.map((url) => (
                <input key={url} type="hidden" name="boxImageUrls" value={url} />
              ))}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="form-group mb-0">
                  <label className="form-label">Tracking Number</label>
                  <input type="text" name="trackingNumber" className="form-input" placeholder="e.g. 1Z999..." />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Carrier</label>
                  <input type="text" name="carrier" className="form-input" placeholder="UPS, FedEx, DHL..." />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Tariff ($)</label>
                  <input type="number" name="tariffAmount" className="form-input" min="0" step="0.01" defaultValue="0" />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Shipping ($)</label>
                  <input type="number" name="shippingCost" className="form-input" min="0" step="0.01" defaultValue="0" />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Date Received</label>
                <input
                  type="date"
                  name="receivedAt"
                  className="form-input md:w-64"
                  defaultValue={new Date().toISOString().split("T")[0]}
                />
              </div>

              {/* Per-item qty + actual cost */}
              <div className="mb-6">
                <label className="form-label">Items in this Shipment</label>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th className="text-right">Remaining</th>
                        <th className="text-right">Receive Qty</th>
                        <th className="text-right">Actual $/unit</th>
                        <th>Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.items.map((item) => {
                        const draft = draftItems[item.id] || { qty: 0, cost: "" };
                        const remaining = remainingByItem[item.id];
                        const variance = variancePerItem[item.id];

                        return (
                          <tr key={item.id}>
                            <td>
                              <div className="font-mono text-sm">{item.sku.sku.toUpperCase()}</div>
                              <div className="text-xs text-gray-500">{item.sku.name}</div>
                            </td>
                            <td className="text-right">{remaining}</td>
                            <td className="text-right">
                              <input
                                type="number"
                                className="form-input w-24 text-right"
                                min="0"
                                value={draft.qty || ""}
                                onChange={(e) => {
                                  const v = parseInt(e.target.value, 10) || 0;
                                  setDraftItems((prev) => ({
                                    ...prev,
                                    [item.id]: { ...draft, qty: Math.max(0, v) },
                                  }));
                                }}
                                placeholder="0"
                                disabled={remaining === 0}
                              />
                            </td>
                            <td className="text-right">
                              <input
                                type="number"
                                className="form-input w-28 text-right"
                                min="0"
                                step="0.01"
                                value={draft.cost}
                                onChange={(e) => {
                                  setDraftItems((prev) => ({
                                    ...prev,
                                    [item.id]: { ...draft, cost: e.target.value },
                                  }));
                                }}
                                placeholder={item.unitCost != null ? item.unitCost.toFixed(2) : "0.00"}
                              />
                            </td>
                            <td>
                              {variance === "match" && (
                                <span className="badge bg-green-100 text-green-800">✓ Match</span>
                              )}
                              {variance === "short" && (
                                <span className="badge bg-orange-100 text-orange-800">
                                  Short by {remaining - draft.qty}
                                </span>
                              )}
                              {variance === "over" && (
                                <span className="badge bg-red-100 text-red-800">
                                  Over by {draft.qty - remaining}
                                </span>
                              )}
                              {variance === "none" && (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Variance notes */}
              {hasVariance && (
                <div className="bg-orange-50 border border-orange-300 rounded-lg p-4 mb-6">
                  <div className="font-semibold text-orange-900 mb-2">
                    Variance detected — notes and box/items photo required
                  </div>
                  <textarea
                    name="varianceNotes"
                    className="form-textarea"
                    rows={3}
                    placeholder="Explain the discrepancy (damaged, short shipment, overship, wrong item, etc.)..."
                    value={varianceNotes}
                    onChange={(e) => setVarianceNotes(e.target.value)}
                    required
                  />
                </div>
              )}

              {/* Packing slip image */}
              <div className="mb-6">
                <ImageUpload
                  label="Packing Slip (required)"
                  helpText="Upload a photo of the packing slip"
                  folder="po-shipments/packing-slips"
                  onImageUploaded={(url) => setPackingSlipUrl(url)}
                />
              </div>

              {/* Box / items images */}
              <div className="mb-6">
                <MultiImageUpload
                  name="boxImageUrlsClient"
                  label={hasVariance ? "Box / Items Photos (required for variance)" : "Box / Items Photos"}
                  helpText="Upload photos of the box and contents"
                  folder="po-shipments/boxes"
                  initialUrls={boxImageUrls}
                  onChange={(urls) => setBoxImageUrls(urls)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">General Notes</label>
                <textarea name="notes" className="form-textarea" rows={2} placeholder="Optional notes..." />
              </div>

              <div className="flex gap-3 mt-4">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting || !canSubmit}
                >
                  {isSubmitting ? "Recording..." : "Record Shipment"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowNewShipment(false);
                    setDraftItems(initialDraft);
                    setPackingSlipUrl("");
                    setBoxImageUrls([]);
                    setVarianceNotes("");
                  }}
                >
                  Cancel
                </button>
                {!canSubmit && hasAnyQty && (
                  <span className="text-sm text-orange-600 self-center">
                    {!packingSlipUrl
                      ? "Packing slip image required"
                      : hasVariance && varianceNotes.trim().length === 0
                      ? "Variance notes required"
                      : hasVariance && boxImageUrls.length === 0
                      ? "At least one box/items photo required"
                      : ""}
                  </span>
                )}
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Existing Shipments */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Shipments ({po.shipments.length})</h2>
        </div>
        {po.shipments.length === 0 ? (
          <div className="card-body">
            <div className="empty-state">
              <h3 className="empty-state-title">No shipments yet</h3>
              <p className="empty-state-description mb-4">
                Receive this PO in segments — record each delivery as a shipment with its
                own tracking, tariff, and cost.
              </p>
              {canReceive && !showNewShipment && (
                <button
                  type="button"
                  onClick={() => setShowNewShipment(true)}
                  className="btn btn-primary"
                >
                  + Record First Shipment
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {po.shipments.map((s) => (
              <ShipmentRow key={s.id} shipment={s} isSubmitting={isSubmitting} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

type Shipment = Awaited<ReturnType<typeof loader>>["po"]["shipments"][number];

function ShipmentRow({ shipment, isSubmitting }: { shipment: Shipment; isSubmitting: boolean }) {
  const [open, setOpen] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);

  const itemsCost = shipment.items.reduce(
    (sum, si) =>
      sum + (si.actualUnitCost ?? si.poItem.unitCost ?? 0) * si.quantityReceived,
    0
  );
  const shipmentTotal = itemsCost + shipment.tariffAmount + shipment.shippingCost;

  return (
    <div id={`shipment-${shipment.id}`} className="p-4">
      <div
        className="flex items-center justify-between cursor-pointer flex-wrap gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div className="font-semibold">Shipment #{shipment.shipmentNumber}</div>
          <span className={`badge ${getStatusColor(shipment.status)}`}>
            {shipment.status}
          </span>
          {shipment.hasVariance && (
            <span className="badge bg-orange-100 text-orange-800">Variance</span>
          )}
          <div className="text-sm text-gray-500">
            {new Date(shipment.receivedAt).toLocaleDateString()} ·{" "}
            {shipment.items.reduce((s, si) => s + si.quantityReceived, 0)} units ·{" "}
            ${shipmentTotal.toFixed(2)}
          </div>
        </div>
        <svg
          className={`w-5 h-5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-gray-500">Tracking</div>
              <div className="font-mono">{shipment.trackingNumber || "—"}</div>
            </div>
            <div>
              <div className="text-gray-500">Carrier</div>
              <div>{shipment.carrier || "—"}</div>
            </div>
            <div>
              <div className="text-gray-500">Tariff</div>
              <div>${shipment.tariffAmount.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-gray-500">Shipping</div>
              <div>${shipment.shippingCost.toFixed(2)}</div>
            </div>
          </div>

          <table className="data-table text-sm">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Actual $/unit</th>
                <th className="text-right">Line total</th>
              </tr>
            </thead>
            <tbody>
              {shipment.items.map((si) => {
                const cost = si.actualUnitCost ?? si.poItem.unitCost ?? 0;
                return (
                  <tr key={si.id}>
                    <td className="font-mono">{si.poItem.sku.sku.toUpperCase()}</td>
                    <td>{si.poItem.sku.name}</td>
                    <td className="text-right">{si.quantityReceived}</td>
                    <td className="text-right">
                      {si.actualUnitCost != null ? `$${si.actualUnitCost.toFixed(2)}` : (
                        <span className="text-gray-400 italic">
                          {si.poItem.unitCost != null ? `$${si.poItem.unitCost.toFixed(2)} (PO)` : "—"}
                        </span>
                      )}
                    </td>
                    <td className="text-right">${(cost * si.quantityReceived).toFixed(2)}</td>
                  </tr>
                );
              })}
              <tr className="font-semibold border-t-2">
                <td colSpan={4} className="text-right">Items subtotal</td>
                <td className="text-right">${itemsCost.toFixed(2)}</td>
              </tr>
              <tr>
                <td colSpan={4} className="text-right text-sm">+ Tariff</td>
                <td className="text-right">${shipment.tariffAmount.toFixed(2)}</td>
              </tr>
              <tr>
                <td colSpan={4} className="text-right text-sm">+ Shipping</td>
                <td className="text-right">${shipment.shippingCost.toFixed(2)}</td>
              </tr>
              <tr className="font-bold border-t-2 bg-gray-50">
                <td colSpan={4} className="text-right">Shipment total</td>
                <td className="text-right">${shipmentTotal.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          {(shipment.notes || shipment.varianceNotes) && (
            <div className="space-y-2">
              {shipment.notes && (
                <div className="bg-gray-50 border rounded p-3">
                  <div className="text-xs font-semibold text-gray-500 mb-1">NOTES</div>
                  <div className="text-sm whitespace-pre-wrap">{shipment.notes}</div>
                </div>
              )}
              {shipment.varianceNotes && (
                <div className="bg-orange-50 border border-orange-200 rounded p-3">
                  <div className="text-xs font-semibold text-orange-700 mb-1">VARIANCE NOTES</div>
                  <div className="text-sm whitespace-pre-wrap">{shipment.varianceNotes}</div>
                </div>
              )}
            </div>
          )}

          {/* Images */}
          {(shipment.packingSlipImageUrl || shipment.boxImageUrls.length > 0) && (
            <div className="space-y-3">
              {shipment.packingSlipImageUrl && (
                <div>
                  <div className="text-xs font-semibold text-gray-500 mb-2">PACKING SLIP</div>
                  <a href={shipment.packingSlipImageUrl} target="_blank" rel="noopener noreferrer">
                    <img
                      src={shipment.packingSlipImageUrl}
                      alt="Packing slip"
                      className="max-w-md max-h-64 rounded border hover:opacity-90"
                    />
                  </a>
                </div>
              )}
              {shipment.boxImageUrls.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-500 mb-2">
                    BOX / ITEMS PHOTOS ({shipment.boxImageUrls.length})
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {shipment.boxImageUrls.map((url, idx) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={url}
                          alt={`Box ${idx + 1}`}
                          className="w-full h-32 object-cover rounded border hover:opacity-90"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 flex-wrap">
            {shipment.status === "PENDING" && (
              <>
                <Form method="post">
                  <input type="hidden" name="intent" value="approve-shipment" />
                  <input type="hidden" name="shipmentId" value={shipment.id} />
                  <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                    Approve & Add to Inventory
                  </button>
                </Form>
                <button
                  type="button"
                  onClick={() => setShowRejectForm((v) => !v)}
                  className="btn btn-ghost"
                >
                  {showRejectForm ? "Cancel reject" : "Reject"}
                </button>
                <Form method="post" onSubmit={(e) => {
                  if (!confirm(`Delete shipment #${shipment.shipmentNumber}?`)) e.preventDefault();
                }}>
                  <input type="hidden" name="intent" value="delete-shipment" />
                  <input type="hidden" name="shipmentId" value={shipment.id} />
                  <button type="submit" className="btn btn-error btn-sm" disabled={isSubmitting}>
                    Delete
                  </button>
                </Form>
              </>
            )}
            <div className="text-xs text-gray-500 self-center ml-auto">
              Created by {shipment.createdBy.firstName} {shipment.createdBy.lastName}
              {shipment.approvedBy && (
                <> · {shipment.status === "APPROVED" ? "approved" : "rejected"} by {shipment.approvedBy.firstName} {shipment.approvedBy.lastName}</>
              )}
            </div>
          </div>

          {showRejectForm && shipment.status === "PENDING" && (
            <Form method="post" className="bg-red-50 border border-red-200 rounded p-3">
              <input type="hidden" name="intent" value="reject-shipment" />
              <input type="hidden" name="shipmentId" value={shipment.id} />
              <label className="form-label">Reason for rejection</label>
              <textarea
                name="reason"
                className="form-textarea mb-2"
                rows={2}
                placeholder="Why is this shipment being rejected?"
                required
              />
              <button type="submit" className="btn btn-error btn-sm" disabled={isSubmitting}>
                Confirm Reject
              </button>
            </Form>
          )}
        </div>
      )}
    </div>
  );
}
