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
    const vendorName = (formData.get("vendorName") as string)?.trim();
    const estimatedArrival = formData.get("estimatedArrival") as string;
    const notes = formData.get("notes") as string;

    // Parse items
    const items: { skuId: string; quantity: number }[] = [];
    let i = 0;
    while (formData.get(`items[${i}][skuId]`)) {
      const skuId = formData.get(`items[${i}][skuId]`) as string;
      const quantity = parseInt(formData.get(`items[${i}][quantity]`) as string, 10);
      if (skuId && quantity > 0) {
        items.push({ skuId, quantity });
      }
      i++;
    }

    if (!vendorName) {
      return { error: "VENDOR NAME IS REQUIRED" };
    }
    if (items.length === 0) {
      return { error: "AT LEAST ONE ITEM IS REQUIRED" };
    }

    // Generate PO number
    const poCount = await prisma.purchaseOrder.count();
    const poNumber = `PO-${String(poCount + 1).padStart(5, "0")}`;

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        vendorName: vendorName.toUpperCase(),
        estimatedArrival: estimatedArrival ? new Date(estimatedArrival) : null,
        notes: notes?.toUpperCase() || null,
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
      vendorName,
      itemCount: items.length,
    });

    return {
      success: true,
      message: `PO ${poNumber} CREATED WITH ${items.length} ITEM(S)`,
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
      return { error: "PO NOT FOUND" };
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
        ? "ALL ITEMS RECEIVED - READY FOR APPROVAL"
        : "QUANTITIES UPDATED",
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
      return { error: "PO NOT FOUND" };
    }

    if (po.status === "APPROVED") {
      return { error: "PO ALREADY APPROVED" };
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
      message: `PO ${po.poNumber} APPROVED - ${totalReceived} UNITS ADDED TO INVENTORY`,
    };
  }

  return { error: "INVALID ACTION" };
};

export default function PurchaseOrders() {
  const { user, purchaseOrders, rawSkus, counts, currentStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedPO, setExpandedPO] = useState<string | null>(null);

  const tabs = [
    { id: "all", label: "ALL", count: counts.all },
    { id: "submitted", label: "SUBMITTED", count: counts.submitted },
    { id: "partial", label: "PARTIAL", count: counts.partial },
    { id: "received", label: "RECEIVED", count: counts.received },
    { id: "approved", label: "APPROVED", count: counts.approved },
  ];

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
          <h1 className="page-title">PURCHASE ORDERS</h1>
          <p className="page-subtitle">MANAGE INCOMING RAW MATERIALS</p>
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="btn btn-primary"
        >
          {showCreateForm ? "CLOSE" : "+ NEW PO"}
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
            <h2 className="card-title">CREATE PURCHASE ORDER</h2>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="create" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="form-group mb-0">
                  <label className="form-label">VENDOR NAME *</label>
                  <input
                    type="text"
                    name="vendorName"
                    className="form-input uppercase"
                    required
                    placeholder="VENDOR NAME"
                  />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">ESTIMATED ARRIVAL</label>
                  <input
                    type="date"
                    name="estimatedArrival"
                    className="form-input"
                  />
                </div>
                <div className="form-group mb-0">
                  <label className="form-label">NOTES</label>
                  <input
                    type="text"
                    name="notes"
                    className="form-input uppercase"
                    placeholder="OPTIONAL"
                  />
                </div>
              </div>

              {/* Items Selection */}
              <div className="mb-4">
                <label className="form-label">SELECT RAW MATERIALS</label>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-64 overflow-y-auto p-2 border rounded">
                  {rawSkus.map((sku, index) => (
                    <div
                      key={sku.id}
                      className="flex items-center gap-2 p-2 bg-gray-50 rounded"
                    >
                      <input
                        type="hidden"
                        name={`items[${index}][skuId]`}
                        value={sku.id}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm truncate">
                          {sku.sku.toUpperCase()}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {sku.name.toUpperCase()}
                        </div>
                      </div>
                      <input
                        type="number"
                        name={`items[${index}][quantity]`}
                        className="form-input w-20 text-sm"
                        min="0"
                        defaultValue="0"
                        placeholder="QTY"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "CREATING..." : "CREATE PO"}
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
              <h3 className="empty-state-title">NO PURCHASE ORDERS</h3>
              <p className="empty-state-description">
                CREATE YOUR FIRST PO USING THE BUTTON ABOVE.
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
                          {po.vendorName.toUpperCase()}
                        </div>
                      </div>
                      <span className={`badge ${getStatusColor(po.status)}`}>
                        {po.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <div className="text-gray-500">SUBMITTED</div>
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
                          <div className="text-gray-500">RECEIVED</div>
                          <div>
                            {new Date(po.receivedAt).toLocaleDateString()}
                          </div>
                        </div>
                      )}
                      <div className="text-right">
                        <div className="text-gray-500">ITEMS</div>
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
                            <th>NAME</th>
                            <th className="text-right">ORDERED</th>
                            <th className="text-right">RECEIVED</th>
                            {po.status !== "APPROVED" && (
                              <th className="text-right">RECEIVE QTY</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {po.items.map((item, idx) => (
                            <tr key={item.id}>
                              <td className="font-mono text-sm">
                                {item.sku.sku.toUpperCase()}
                              </td>
                              <td>{item.sku.name.toUpperCase()}</td>
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
                          VIEW PDF
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
                                UPDATE RECEIVED
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
                                  APPROVE & ADD TO INVENTORY
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
