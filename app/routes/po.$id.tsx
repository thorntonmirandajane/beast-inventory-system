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
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory } from "../utils/inventory.server";
import { ImageUpload } from "../components/ImageUpload";
import { MultiImageUpload } from "../components/MultiImageUpload";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const { id } = params;
  if (!id) throw new Response("Not found", { status: 404 });

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: {
        include: { sku: true, manufacturer: true },
        orderBy: { id: "asc" },
      },
      parentPO: { select: { id: true, poNumber: true, status: true } },
      children: {
        include: {
          items: { include: { sku: true } },
          createdBy: true,
          approvedBy: true,
        },
        orderBy: { submittedAt: "asc" },
      },
      createdBy: true,
      approvedBy: true,
    },
  });

  if (!po) throw new Response("PO not found", { status: 404 });

  return { user, po };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const { id: poId } = params;
  if (!poId) return { error: "Missing PO id" };

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "split-po") {
    const splitsJson = formData.get("splitsJson") as string;
    const splits: { poItemId: string; quantity: number }[] = splitsJson
      ? JSON.parse(splitsJson)
      : [];
    const childNotes = (formData.get("childNotes") as string) || null;

    const valid = splits.filter((s) => s.quantity > 0);
    if (valid.length === 0) {
      return { error: "Enter a quantity for at least one item to split" };
    }

    const parent = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true, children: true },
    });
    if (!parent) return { error: "PO not found" };
    if (parent.status === "APPROVED" || parent.status === "RECEIVED" || parent.status === "CANCELLED") {
      return { error: `Cannot split a ${parent.status.toLowerCase()} PO` };
    }

    for (const s of valid) {
      const item = parent.items.find((i) => i.id === s.poItemId);
      if (!item) return { error: "Invalid line item" };
      const remaining = item.quantityOrdered - item.quantityReceived;
      if (s.quantity > remaining) {
        return {
          error: `Cannot split ${s.quantity} of ${s.poItemId} — only ${remaining} remaining on parent`,
        };
      }
    }

    const childPoNumber = `${parent.poNumber}-${parent.children.length + 1}`;

    const child = await prisma.$transaction(async (tx) => {
      // Pull source items so we can copy manufacturer/unitCost onto the child
      const srcItems = await tx.pOItem.findMany({
        where: { id: { in: valid.map((s) => s.poItemId) } },
      });

      const newChild = await tx.purchaseOrder.create({
        data: {
          poNumber: childPoNumber,
          vendorName: parent.vendorName,
          estimatedArrival: parent.estimatedArrival,
          parentPOId: parent.id,
          notes: childNotes,
          createdById: user.id,
          items: {
            create: valid.map((s) => {
              const src = srcItems.find((i) => i.id === s.poItemId)!;
              return {
                skuId: src.skuId,
                quantityOrdered: s.quantity,
                manufacturerId: src.manufacturerId,
                unitCost: src.unitCost,
              };
            }),
          },
        },
      });

      // Decrement parent line items by the split amounts
      for (const s of valid) {
        await tx.pOItem.update({
          where: { id: s.poItemId },
          data: { quantityOrdered: { decrement: s.quantity } },
        });
      }

      // Remove parent line items that are now zero AND have no receipts
      await tx.pOItem.deleteMany({
        where: {
          purchaseOrderId: parent.id,
          quantityOrdered: 0,
          quantityReceived: 0,
        },
      });

      return newChild;
    });

    await createAuditLog(user.id, "SPLIT_PO", "PurchaseOrder", child.id, {
      parentPoNumber: parent.poNumber,
      childPoNumber,
      splits: valid,
    });

    return { success: true, message: `Split into ${childPoNumber}`, childId: child.id };
  }

  if (intent === "mark-in-route") {
    const trackingNumber = ((formData.get("trackingNumber") as string) || "").trim() || null;
    const routesJson = formData.get("routesJson") as string;
    const routes: { poItemId: string; quantity: number }[] = routesJson ? JSON.parse(routesJson) : [];
    const valid = routes.filter((r) => r.quantity > 0);
    if (valid.length === 0) return { error: "Enter a quantity for at least one item that's shipping." };

    const parent = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true, children: true },
    });
    if (!parent) return { error: "PO not found" };
    if (parent.status !== "SUBMITTED" && parent.status !== "PARTIAL") {
      return { error: `Can't mark a ${parent.status.toLowerCase()} PO in route` };
    }

    for (const r of valid) {
      const item = parent.items.find((i) => i.id === r.poItemId);
      if (!item) return { error: "Invalid line item" };
      const remaining = item.quantityOrdered - item.quantityReceived;
      if (r.quantity > remaining) {
        return { error: `Only ${remaining} remaining for ${item.skuId} — can't put ${r.quantity} in route` };
      }
    }

    // Full shipment = every remaining line is fully in route → just flip this PO.
    const routeMap = new Map(valid.map((r) => [r.poItemId, r.quantity]));
    const isFull = parent.items.every((i) => {
      const remaining = i.quantityOrdered - i.quantityReceived;
      return remaining === 0 || routeMap.get(i.id) === remaining;
    });

    if (isFull) {
      await prisma.purchaseOrder.update({
        where: { id: parent.id },
        data: { status: "IN_ROUTE", trackingNumber },
      });
      await createAuditLog(user.id, "MARK_PO_IN_ROUTE", "PurchaseOrder", parent.id, { poNumber: parent.poNumber, trackingNumber });
      return { success: true, message: `${parent.poNumber} marked in route${trackingNumber ? ` (tracking ${trackingNumber})` : ""}.` };
    }

    // Partial shipment → split the shipped portion into a child PO that is IN_ROUTE.
    const childPoNumber = `${parent.poNumber}-${parent.children.length + 1}`;
    const child = await prisma.$transaction(async (tx) => {
      const srcItems = await tx.pOItem.findMany({ where: { id: { in: valid.map((s) => s.poItemId) } } });
      const newChild = await tx.purchaseOrder.create({
        data: {
          poNumber: childPoNumber,
          vendorName: parent.vendorName,
          estimatedArrival: parent.estimatedArrival,
          parentPOId: parent.id,
          status: "IN_ROUTE",
          trackingNumber,
          createdById: user.id,
          items: {
            create: valid.map((s) => {
              const src = srcItems.find((i) => i.id === s.poItemId)!;
              return { skuId: src.skuId, quantityOrdered: s.quantity, manufacturerId: src.manufacturerId, unitCost: src.unitCost };
            }),
          },
        },
      });
      for (const s of valid) {
        await tx.pOItem.update({ where: { id: s.poItemId }, data: { quantityOrdered: { decrement: s.quantity } } });
      }
      await tx.pOItem.deleteMany({ where: { purchaseOrderId: parent.id, quantityOrdered: 0, quantityReceived: 0 } });
      return newChild;
    });

    await createAuditLog(user.id, "MARK_PO_IN_ROUTE", "PurchaseOrder", child.id, {
      parentPoNumber: parent.poNumber,
      childPoNumber,
      trackingNumber,
      routes: valid,
    });
    return { success: true, message: `${childPoNumber} split off and marked in route${trackingNumber ? ` (tracking ${trackingNumber})` : ""}.`, childId: child.id };
  }

  if (intent === "receive") {
    const trackingNumber = (formData.get("trackingNumber") as string) || null;
    const carrier = (formData.get("carrier") as string) || null;
    const tariffAmount = parseFloat((formData.get("tariffAmount") as string) || "0") || 0;
    const shippingCost = parseFloat((formData.get("shippingCost") as string) || "0") || 0;
    const receivedAt = (formData.get("receivedAt") as string) || null;
    const varianceNotes = (formData.get("varianceNotes") as string) || null;
    const packingSlipImageUrl = (formData.get("packingSlipImageUrl") as string) || null;
    const boxImageUrls = formData.getAll("boxImageUrls").map((v) => String(v)).filter(Boolean);

    const itemsJson = formData.get("itemsJson") as string;
    const lineItems: { poItemId: string; quantityReceived: number; actualUnitCost?: number | null }[] =
      itemsJson ? JSON.parse(itemsJson) : [];

    if (lineItems.length === 0) {
      return { error: "No line items submitted" };
    }
    if (!packingSlipImageUrl) {
      return { error: "Packing slip image is required" };
    }

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });
    if (!po) return { error: "PO not found" };
    if (po.status !== "SUBMITTED" && po.status !== "PARTIAL" && po.status !== "IN_ROUTE") {
      return { error: `Cannot receive a ${po.status.toLowerCase()} PO` };
    }

    let hasVariance = false;
    for (const li of lineItems) {
      const poItem = po.items.find((i) => i.id === li.poItemId);
      if (!poItem) return { error: "Invalid line item" };
      if (li.quantityReceived !== poItem.quantityOrdered) hasVariance = true;
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

    await prisma.$transaction(async (tx) => {
      for (const li of lineItems) {
        await tx.pOItem.update({
          where: { id: li.poItemId },
          data: {
            quantityReceived: li.quantityReceived,
            unitCost:
              li.actualUnitCost != null && li.actualUnitCost > 0 ? li.actualUnitCost : undefined,
          },
        });
      }

      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: "RECEIVED",
          receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
          trackingNumber,
          carrier,
          tariffAmount,
          shippingCost,
          packingSlipImageUrl,
          boxImageUrls,
          varianceNotes,
          hasVariance,
        },
      });
    });

    await createAuditLog(user.id, "RECEIVE_PO", "PurchaseOrder", poId, {
      poNumber: po.poNumber,
      hasVariance,
    });

    return {
      success: true,
      message: hasVariance
        ? "Receipt recorded with variance — pending approval"
        : "Receipt recorded — pending approval",
    };
  }

  if (intent === "approve") {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { include: { sku: true } } },
    });
    if (!po) return { error: "PO not found" };
    if (po.status !== "RECEIVED") return { error: "Only received POs can be approved" };

    await prisma.$transaction(async (tx) => {
      for (const item of po.items) {
        if (item.quantityReceived > 0) {
          await addInventory(
            item.skuId,
            item.quantityReceived,
            "RAW",
            undefined,
            `${po.poNumber}`,
            poId,
            "PURCHASE_ORDER",
            undefined,
            user.id,
            tx
          );
        }
      }

      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: "APPROVED",
          approvedById: user.id,
          approvedAt: new Date(),
        },
      });
    });

    await createAuditLog(user.id, "APPROVE_PO", "PurchaseOrder", poId, {
      poNumber: po.poNumber,
    });

    return { success: true, message: `${po.poNumber} approved — inventory updated` };
  }

  if (intent === "reject-receipt") {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return { error: "PO not found" };
    if (po.status !== "RECEIVED") return { error: "Only received POs can be rejected" };

    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        status: "SUBMITTED",
        receivedAt: null,
        trackingNumber: null,
        carrier: null,
        tariffAmount: 0,
        shippingCost: 0,
        packingSlipImageUrl: null,
        boxImageUrls: [],
        // Keep variance/notes for record? Reset for cleanliness:
        varianceNotes: null,
        hasVariance: false,
      },
    });

    // Reset items received qty back to zero
    await prisma.pOItem.updateMany({
      where: { purchaseOrderId: poId },
      data: { quantityReceived: 0 },
    });

    await createAuditLog(user.id, "REJECT_RECEIPT", "PurchaseOrder", poId, {
      poNumber: po.poNumber,
    });

    return { success: true, message: `${po.poNumber} reverted to SUBMITTED` };
  }

  return { error: "Invalid action" };
};

function getStatusColor(status: string) {
  switch (status) {
    case "SUBMITTED": return "bg-yellow-100 text-yellow-800";
    case "IN_ROUTE": return "bg-indigo-100 text-indigo-800";
    case "PARTIAL": return "bg-orange-100 text-orange-800";
    case "RECEIVED": return "bg-blue-100 text-blue-800";
    case "APPROVED": return "bg-green-100 text-green-800";
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
  const canEdit = po.status === "SUBMITTED";
  const canReceive = po.status === "SUBMITTED" || po.status === "IN_ROUTE";
  const canSplit = po.status === "SUBMITTED" && po.items.some((i) => i.quantityOrdered > 0);
  const canRoute = po.status === "SUBMITTED" && po.items.some((i) => i.quantityOrdered - i.quantityReceived > 0);

  const initiallyOpenReceive = canReceive && searchParams.get("receive") === "1";
  const initiallyOpenSplit = canSplit && searchParams.get("split") === "1";
  const initiallyOpenRoute = canRoute && searchParams.get("inroute") === "1";

  const [showSplit, setShowSplit] = useState(initiallyOpenSplit);
  const [showReceive, setShowReceive] = useState(initiallyOpenReceive);
  const [showRoute, setShowRoute] = useState(initiallyOpenRoute);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (showReceive && next.get("receive") === "1") {
      next.delete("receive");
      changed = true;
    }
    if (showSplit && next.get("split") === "1") {
      next.delete("split");
      changed = true;
    }
    if (showRoute && next.get("inroute") === "1") {
      next.delete("inroute");
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [showReceive, showSplit, showRoute, searchParams, setSearchParams]);

  // ============ IN-ROUTE FORM STATE ============
  const initialRouteDraft = useMemo(() => {
    const m: Record<string, number> = {};
    for (const item of po.items) m[item.id] = item.quantityOrdered - item.quantityReceived;
    return m;
  }, [po.items]);
  const [routeDraft, setRouteDraft] = useState<Record<string, number>>(initialRouteDraft);
  const [routeTracking, setRouteTracking] = useState("");
  const routeTotal = Object.values(routeDraft).reduce((s, n) => s + (n || 0), 0);
  const routesJson = JSON.stringify(
    Object.entries(routeDraft).filter(([, q]) => q > 0).map(([poItemId, quantity]) => ({ poItemId, quantity }))
  );
  const routeValid = Object.entries(routeDraft).every(([id, qty]) => {
    const item = po.items.find((i) => i.id === id);
    if (!item) return false;
    const remaining = item.quantityOrdered - item.quantityReceived;
    return qty >= 0 && qty <= remaining;
  });
  const routeIsFull = po.items.every((i) => {
    const remaining = i.quantityOrdered - i.quantityReceived;
    return remaining === 0 || routeDraft[i.id] === remaining;
  });
  const canSubmitRoute = routeTotal > 0 && routeValid;

  // ============ SPLIT FORM STATE ============
  const [splitDraft, setSplitDraft] = useState<Record<string, number>>({});
  const splitTotal = Object.values(splitDraft).reduce((s, n) => s + (n || 0), 0);
  const splitsJson = JSON.stringify(
    Object.entries(splitDraft)
      .filter(([_, q]) => q > 0)
      .map(([poItemId, quantity]) => ({ poItemId, quantity }))
  );
  const splitValid = Object.entries(splitDraft).every(([itemId, qty]) => {
    const item = po.items.find((i) => i.id === itemId);
    if (!item) return false;
    const remaining = item.quantityOrdered - item.quantityReceived;
    return qty >= 0 && qty <= remaining;
  });
  const canSubmitSplit = splitTotal > 0 && splitValid;

  // ============ RECEIVE FORM STATE ============
  const initialReceiveDraft = useMemo(() => {
    const m: Record<string, { qty: number; cost: string }> = {};
    for (const item of po.items) {
      m[item.id] = {
        qty: item.quantityOrdered, // Default to expected qty for fastest entry
        cost: item.unitCost != null ? String(item.unitCost) : "",
      };
    }
    return m;
  }, [po.items]);
  const [receiveDraft, setReceiveDraft] = useState<Record<string, { qty: number; cost: string }>>(initialReceiveDraft);
  const [packingSlipUrl, setPackingSlipUrl] = useState<string>("");
  const [boxImageUrls, setBoxImageUrls] = useState<string[]>([]);
  const [varianceNotes, setVarianceNotes] = useState("");

  const variancePerItem = useMemo(() => {
    const v: Record<string, "match" | "short" | "over"> = {};
    for (const item of po.items) {
      const qty = receiveDraft[item.id]?.qty ?? 0;
      if (qty === item.quantityOrdered) v[item.id] = "match";
      else if (qty < item.quantityOrdered) v[item.id] = "short";
      else v[item.id] = "over";
    }
    return v;
  }, [receiveDraft, po.items]);
  const hasVariance = Object.values(variancePerItem).some((v) => v !== "match");
  const canSubmitReceive =
    !!packingSlipUrl &&
    po.items.length > 0 &&
    (!hasVariance || (varianceNotes.trim().length > 0 && boxImageUrls.length > 0));

  const itemsJsonValue = JSON.stringify(
    po.items.map((item) => ({
      poItemId: item.id,
      quantityReceived: receiveDraft[item.id]?.qty ?? 0,
      actualUnitCost:
        receiveDraft[item.id]?.cost ? parseFloat(receiveDraft[item.id]!.cost) : null,
    }))
  );

  // ============ COST ROLLUP ============
  const ownCost = useMemo(() => {
    if (po.status !== "RECEIVED" && po.status !== "APPROVED") return 0;
    const items = po.items.reduce(
      (s, i) => s + (i.unitCost ?? 0) * i.quantityReceived,
      0
    );
    return items + po.tariffAmount + po.shippingCost;
  }, [po]);

  const childrenCost = useMemo(
    () =>
      po.children.reduce((sum, child) => {
        if (child.status !== "RECEIVED" && child.status !== "APPROVED") return sum;
        const items = child.items.reduce(
          (s, i) => s + (i.unitCost ?? 0) * i.quantityReceived,
          0
        );
        return sum + items + child.tariffAmount + child.shippingCost;
      }, 0),
    [po.children]
  );

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/po" className="text-sm text-blue-600 hover:underline">
              ← All POs
            </Link>
            {po.parentPO && (
              <Link to={`/po/${po.parentPO.id}`} className="text-sm text-blue-600 hover:underline">
                ↑ Parent {po.parentPO.poNumber}
              </Link>
            )}
          </div>
          <h1 className="page-title font-mono">{po.poNumber}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`badge ${getStatusColor(po.status)}`}>{po.status}</span>
            {po.parentPO && (
              <span className="badge bg-purple-100 text-purple-800">Child PO</span>
            )}
            {po.children.length > 0 && (
              <span className="badge bg-purple-100 text-purple-800">
                {po.children.length} child{po.children.length !== 1 ? "ren" : ""}
              </span>
            )}
            {po.hasVariance && (
              <span className="badge bg-orange-100 text-orange-800">Variance</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to={`/po/${po.id}/pdf`} className="btn btn-ghost">View PDF</Link>
          {canRoute && (
            <button
              type="button"
              onClick={() => { setShowRoute((v) => !v); setShowSplit(false); setShowReceive(false); }}
              className="btn btn-secondary"
            >
              {showRoute ? "Close" : "🚚 Mark In Route"}
            </button>
          )}
          {canSplit && (
            <button
              type="button"
              onClick={() => { setShowSplit((v) => !v); setShowReceive(false); setShowRoute(false); }}
              className="btn btn-secondary"
            >
              {showSplit ? "Close split" : "↳ Split PO"}
            </button>
          )}
          {canReceive && (
            <button
              type="button"
              onClick={() => { setShowReceive((v) => !v); setShowSplit(false); setShowRoute(false); }}
              className="btn btn-primary"
            >
              {showReceive ? "Close" : "+ Receive"}
            </button>
          )}
          {po.status === "RECEIVED" && (
            <>
              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  Approve & Add to Inventory
                </button>
              </Form>
              <Form method="post" onSubmit={(e) => {
                if (!confirm("Revert receipt? Quantities and tracking will be cleared.")) e.preventDefault();
              }}>
                <input type="hidden" name="intent" value="reject-receipt" />
                <button type="submit" className="btn btn-error" disabled={isSubmitting}>
                  Reject Receipt
                </button>
              </Form>
            </>
          )}
        </div>
      </div>

      {actionData?.error && <div className="alert alert-error">{actionData.error}</div>}
      {actionData?.success && <div className="alert alert-success">{actionData.message}</div>}

      {/* Summary */}
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
          {po.receivedAt && (
            <div>
              <div className="text-gray-500">Received</div>
              <div>{new Date(po.receivedAt).toLocaleDateString()}</div>
            </div>
          )}
          {po.approvedAt && po.approvedBy && (
            <div>
              <div className="text-gray-500">Approved</div>
              <div>{new Date(po.approvedAt).toLocaleDateString()}</div>
              <div className="text-xs text-gray-400">
                by {po.approvedBy.firstName} {po.approvedBy.lastName}
              </div>
            </div>
          )}
          <div>
            <div className="text-gray-500">This PO total</div>
            <div className="font-semibold">${ownCost.toFixed(2)}</div>
            <div className="text-xs text-gray-400">incl. tariff + shipping</div>
          </div>
          {(po.children.length > 0 || childrenCost > 0) && (
            <div>
              <div className="text-gray-500">Children total</div>
              <div className="font-semibold">${childrenCost.toFixed(2)}</div>
              <div className="text-xs text-gray-400">received/approved children</div>
            </div>
          )}
          {(po.children.length > 0 || childrenCost > 0) && (
            <div>
              <div className="text-gray-500">Combined total</div>
              <div className="font-semibold text-blue-700">
                ${(ownCost + childrenCost).toFixed(2)}
              </div>
            </div>
          )}
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
        {po.items.length === 0 ? (
          <div className="card-body">
            <p className="text-sm text-gray-500">
              All quantity has been split out to child POs.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Manufacturer</th>
                  <th className="text-right">Ordered</th>
                  <th className="text-right">Received</th>
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
                        item.quantityReceived >= item.quantityOrdered && item.quantityOrdered > 0
                          ? "text-green-600 font-semibold"
                          : item.quantityReceived > 0
                          ? "text-orange-600"
                          : "text-gray-400"
                      }>
                        {item.quantityReceived}
                      </span>
                    </td>
                    <td className="text-right">
                      {item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Split Form */}
      {showRoute && (
        <div className="card mb-6 border-2 border-blue-300">
          <div className="card-header">
            <h2 className="card-title">🚚 Mark In Route</h2>
            <p className="text-sm text-gray-500 mt-1">
              Add the tracking number and the quantity that's actually shipping. If everything ships,
              this PO moves to <strong>In Route</strong>. If only part ships, that part is split into a
              child PO marked In Route — the rest stays open.
            </p>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="mark-in-route" />
              <input type="hidden" name="routesJson" value={routesJson} />

              <div className="form-group mb-4 max-w-md">
                <label className="form-label">Tracking number (optional)</label>
                <input
                  type="text"
                  name="trackingNumber"
                  value={routeTracking}
                  onChange={(e) => setRouteTracking(e.target.value)}
                  className="form-input"
                  placeholder="e.g. 1Z999..."
                />
              </div>

              <div className="overflow-x-auto mb-4">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th className="text-right">Remaining</th>
                      <th className="text-right">Shipping now</th>
                      <th className="text-right">Stays open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item) => {
                      const remaining = item.quantityOrdered - item.quantityReceived;
                      const q = routeDraft[item.id] ?? 0;
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
                              className="form-input w-28 text-right"
                              min="0"
                              max={remaining}
                              value={q || ""}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10) || 0;
                                setRouteDraft((prev) => ({ ...prev, [item.id]: Math.max(0, Math.min(remaining, v)) }));
                              }}
                              placeholder="0"
                            />
                          </td>
                          <td className="text-right">
                            <span className={q < remaining ? "font-semibold text-blue-700" : "text-gray-400"}>{remaining - q}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-sm text-gray-500 mb-3">
                {routeIsFull ? "Full shipment — this PO will move to In Route." : "Partial — a child PO will be split off and marked In Route."}
              </p>

              <div className="flex gap-3">
                <button type="submit" className="btn btn-primary" disabled={isSubmitting || !canSubmitRoute}>
                  {isSubmitting ? "Working…" : `Mark In Route (${routeTotal} units)`}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => { setShowRoute(false); setRouteDraft(initialRouteDraft); }}>Cancel</button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {showSplit && (
        <div className="card mb-6 border-2 border-purple-300">
          <div className="card-header">
            <h2 className="card-title">↳ Split PO</h2>
            <p className="text-sm text-gray-500 mt-1">
              Carve out a child PO with whatever portion of these items will arrive in a separate
              shipment. The child gets its own PO number, tracking, tariffs, and approval.
              The parent's quantity drops by the amount you split out.
            </p>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="split-po" />
              <input type="hidden" name="splitsJson" value={splitsJson} />

              <div className="overflow-x-auto mb-4">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th className="text-right">On Parent</th>
                      <th className="text-right">Split into Child</th>
                      <th className="text-right">Parent After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item) => {
                      const remaining = item.quantityOrdered - item.quantityReceived;
                      const splitQty = splitDraft[item.id] || 0;
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
                              className="form-input w-28 text-right"
                              min="0"
                              max={remaining}
                              value={splitQty || ""}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10) || 0;
                                setSplitDraft((prev) => ({
                                  ...prev,
                                  [item.id]: Math.max(0, Math.min(remaining, v)),
                                }));
                              }}
                              placeholder="0"
                            />
                          </td>
                          <td className="text-right">
                            <span className={splitQty > 0 ? "font-semibold text-purple-700" : "text-gray-400"}>
                              {remaining - splitQty}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="form-group">
                <label className="form-label">Notes for child PO (optional)</label>
                <input
                  type="text"
                  name="childNotes"
                  className="form-input"
                  placeholder="e.g. First batch arriving via DHL"
                />
              </div>

              <div className="flex gap-3 mt-4">
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={isSubmitting || !canSubmitSplit}
                >
                  {isSubmitting ? "Splitting..." : `Create Child PO (${splitTotal} units)`}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowSplit(false);
                    setSplitDraft({});
                  }}
                >
                  Cancel
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Receive Form */}
      {showReceive && (
        <div className="card mb-6 border-2 border-blue-300">
          <div className="card-header">
            <h2 className="card-title">Receive {po.poNumber}</h2>
            <p className="text-sm text-gray-500 mt-1">
              Record what physically arrived for this PO. Photos and notes are required when
              received qty doesn't match what's expected.
            </p>
          </div>
          <div className="card-body">
            <Form method="post" id="receive-form">
              <input type="hidden" name="intent" value="receive" />
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

              <div className="mb-6">
                <label className="form-label">Items Received</label>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th className="text-right">Expected</th>
                        <th className="text-right">Received Qty</th>
                        <th className="text-right">Actual $/unit</th>
                        <th>Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.items.map((item) => {
                        const draft = receiveDraft[item.id] || { qty: 0, cost: "" };
                        const variance = variancePerItem[item.id];
                        return (
                          <tr key={item.id}>
                            <td>
                              <div className="font-mono text-sm">{item.sku.sku.toUpperCase()}</div>
                              <div className="text-xs text-gray-500">{item.sku.name}</div>
                            </td>
                            <td className="text-right">{item.quantityOrdered}</td>
                            <td className="text-right">
                              <input
                                type="number"
                                className="form-input w-24 text-right"
                                min="0"
                                value={draft.qty || ""}
                                onChange={(e) => {
                                  const v = parseInt(e.target.value, 10) || 0;
                                  setReceiveDraft((prev) => ({
                                    ...prev,
                                    [item.id]: { ...draft, qty: Math.max(0, v) },
                                  }));
                                }}
                                placeholder="0"
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
                                  setReceiveDraft((prev) => ({
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
                                  Short by {item.quantityOrdered - draft.qty}
                                </span>
                              )}
                              {variance === "over" && (
                                <span className="badge bg-red-100 text-red-800">
                                  Over by {draft.qty - item.quantityOrdered}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

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

              <div className="mb-6">
                <ImageUpload
                  label="Packing Slip (required)"
                  helpText="Upload a photo of the packing slip"
                  folder="po-receipts/packing-slips"
                  onImageUploaded={(url) => setPackingSlipUrl(url)}
                />
              </div>

              <div className="mb-6">
                <MultiImageUpload
                  name="boxImageUrlsClient"
                  label={hasVariance ? "Box / Items Photos (required for variance)" : "Box / Items Photos"}
                  helpText="Upload photos of the box and contents"
                  folder="po-receipts/boxes"
                  initialUrls={boxImageUrls}
                  onChange={(urls) => setBoxImageUrls(urls)}
                />
              </div>

              <div className="flex gap-3 mt-4">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting || !canSubmitReceive}
                >
                  {isSubmitting ? "Recording..." : "Record Receipt"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowReceive(false);
                    setReceiveDraft(initialReceiveDraft);
                    setPackingSlipUrl("");
                    setBoxImageUrls([]);
                    setVarianceNotes("");
                  }}
                >
                  Cancel
                </button>
                {!canSubmitReceive && (
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

      {/* Receipt Details (when received or approved) */}
      {(po.status === "RECEIVED" || po.status === "APPROVED") && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Receipt Details</h2>
          </div>
          <div className="card-body space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500">Tracking</div>
                <div className="font-mono">{po.trackingNumber || "—"}</div>
              </div>
              <div>
                <div className="text-gray-500">Carrier</div>
                <div>{po.carrier || "—"}</div>
              </div>
              <div>
                <div className="text-gray-500">Tariff</div>
                <div>${po.tariffAmount.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-gray-500">Shipping</div>
                <div>${po.shippingCost.toFixed(2)}</div>
              </div>
            </div>

            {po.varianceNotes && (
              <div className="bg-orange-50 border border-orange-200 rounded p-3">
                <div className="text-xs font-semibold text-orange-700 mb-1">VARIANCE NOTES</div>
                <div className="text-sm whitespace-pre-wrap">{po.varianceNotes}</div>
              </div>
            )}

            {po.packingSlipImageUrl && (
              <div>
                <div className="text-xs font-semibold text-gray-500 mb-2">PACKING SLIP</div>
                <a href={po.packingSlipImageUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={po.packingSlipImageUrl}
                    alt="Packing slip"
                    className="max-w-md max-h-64 rounded border hover:opacity-90"
                  />
                </a>
              </div>
            )}

            {po.boxImageUrls.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 mb-2">
                  BOX / ITEMS PHOTOS ({po.boxImageUrls.length})
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {po.boxImageUrls.map((url, idx) => (
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
        </div>
      )}

      {/* Children */}
      {po.children.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Child POs ({po.children.length})</h2>
            <p className="text-sm text-gray-500 mt-1">
              Quantity that was split off into separate POs.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>PO #</th>
                  <th>Status</th>
                  <th className="text-right">Items</th>
                  <th className="text-right">Total qty</th>
                  <th>Tracking</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {po.children.map((child) => {
                  const totalQty = child.items.reduce((s, i) => s + i.quantityOrdered, 0);
                  return (
                    <tr key={child.id}>
                      <td className="font-mono text-sm">
                        <Link to={`/po/${child.id}`} className="text-blue-600 hover:underline">
                          {child.poNumber}
                        </Link>
                      </td>
                      <td>
                        <span className={`badge ${getStatusColor(child.status)}`}>
                          {child.status}
                        </span>
                        {child.hasVariance && (
                          <span className="ml-1 badge bg-orange-100 text-orange-800">Var</span>
                        )}
                      </td>
                      <td className="text-right">{child.items.length}</td>
                      <td className="text-right">{totalQty}</td>
                      <td className="text-sm">
                        {child.trackingNumber ? (
                          <span className="font-mono">{child.trackingNumber}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-sm">
                        {new Date(child.submittedAt).toLocaleDateString()}
                      </td>
                      <td>
                        <Link to={`/po/${child.id}`} className="text-blue-600 hover:underline text-sm">
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
