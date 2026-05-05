import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  useLoaderData,
  useActionData,
  Form,
  Link,
  useNavigation,
} from "react-router";
import { useMemo, useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";
  const isMaster = status === "master";

  const whereClause: any = {};
  if (!isMaster && status !== "all") {
    whereClause.status = status.toUpperCase();
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: whereClause,
    include: {
      items: {
        include: { sku: true, manufacturer: true },
      },
      parentPO: { select: { id: true, poNumber: true } },
      children: {
        include: {
          items: { include: { sku: true } },
        },
        orderBy: { submittedAt: "asc" },
      },
      createdBy: true,
      approvedBy: true,
    },
    orderBy: { submittedAt: "desc" },
    take: isMaster ? 500 : 100,
  });

  const rawSkus = await prisma.sku.findMany({
    where: { isActive: true, type: "RAW" },
    include: {
      manufacturers: {
        include: { manufacturer: true },
        orderBy: { isPreferred: "desc" },
      },
    },
    orderBy: { sku: "asc" },
  });

  const counts = {
    all: await prisma.purchaseOrder.count(),
    submitted: await prisma.purchaseOrder.count({ where: { status: "SUBMITTED" } }),
    partial: await prisma.purchaseOrder.count({ where: { status: "PARTIAL" } }),
    received: await prisma.purchaseOrder.count({ where: { status: "RECEIVED" } }),
    approved: await prisma.purchaseOrder.count({ where: { status: "APPROVED" } }),
  };

  return { user, purchaseOrders, rawSkus, counts, currentStatus: status };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const estimatedArrival = formData.get("estimatedArrival") as string;
    const notes = formData.get("notes") as string;

    const itemsJson = formData.get("itemsJson") as string;
    const items: {
      skuId: string;
      quantity: number;
      manufacturerId?: string | null;
      unitCost?: number | null;
    }[] = itemsJson ? JSON.parse(itemsJson) : [];

    if (items.length === 0) {
      return { error: "At least one item is required" };
    }

    const poCount = await prisma.purchaseOrder.count({ where: { parentPOId: null } });
    const poNumber = `PO-${String(poCount + 1).padStart(5, "0")}`;

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        vendorName: "SUPPLIER",
        estimatedArrival: estimatedArrival ? new Date(estimatedArrival) : null,
        notes: notes || null,
        createdById: user.id,
        items: {
          create: items.map((item) => ({
            skuId: item.skuId,
            quantityOrdered: item.quantity,
            manufacturerId: item.manufacturerId || null,
            unitCost: item.unitCost && item.unitCost > 0 ? item.unitCost : null,
          })),
        },
      },
    });

    await createAuditLog(user.id, "CREATE_PO", "PurchaseOrder", po.id, {
      poNumber,
      itemCount: items.length,
    });

    return { success: true, message: `${poNumber} created with ${items.length} item(s)` };
  }

  if (intent === "delete") {
    const poId = formData.get("poId") as string;

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { children: true },
    });
    if (!po) return { error: "PO not found" };

    if (po.status === "APPROVED") {
      return { error: "Cannot delete an approved PO — inventory has been recorded" };
    }
    if (po.children.length > 0) {
      return {
        error: "Cannot delete a PO with child POs — delete the children first",
      };
    }

    // If this is a child, give its qty back to the parent's matching line items
    if (po.parentPOId) {
      const childItems = await prisma.pOItem.findMany({ where: { purchaseOrderId: poId } });
      for (const ci of childItems) {
        const parentItem = await prisma.pOItem.findFirst({
          where: { purchaseOrderId: po.parentPOId, skuId: ci.skuId },
        });
        if (parentItem) {
          await prisma.pOItem.update({
            where: { id: parentItem.id },
            data: { quantityOrdered: { increment: ci.quantityOrdered } },
          });
        } else {
          // Recreate the parent line if it had been zeroed out and removed
          await prisma.pOItem.create({
            data: {
              purchaseOrderId: po.parentPOId,
              skuId: ci.skuId,
              quantityOrdered: ci.quantityOrdered,
              manufacturerId: ci.manufacturerId,
              unitCost: ci.unitCost,
            },
          });
        }
      }
    }

    await prisma.pOItem.deleteMany({ where: { purchaseOrderId: poId } });
    await prisma.purchaseOrder.delete({ where: { id: poId } });

    await createAuditLog(user.id, "DELETE_PO", "PurchaseOrder", poId, {
      poNumber: po.poNumber,
      status: po.status,
    });

    return { success: true, message: `${po.poNumber} deleted` };
  }

  if (intent === "edit-item") {
    const poId = formData.get("poId") as string;
    const itemId = formData.get("itemId") as string;
    const newQuantity = parseInt(formData.get("quantity") as string, 10);

    if (isNaN(newQuantity) || newQuantity < 0) return { error: "Invalid quantity" };

    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return { error: "PO not found" };
    if (po.status !== "SUBMITTED") return { error: "Can only edit submitted POs" };

    await prisma.pOItem.update({
      where: { id: itemId },
      data: { quantityOrdered: newQuantity },
    });

    await createAuditLog(user.id, "EDIT_PO_ITEM", "PurchaseOrderItem", itemId, {
      poNumber: po.poNumber,
      newQuantity,
    });

    return { success: true, message: `Item quantity updated to ${newQuantity}` };
  }

  if (intent === "delete-item") {
    const poId = formData.get("poId") as string;
    const itemId = formData.get("itemId") as string;

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });
    if (!po) return { error: "PO not found" };
    if (po.status !== "SUBMITTED") return { error: "Can only edit submitted POs" };
    if (po.items.length <= 1) {
      return { error: "Cannot delete the only item — delete the entire PO instead" };
    }

    await prisma.pOItem.delete({ where: { id: itemId } });

    await createAuditLog(user.id, "DELETE_PO_ITEM", "PurchaseOrderItem", itemId, {
      poNumber: po.poNumber,
    });

    return { success: true, message: `Item removed from ${po.poNumber}` };
  }

  return { error: "Invalid action" };
};

type PO = Awaited<ReturnType<typeof loader>>["purchaseOrders"][number];

export default function PurchaseOrders() {
  const { user, purchaseOrders, rawSkus, counts, currentStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const isMaster = currentStatus === "master";

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedPO, setExpandedPO] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<{
    skuId: string;
    sku: string;
    name: string;
    quantity: number;
    manufacturerId?: string | null;
    unitCost?: number | null;
  }[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "submitted", label: "Submitted", count: counts.submitted },
    { id: "received", label: "Received", count: counts.received },
    { id: "approved", label: "Approved", count: counts.approved },
    { id: "master", label: "Master", count: counts.all },
  ];

  const availableSkus = rawSkus.filter((s) => {
    if (selectedItems.some((si) => si.skuId === s.id)) return false;
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      return s.sku.toLowerCase().includes(search) || s.name.toLowerCase().includes(search);
    }
    return true;
  });

  const addItem = (sku: typeof rawSkus[0]) => {
    const preferredManuf = sku.manufacturers.find((m) => m.isPreferred);
    const defaultManuf = preferredManuf || sku.manufacturers[0];
    const defaultManufId = defaultManuf?.manufacturerId || null;
    const defaultCost = defaultManuf?.cost ?? null;

    setSelectedItems([...selectedItems, {
      skuId: sku.id,
      sku: sku.sku,
      name: sku.name,
      quantity: 1,
      manufacturerId: defaultManufId,
      unitCost: defaultCost,
    }]);
    setSearchTerm("");
  };

  const updateQuantity = (skuId: string, quantity: number) => {
    setSelectedItems(selectedItems.map((item) => item.skuId === skuId ? { ...item, quantity: Math.max(1, quantity) } : item));
  };

  const updateManufacturer = (skuId: string, manufacturerId: string | null) => {
    const sku = rawSkus.find((s) => s.id === skuId);
    const matching = sku?.manufacturers.find((m) => m.manufacturerId === manufacturerId);
    setSelectedItems(selectedItems.map((item) =>
      item.skuId === skuId
        ? { ...item, manufacturerId, unitCost: matching?.cost ?? item.unitCost }
        : item
    ));
  };

  const updateUnitCost = (skuId: string, unitCost: number | null) => {
    setSelectedItems(selectedItems.map((item) =>
      item.skuId === skuId ? { ...item, unitCost } : item
    ));
  };

  const removeItem = (skuId: string) => {
    setSelectedItems(selectedItems.filter((item) => item.skuId !== skuId));
  };

  const resetForm = () => {
    setSelectedItems([]);
    setSearchTerm("");
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "SUBMITTED": return "bg-yellow-100 text-yellow-800";
      case "PARTIAL": return "bg-orange-100 text-orange-800";
      case "RECEIVED": return "bg-blue-100 text-blue-800";
      case "APPROVED": return "bg-green-100 text-green-800";
      case "CANCELLED": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">Manage incoming raw materials</p>
        </div>
        <button
          onClick={() => {
            setShowCreateForm(!showCreateForm);
            if (showCreateForm) resetForm();
          }}
          className="btn btn-primary"
        >
          {showCreateForm ? "Close" : "+ New PO"}
        </button>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Create PO Form */}
      {showCreateForm && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Create Purchase Order</h2>
          </div>
          <div className="card-body">
            <Form method="post" onSubmit={() => resetForm()}>
              <input type="hidden" name="intent" value="create" />
              <input
                type="hidden"
                name="itemsJson"
                value={JSON.stringify(selectedItems.map((i) => ({
                  skuId: i.skuId,
                  quantity: i.quantity,
                  manufacturerId: i.manufacturerId,
                  unitCost: i.unitCost,
                })))}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="form-group mb-0">
                  <label className="form-label">Estimated Arrival</label>
                  <input type="date" name="estimatedArrival" className="form-input" />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">Notes</label>
                  <input type="text" name="notes" className="form-input" placeholder="Optional notes" />
                </div>
              </div>

              {selectedItems.length > 0 && (
                <div className="mb-6">
                  <label className="form-label">Selected Items ({selectedItems.length})</label>
                  <div className="space-y-2">
                    {selectedItems.map((item) => {
                      const skuData = rawSkus.find((s) => s.id === item.skuId);
                      const manufacturers = skuData?.manufacturers || [];
                      const lineTotal = (item.unitCost || 0) * item.quantity;

                      return (
                        <div key={item.skuId} className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded gap-3 flex-wrap">
                          <div className="flex-1 min-w-0">
                            <span className="font-mono font-semibold">{item.sku.toUpperCase()}</span>
                            <span className="mx-2 text-gray-400">—</span>
                            <span className="text-gray-600">{item.name}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-wrap">
                            {manufacturers.length > 0 && (
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-500">From:</span>
                                <select
                                  value={item.manufacturerId || ""}
                                  onChange={(e) => updateManufacturer(item.skuId, e.target.value || null)}
                                  className="form-select text-sm"
                                >
                                  <option value="">— Select —</option>
                                  {manufacturers.map((m) => (
                                    <option key={m.id} value={m.manufacturerId}>
                                      {m.manufacturer.name}
                                      {m.isPreferred ? " (Preferred)" : ""}
                                      {m.cost ? ` - $${m.cost.toFixed(2)}` : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-gray-500">Qty:</span>
                              <input
                                type="number"
                                value={item.quantity}
                                onChange={(e) => updateQuantity(item.skuId, parseInt(e.target.value, 10))}
                                className="form-input w-20 text-center"
                                min="1"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-gray-500">$/unit:</span>
                              <input
                                type="number"
                                value={item.unitCost ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  updateUnitCost(item.skuId, v === "" ? null : parseFloat(v));
                                }}
                                className="form-input w-24 text-right"
                                min="0"
                                step="0.01"
                                placeholder="0.00"
                              />
                            </div>
                            <div className="text-sm text-gray-700 min-w-[80px] text-right">
                              <span className="text-gray-500">Total:</span>{" "}
                              <span className="font-semibold">${lineTotal.toFixed(2)}</span>
                            </div>
                            <button type="button" onClick={() => removeItem(item.skuId)} className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded">
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 text-right text-sm text-gray-700">
                    <span className="text-gray-500">Estimated PO subtotal:</span>{" "}
                    <span className="font-semibold">
                      ${selectedItems.reduce((s, i) => s + (i.unitCost || 0) * i.quantity, 0).toFixed(2)}
                    </span>
                    <span className="text-xs text-gray-400 ml-2">(excludes tariffs/shipping — captured at receipt)</span>
                  </div>
                </div>
              )}

              <div className="mb-6">
                <label className="form-label">Add Raw Materials</label>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="form-input mb-3"
                  placeholder="Search by SKU or name..."
                />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                  {availableSkus.map((sku) => (
                    <button
                      key={sku.id}
                      type="button"
                      onClick={() => addItem(sku)}
                      className="flex items-center gap-2 p-2 text-left rounded border bg-gray-50 border-gray-200 hover:border-blue-400 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm truncate">{sku.sku.toUpperCase()}</div>
                        <div className="text-xs text-gray-500 truncate">{sku.name}</div>
                      </div>
                      <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                    </button>
                  ))}
                  {availableSkus.length === 0 && (
                    <div className="col-span-full text-center text-gray-500 py-4">
                      {searchTerm ? "No materials match your search" : "All materials already added"}
                    </div>
                  )}
                </div>
              </div>

              <button type="submit" className="btn btn-primary" disabled={isSubmitting || selectedItems.length === 0}>
                {isSubmitting ? "Creating..." : "Create PO"}
              </button>
            </Form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/po?status=${tab.id}`}
            className={`tab ${currentStatus === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {isMaster ? (
        <MasterPOView purchaseOrders={purchaseOrders} getStatusColor={getStatusColor} />
      ) : (
        <div className="card">
          {purchaseOrders.length === 0 ? (
            <div className="card-body">
              <div className="empty-state">
                <h3 className="empty-state-title">No purchase orders</h3>
                <p className="empty-state-description">
                  Create your first PO using the button above.
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y">
              {purchaseOrders.map((po) => {
                const totalOrdered = po.items.reduce((sum, i) => sum + i.quantityOrdered, 0);
                const totalReceived = po.items.reduce((sum, i) => sum + i.quantityReceived, 0);
                const isExpanded = expandedPO === po.id;

                return (
                  <div key={po.id} className="p-4">
                    <div
                      className="flex items-center justify-between cursor-pointer flex-wrap gap-3"
                      onClick={() => setExpandedPO(isExpanded ? null : po.id)}
                    >
                      <div className="flex items-center gap-4 flex-wrap">
                        <div>
                          <div className="font-mono font-semibold flex items-center gap-2">
                            {po.poNumber}
                            {po.parentPO && (
                              <span className="text-xs font-normal text-gray-500">
                                child of <Link
                                  to={`/po/${po.parentPO.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-blue-600 hover:underline"
                                >{po.parentPO.poNumber}</Link>
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">
                            {po.items.length} item{po.items.length !== 1 ? "s" : ""}
                            {po.children.length > 0 && (
                              <span className="ml-2">
                                · {po.children.length} child{po.children.length !== 1 ? "ren" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className={`badge ${getStatusColor(po.status)}`}>
                          {po.status}
                        </span>
                        {po.parentPO && (
                          <span className="badge bg-purple-100 text-purple-800">Child</span>
                        )}
                        {po.hasVariance && (
                          <span className="badge bg-orange-100 text-orange-800">Variance</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="text-right">
                          <div className="text-gray-500">Submitted</div>
                          <div>{new Date(po.submittedAt).toLocaleDateString()}</div>
                        </div>
                        {po.estimatedArrival && (
                          <div className="text-right">
                            <div className="text-gray-500">ETA</div>
                            <div>{new Date(po.estimatedArrival).toLocaleDateString()}</div>
                          </div>
                        )}
                        <div className="text-right">
                          <div className="text-gray-500">Progress</div>
                          <div>{totalReceived}/{totalOrdered}</div>
                        </div>
                        {po.status === "SUBMITTED" && totalOrdered > 0 && (
                          <Link
                            to={`/po/${po.id}?split=1`}
                            onClick={(e) => e.stopPropagation()}
                            className="btn btn-secondary btn-sm whitespace-nowrap"
                          >
                            ↳ Split
                          </Link>
                        )}
                        {po.status === "SUBMITTED" && totalOrdered > 0 && (
                          <Link
                            to={`/po/${po.id}?receive=1`}
                            onClick={(e) => e.stopPropagation()}
                            className="btn btn-primary btn-sm whitespace-nowrap"
                          >
                            + Receive
                          </Link>
                        )}
                        <svg
                          className={`w-5 h-5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t">
                        <table className="data-table mb-4">
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Name</th>
                              <th className="text-right">Ordered</th>
                              <th className="text-right">Received</th>
                              <th className="text-right">$/unit</th>
                              {po.status === "SUBMITTED" && <th className="text-right">Actions</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {po.items.map((item) => (
                              <tr key={item.id}>
                                <td className="font-mono text-sm">{item.sku.sku.toUpperCase()}</td>
                                <td>{item.sku.name}</td>
                                <td className="text-right">
                                  {po.status === "SUBMITTED" ? (
                                    <Form method="post" className="inline-flex items-center gap-1">
                                      <input type="hidden" name="intent" value="edit-item" />
                                      <input type="hidden" name="poId" value={po.id} />
                                      <input type="hidden" name="itemId" value={item.id} />
                                      <input
                                        type="number" name="quantity"
                                        className="form-input w-20 text-sm text-right"
                                        defaultValue={item.quantityOrdered} min="0"
                                      />
                                      <button type="submit" className="btn btn-xs btn-ghost" title="Save">✓</button>
                                    </Form>
                                  ) : (
                                    item.quantityOrdered
                                  )}
                                </td>
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
                                {po.status === "SUBMITTED" && (
                                  <td className="text-right">
                                    {po.items.length > 1 && (
                                      <Form method="post" className="inline" onSubmit={(e) => {
                                        if (!confirm("Remove this item from the PO?")) e.preventDefault();
                                      }}>
                                        <input type="hidden" name="intent" value="delete-item" />
                                        <input type="hidden" name="poId" value={po.id} />
                                        <input type="hidden" name="itemId" value={item.id} />
                                        <button type="submit" className="btn btn-xs btn-error" title="Remove item">✕</button>
                                      </Form>
                                    )}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {po.children.length > 0 && (
                          <div className="mb-4">
                            <h4 className="text-sm font-semibold text-gray-700 mb-2">Children</h4>
                            <table className="data-table text-sm">
                              <thead>
                                <tr>
                                  <th>PO #</th>
                                  <th>Status</th>
                                  <th className="text-right">Total qty</th>
                                  <th>Tracking</th>
                                  <th>Date</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {po.children.map((c) => {
                                  const cQty = c.items.reduce((s, i) => s + i.quantityOrdered, 0);
                                  return (
                                    <tr key={c.id}>
                                      <td className="font-mono">
                                        <Link to={`/po/${c.id}`} onClick={(e) => e.stopPropagation()} className="text-blue-600 hover:underline">
                                          {c.poNumber}
                                        </Link>
                                      </td>
                                      <td>
                                        <span className={`badge ${getStatusColor(c.status)}`}>{c.status}</span>
                                      </td>
                                      <td className="text-right">{cQty}</td>
                                      <td>{c.trackingNumber || "—"}</td>
                                      <td>{new Date(c.submittedAt).toLocaleDateString()}</td>
                                      <td className="text-right">
                                        <Link to={`/po/${c.id}`} onClick={(e) => e.stopPropagation()} className="text-blue-600 hover:underline text-xs">Open →</Link>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="flex gap-3 flex-wrap">
                          <Link to={`/po/${po.id}`} className="btn btn-primary">
                            Open PO
                          </Link>
                          <Link to={`/po/${po.id}/pdf`} className="btn btn-ghost">
                            View PDF
                          </Link>
                          {po.status !== "APPROVED" && po.children.length === 0 && (
                            <Form method="post" onSubmit={(e) => {
                              if (!confirm(`Delete ${po.poNumber}? This cannot be undone.`)) e.preventDefault();
                            }}>
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="poId" value={po.id} />
                              <button type="submit" className="btn btn-error btn-sm" disabled={isSubmitting}>
                                Delete
                              </button>
                            </Form>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}

function MasterPOView({
  purchaseOrders,
  getStatusColor,
}: {
  purchaseOrders: PO[];
  getStatusColor: (status: string) => string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateMode, setDateMode] = useState<"received" | "po">("received");

  // Only show roots in master view; children render inside their parent's dropdown
  const rootPOs = useMemo(
    () => purchaseOrders.filter((po) => !po.parentPO),
    [purchaseOrders]
  );

  // For each root, build a per-SKU rollup across the root and its children
  const allRows = useMemo(
    () =>
      rootPOs.flatMap((root) => {
        // Collect every "delivery PO" — root + children
        type Delivery = {
          po: {
            id: string;
            poNumber: string;
            status: string;
            trackingNumber: string | null;
            carrier: string | null;
            tariffAmount: number;
            shippingCost: number;
            receivedAt: Date | null;
            hasVariance: boolean;
            submittedAt: Date;
          };
          isRoot: boolean;
        };
        const deliveries: Delivery[] = [
          {
            po: {
              id: root.id,
              poNumber: root.poNumber,
              status: root.status,
              trackingNumber: root.trackingNumber,
              carrier: root.carrier,
              tariffAmount: root.tariffAmount,
              shippingCost: root.shippingCost,
              receivedAt: root.receivedAt,
              hasVariance: root.hasVariance,
              submittedAt: root.submittedAt,
            },
            isRoot: true,
          },
          ...root.children.map((c) => ({
            po: {
              id: c.id,
              poNumber: c.poNumber,
              status: c.status,
              trackingNumber: c.trackingNumber,
              carrier: c.carrier,
              tariffAmount: c.tariffAmount,
              shippingCost: c.shippingCost,
              receivedAt: c.receivedAt,
              hasVariance: c.hasVariance,
              submittedAt: c.submittedAt,
            },
            isRoot: false,
          })),
        ];

        // Group all items (root + children) by SKU
        type ItemDelivery = {
          po: Delivery["po"];
          isRoot: boolean;
          quantityOrdered: number;
          quantityReceived: number;
          unitCost: number | null;
        };
        const skuMap = new Map<
          string,
          {
            sku: { sku: string; name: string };
            manufacturerName: string | null;
            entries: ItemDelivery[];
          }
        >();

        type ItemLike = {
          skuId: string;
          quantityOrdered: number;
          quantityReceived: number;
          unitCost: number | null;
          sku: { sku: string; name: string };
          manufacturer?: { name: string } | null;
        };
        const addItems = (items: ItemLike[], d: Delivery) => {
          for (const item of items) {
            const key = item.skuId;
            const existing = skuMap.get(key);
            const entry: ItemDelivery = {
              po: d.po,
              isRoot: d.isRoot,
              quantityOrdered: item.quantityOrdered,
              quantityReceived: item.quantityReceived,
              unitCost: item.unitCost,
            };
            if (existing) {
              existing.entries.push(entry);
            } else {
              skuMap.set(key, {
                sku: { sku: item.sku.sku, name: item.sku.name },
                manufacturerName:
                  "manufacturer" in item ? (item.manufacturer?.name ?? null) : null,
                entries: [entry],
              });
            }
          }
        };
        addItems(root.items, deliveries[0]);
        root.children.forEach((c, idx) => addItems(c.items, deliveries[idx + 1]));

        return Array.from(skuMap.entries()).map(([skuId, data]) => {
          const totalOrdered = data.entries.reduce((s, e) => s + e.quantityOrdered, 0);
          const totalReceived = data.entries.reduce((s, e) => s + e.quantityReceived, 0);
          // Items cost only — tariff/shipping are per-PO, shown per-delivery in the dropdown
          const totalCost = data.entries.reduce(
            (s, e) =>
              e.po.status === "RECEIVED" || e.po.status === "APPROVED"
                ? s + (e.unitCost ?? 0) * e.quantityReceived
                : s,
            0
          );

          return {
            rowId: `${root.id}-${skuId}`,
            root,
            skuId,
            sku: data.sku,
            manufacturerName: data.manufacturerName,
            entries: data.entries,
            totalOrdered,
            totalReceived,
            totalCost,
          };
        });
      }),
    [rootPOs]
  );

  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 - 1 : null;

  const inDateRange = (d: Date | string | null) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    return true;
  };

  const searchLower = search.trim().toLowerCase();
  const matchesSearch = (row: (typeof allRows)[number]) => {
    if (!searchLower) return true;
    if (row.root.poNumber.toLowerCase().includes(searchLower)) return true;
    if (row.sku.sku.toLowerCase().includes(searchLower)) return true;
    if (row.sku.name.toLowerCase().includes(searchLower)) return true;
    if (row.manufacturerName?.toLowerCase().includes(searchLower)) return true;
    if (
      row.entries.some(
        (e) =>
          e.po.poNumber.toLowerCase().includes(searchLower) ||
          e.po.trackingNumber?.toLowerCase().includes(searchLower)
      )
    )
      return true;
    return false;
  };

  const filteredRows = allRows
    .map((row) => {
      const visibleEntries =
        dateMode === "received" && (fromMs != null || toMs != null)
          ? row.entries.filter((e) =>
              e.po.status === "RECEIVED" || e.po.status === "APPROVED"
                ? inDateRange(e.po.receivedAt)
                : false
            )
          : row.entries;
      return { ...row, visibleEntries };
    })
    .filter((row) => {
      if (!matchesSearch(row)) return false;
      if (fromMs == null && toMs == null) return true;
      if (dateMode === "po") {
        return inDateRange(row.root.submittedAt);
      }
      return row.visibleEntries.length > 0;
    });

  const filtersActive = !!searchLower || dateFrom !== "" || dateTo !== "";
  const dateFiltered = dateMode === "received" && (fromMs != null || toMs != null);

  const clearFilters = () => {
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setDateMode("received");
  };

  if (allRows.length === 0) {
    return (
      <div className="card">
        <div className="card-body">
          <div className="empty-state">
            <h3 className="empty-state-title">No PO items</h3>
            <p className="empty-state-description">Create a PO to populate the master view.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">Master PO View</h2>
        <p className="text-sm text-gray-500 mt-1">
          One row per PO line item, summed across the parent and its child POs.
          Click a row to see each delivery (parent receipt + child POs).
        </p>
      </div>
      <div className="card-body border-b">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="form-group mb-0 lg:col-span-2">
            <label className="form-label">Search</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input"
              placeholder="PO #, SKU, name, manufacturer, tracking..."
            />
          </div>
          <div className="form-group mb-0">
            <label className="form-label">Date filter applies to</label>
            <select
              value={dateMode}
              onChange={(e) => setDateMode(e.target.value as "received" | "po")}
              className="form-select"
            >
              <option value="received">Receipt date</option>
              <option value="po">PO submitted date</option>
            </select>
          </div>
          <div className="form-group mb-0">
            <label className="form-label">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="form-input"
            />
          </div>
          <div className="form-group mb-0">
            <label className="form-label">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="form-input"
            />
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 text-sm text-gray-600">
          <div>
            Showing <span className="font-semibold">{filteredRows.length}</span> of{" "}
            {allRows.length} line item{allRows.length !== 1 ? "s" : ""}
          </div>
          {filtersActive && (
            <button type="button" onClick={clearFilters} className="btn btn-xs btn-ghost">
              Clear filters
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Root PO</th>
              <th>SKU</th>
              <th>Name</th>
              <th>Mfr</th>
              <th>Status</th>
              <th className="text-right">Ordered</th>
              <th className="text-right">Received</th>
              <th className="text-right">Items cost</th>
              <th>Deliveries</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-gray-500 py-8">
                  No line items match the current filters.
                </td>
              </tr>
            )}
            {filteredRows.map((row) => {
              const isOpen = expanded === row.rowId;
              const visibleEntries = row.visibleEntries;
              const visibleApproved = visibleEntries.filter(
                (e) => e.po.status === "RECEIVED" || e.po.status === "APPROVED"
              );
              const displayedReceived = dateFiltered
                ? visibleApproved.reduce((s, e) => s + e.quantityReceived, 0)
                : row.totalReceived;
              const displayedCost = dateFiltered
                ? visibleApproved.reduce(
                    (s, e) => s + (e.unitCost ?? 0) * e.quantityReceived,
                    0
                  )
                : row.totalCost;

              return (
                <>
                  <tr
                    key={row.rowId}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => setExpanded(isOpen ? null : row.rowId)}
                  >
                    <td>
                      <Link
                        to={`/po/${row.root.id}`}
                        className="font-mono text-sm text-blue-600 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {row.root.poNumber}
                      </Link>
                    </td>
                    <td className="font-mono text-sm">{row.sku.sku.toUpperCase()}</td>
                    <td className="max-w-xs truncate">{row.sku.name}</td>
                    <td className="text-sm">{row.manufacturerName || "—"}</td>
                    <td>
                      <span className={`badge ${getStatusColor(row.root.status)}`}>
                        {row.root.status}
                      </span>
                    </td>
                    <td className="text-right">{row.totalOrdered}</td>
                    <td className="text-right">
                      <span className={
                        displayedReceived >= row.totalOrdered && row.totalOrdered > 0
                          ? "text-green-600 font-semibold"
                          : displayedReceived > 0
                          ? "text-orange-600"
                          : "text-gray-400"
                      }>
                        {displayedReceived}
                      </span>
                      {dateFiltered && <span className="ml-1 text-xs text-gray-400">in range</span>}
                    </td>
                    <td className="text-right font-semibold">${displayedCost.toFixed(2)}</td>
                    <td>
                      <div className="flex items-center gap-1 text-xs text-gray-600">
                        <span>
                          {visibleEntries.length} {visibleEntries.length === 1 ? "PO" : "POs"}
                        </span>
                        <svg
                          className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                          fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </div>
                    </td>
                  </tr>
                  {isOpen && visibleEntries.length > 0 && (
                    <tr>
                      <td colSpan={9} className="bg-gray-50 p-0">
                        <div className="p-4">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-gray-600">
                                <th className="pb-2">PO</th>
                                <th className="pb-2">Status</th>
                                <th className="pb-2">Tracking</th>
                                <th className="pb-2">Carrier</th>
                                <th className="pb-2">Date</th>
                                <th className="pb-2 text-right">Ordered</th>
                                <th className="pb-2 text-right">Received</th>
                                <th className="pb-2 text-right">$/unit</th>
                                <th className="pb-2 text-right">Tariff</th>
                                <th className="pb-2 text-right">Shipping</th>
                                <th className="pb-2"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleEntries.map((e, idx) => (
                                <tr key={`${e.po.id}-${idx}`} className="border-t border-gray-200">
                                  <td className="py-2 font-mono">
                                    {e.po.poNumber}
                                    {e.isRoot && (
                                      <span className="ml-1 text-xs text-gray-400">(root)</span>
                                    )}
                                  </td>
                                  <td className="py-2">
                                    <span className={`badge ${getStatusColor(e.po.status)}`}>
                                      {e.po.status}
                                    </span>
                                    {e.po.hasVariance && (
                                      <span className="ml-1 badge bg-orange-100 text-orange-800">Var</span>
                                    )}
                                  </td>
                                  <td className="py-2">{e.po.trackingNumber || "—"}</td>
                                  <td className="py-2">{e.po.carrier || "—"}</td>
                                  <td className="py-2">
                                    {e.po.receivedAt
                                      ? new Date(e.po.receivedAt).toLocaleDateString()
                                      : <span className="text-gray-400">not received</span>}
                                  </td>
                                  <td className="py-2 text-right">{e.quantityOrdered}</td>
                                  <td className="py-2 text-right">{e.quantityReceived}</td>
                                  <td className="py-2 text-right">
                                    {e.unitCost != null ? `$${e.unitCost.toFixed(2)}` : "—"}
                                  </td>
                                  <td className="py-2 text-right">${e.po.tariffAmount.toFixed(2)}</td>
                                  <td className="py-2 text-right">${e.po.shippingCost.toFixed(2)}</td>
                                  <td className="py-2 text-right">
                                    <Link
                                      to={`/po/${e.po.id}`}
                                      className="text-blue-600 hover:underline text-xs"
                                      onClick={(ev) => ev.stopPropagation()}
                                    >
                                      Details →
                                    </Link>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
