import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  useLoaderData,
  useActionData,
  Form,
  Link,
  useNavigation,
} from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";

  const whereClause: any = {};
  if (status !== "all") {
    whereClause.status = status.toUpperCase();
  }

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: whereClause,
    include: {
      items: {
        include: {
          sku: true,
        },
      },
      createdBy: true,
      approvedBy: true,
    },
    orderBy: { submittedAt: "desc" },
    take: 100,
  });

  // Get raw material SKUs for creating new POs
  const rawSkus = await prisma.sku.findMany({
    where: { isActive: true, type: "RAW" },
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
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Create new PO
  if (intent === "create") {
    const estimatedArrival = formData.get("estimatedArrival") as string;
    const notes = formData.get("notes") as string;

    // Parse items from JSON
    const itemsJson = formData.get("itemsJson") as string;
    const items: { skuId: string; quantity: number }[] = itemsJson
      ? JSON.parse(itemsJson)
      : [];

    if (items.length === 0) {
      return { error: "At least one item is required" };
    }

    // Generate PO number
    const poCount = await prisma.purchaseOrder.count();
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
          })),
        },
      },
    });

    await createAuditLog(user.id, "CREATE_PO", "PurchaseOrder", po.id, {
      poNumber,
      itemCount: items.length,
    });

    return {
      success: true,
      message: `${poNumber} created with ${items.length} item(s)`,
    };
  }

  // Mark items as received
  if (intent === "receive") {
    const poId = formData.get("poId") as string;

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });

    if (!po) {
      return { error: "PO not found" };
    }

    // Parse received quantities
    const receivedItems: { itemId: string; quantity: number }[] = [];
    let i = 0;
    while (formData.get(`received[${i}][itemId]`)) {
      const itemId = formData.get(`received[${i}][itemId]`) as string;
      const quantity = parseInt(formData.get(`received[${i}][quantity]`) as string, 10);
      if (itemId && quantity > 0) {
        receivedItems.push({ itemId, quantity });
      }
      i++;
    }

    // Update received quantities
    for (const item of receivedItems) {
      await prisma.pOItem.update({
        where: { id: item.itemId },
        data: {
          quantityReceived: {
            increment: item.quantity,
          },
        },
      });
    }

    // Check if all items fully received
    const updatedPo = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: true },
    });

    const allReceived = updatedPo?.items.every(
      (item) => item.quantityReceived >= item.quantityOrdered
    );
    const someReceived = updatedPo?.items.some((item) => item.quantityReceived > 0);

    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        status: allReceived ? "RECEIVED" : someReceived ? "PARTIAL" : "SUBMITTED",
        receivedAt: allReceived ? new Date() : null,
      },
    });

    await createAuditLog(user.id, "RECEIVE_PO", "PurchaseOrder", poId, {
      receivedItems,
    });

    return {
      success: true,
      message: allReceived
        ? "All items received - ready for approval"
        : "Quantities updated",
    };
  }

  // Approve PO and add to inventory
  if (intent === "approve") {
    const poId = formData.get("poId") as string;

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { include: { sku: true } } },
    });

    if (!po) {
      return { error: "PO not found" };
    }

    if (po.status === "APPROVED") {
      return { error: "PO already approved" };
    }

    // Add received items to inventory
    for (const item of po.items) {
      if (item.quantityReceived > 0) {
        await addInventory(item.skuId, item.quantityReceived, "RAW");
      }
    }

    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });

    await createAuditLog(user.id, "APPROVE_PO", "PurchaseOrder", poId, {
      poNumber: po.poNumber,
    });

    const totalReceived = po.items.reduce((sum, i) => sum + i.quantityReceived, 0);
    return {
      success: true,
      message: `${po.poNumber} approved - ${totalReceived} units added to inventory`,
    };
  }

  return { error: "Invalid action" };
};

export default function PurchaseOrders() {
  const { user, purchaseOrders, rawSkus, counts, currentStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedPO, setExpandedPO] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<{ skuId: string; sku: string; name: string; quantity: number }[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "submitted", label: "Submitted", count: counts.submitted },
    { id: "partial", label: "Partial", count: counts.partial },
    { id: "received", label: "Received", count: counts.received },
    { id: "approved", label: "Approved", count: counts.approved },
  ];

  // Filter available SKUs based on search
  const availableSkus = rawSkus.filter((s) => {
    if (selectedItems.some((si) => si.skuId === s.id)) return false;
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      return s.sku.toLowerCase().includes(search) || s.name.toLowerCase().includes(search);
    }
    return true;
  });

  const addItem = (sku: typeof rawSkus[0]) => {
    setSelectedItems([...selectedItems, { skuId: sku.id, sku: sku.sku, name: sku.name, quantity: 1 }]);
    setSearchTerm("");
  };

  const updateQuantity = (skuId: string, quantity: number) => {
    setSelectedItems(selectedItems.map((item) => item.skuId === skuId ? { ...item, quantity: Math.max(1, quantity) } : item));
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
      case "SUBMITTED":
        return "bg-yellow-100 text-yellow-800";
      case "PARTIAL":
        return "bg-orange-100 text-orange-800";
      case "RECEIVED":
        return "bg-blue-100 text-blue-800";
      case "APPROVED":
        return "bg-green-100 text-green-800";
      case "CANCELLED":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
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
                value={JSON.stringify(selectedItems.map((i) => ({ skuId: i.skuId, quantity: i.quantity })))}
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

              {/* Selected Items */}
              {selectedItems.length > 0 && (
                <div className="mb-6">
                  <label className="form-label">Selected Items ({selectedItems.length})</label>
                  <div className="space-y-2">
                    {selectedItems.map((item) => (
                      <div key={item.skuId} className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded">
                        <div className="flex-1">
                          <span className="font-mono font-semibold">{item.sku.toUpperCase()}</span>
                          <span className="mx-2 text-gray-400">—</span>
                          <span className="text-gray-600">{item.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
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
                          <button type="button" onClick={() => removeItem(item.skuId)} className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add Items */}
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

      {/* PO List */}
      <div className="card">
        {purchaseOrders.length === 0 ? (
          <div className="card-body">
            <div className="empty-state">
              <svg
                className="empty-state-icon"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
                />
              </svg>
              <h3 className="empty-state-title">No purchase orders</h3>
              <p className="empty-state-description">
                Create your first PO using the button above.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {purchaseOrders.map((po) => {
              const totalOrdered = po.items.reduce(
                (sum, i) => sum + i.quantityOrdered,
                0
              );
              const totalReceived = po.items.reduce(
                (sum, i) => sum + i.quantityReceived,
                0
              );
              const isExpanded = expandedPO === po.id;

              return (
                <div key={po.id} className="p-4">
                  {/* PO Header Row */}
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedPO(isExpanded ? null : po.id)}
                  >
                    <div className="flex items-center gap-4">
                      <div>
                        <div className="font-mono font-semibold">
                          {po.poNumber}
                        </div>
                        <div className="text-sm text-gray-500">
                          {po.items.length} item{po.items.length !== 1 ? "s" : ""}
                        </div>
                      </div>
                      <span className={`badge ${getStatusColor(po.status)}`}>
                        {po.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <div className="text-gray-500">Submitted</div>
                        <div>{new Date(po.submittedAt).toLocaleDateString()}</div>
                      </div>
                      {po.estimatedArrival && (
                        <div className="text-right">
                          <div className="text-gray-500">ETA</div>
                          <div>
                            {new Date(po.estimatedArrival).toLocaleDateString()}
                          </div>
                        </div>
                      )}
                      {po.receivedAt && (
                        <div className="text-right">
                          <div className="text-gray-500">Received</div>
                          <div>
                            {new Date(po.receivedAt).toLocaleDateString()}
                          </div>
                        </div>
                      )}
                      <div className="text-right">
                        <div className="text-gray-500">Progress</div>
                        <div>
                          {totalReceived}/{totalOrdered}
                        </div>
                      </div>
                      <svg
                        className={`w-5 h-5 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t">
                      <table className="data-table mb-4">
                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>Name</th>
                            <th className="text-right">Ordered</th>
                            <th className="text-right">Received</th>
                            {po.status !== "APPROVED" && (
                              <th className="text-right">Receive Qty</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {po.items.map((item, idx) => (
                            <tr key={item.id}>
                              <td className="font-mono text-sm">
                                {item.sku.sku.toUpperCase()}
                              </td>
                              <td>{item.sku.name}</td>
                              <td className="text-right">{item.quantityOrdered}</td>
                              <td className="text-right">
                                <span
                                  className={
                                    item.quantityReceived >= item.quantityOrdered
                                      ? "text-green-600 font-semibold"
                                      : item.quantityReceived > 0
                                      ? "text-orange-600"
                                      : "text-gray-400"
                                  }
                                >
                                  {item.quantityReceived}
                                </span>
                              </td>
                              {po.status !== "APPROVED" && (
                                <td className="text-right">
                                  <input
                                    type="hidden"
                                    form={`receive-${po.id}`}
                                    name={`received[${idx}][itemId]`}
                                    value={item.id}
                                  />
                                  <input
                                    type="number"
                                    form={`receive-${po.id}`}
                                    name={`received[${idx}][quantity]`}
                                    className="form-input w-20 text-sm"
                                    min="0"
                                    max={item.quantityOrdered - item.quantityReceived}
                                    defaultValue="0"
                                  />
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {/* Action Buttons */}
                      <div className="flex gap-3">
                        <Link
                          to={`/po/${po.id}/pdf`}
                          className="btn btn-ghost"
                        >
                          <svg
                            className="w-4 h-4 mr-1 inline"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                            />
                          </svg>
                          View PDF
                        </Link>

                        {po.status !== "APPROVED" && (
                          <>
                            <Form method="post" id={`receive-${po.id}`}>
                              <input type="hidden" name="intent" value="receive" />
                              <input type="hidden" name="poId" value={po.id} />
                              <button
                                type="submit"
                                className="btn btn-secondary"
                                disabled={isSubmitting}
                              >
                                Update Received
                              </button>
                            </Form>

                            {(po.status === "RECEIVED" || po.status === "PARTIAL") && (
                              <Form method="post">
                                <input type="hidden" name="intent" value="approve" />
                                <input type="hidden" name="poId" value={po.id} />
                                <button
                                  type="submit"
                                  className="btn btn-primary"
                                  disabled={isSubmitting}
                                >
                                  Approve & Add to Inventory
                                </button>
                              </Form>
                            )}
                          </>
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
    </Layout>
  );
}
