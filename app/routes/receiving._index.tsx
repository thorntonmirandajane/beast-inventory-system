import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { useState, useMemo } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory, getAvailableQuantity } from "../utils/inventory.server";
import type { InventoryState } from "@prisma/client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";

  const whereClause = status === "all" ? {} : { status: status.toUpperCase() as any };

  const records = await prisma.receivingRecord.findMany({
    where: whereClause,
    include: {
      sku: true,
      createdBy: true,
      signedOffBy: true,
    },
    orderBy: { receivedAt: "desc" },
    take: 100,
  });

  const skus = await prisma.sku.findMany({
    where: { isActive: true, type: "RAW" },
    orderBy: { sku: "asc" },
  });

  const counts = {
    all: await prisma.receivingRecord.count(),
    pending: await prisma.receivingRecord.count({ where: { status: "PENDING" } }),
    approved: await prisma.receivingRecord.count({ where: { status: "APPROVED" } }),
    rejected: await prisma.receivingRecord.count({ where: { status: "REJECTED" } }),
  };

  // Get all buildable SKUs (ASSEMBLY and COMPLETED) with their BOM
  const buildableSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      bomComponents: { some: {} },
    },
    include: {
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get current inventory for all raw materials
  const rawInventory: Record<string, number> = {};
  for (const sku of skus) {
    rawInventory[sku.id] = await getAvailableQuantity(sku.id, ["RAW"]);
  }

  // Get current inventory for assemblies (needed for completed products that use assemblies)
  const assemblySkus = await prisma.sku.findMany({
    where: { isActive: true, type: "ASSEMBLY" },
  });
  const assemblyInventory: Record<string, number> = {};
  for (const sku of assemblySkus) {
    assemblyInventory[sku.id] = await getAvailableQuantity(sku.id, ["ASSEMBLED"]);
  }

  // Format buildable data for client
  const buildableData = buildableSkus.map((sku) => ({
    id: sku.id,
    sku: sku.sku,
    name: sku.name,
    type: sku.type,
    components: sku.bomComponents.map((bom) => ({
      skuId: bom.componentSkuId,
      sku: bom.componentSku.sku,
      name: bom.componentSku.name,
      type: bom.componentSku.type,
      quantityRequired: bom.quantity,
    })),
  }));

  return {
    user,
    records,
    skus,
    counts,
    currentStatus: status,
    buildableData,
    rawInventory,
    assemblyInventory,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Create new receiving record (single item - legacy)
  if (intent === "create") {
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    const poNumber = formData.get("poNumber") as string;
    const vendorName = formData.get("vendorName") as string;
    const notes = formData.get("notes") as string;

    if (!skuId || !quantity || quantity <= 0) {
      return { error: "SKU and valid quantity are required" };
    }

    const record = await prisma.receivingRecord.create({
      data: {
        skuId,
        quantity,
        poNumber: poNumber || null,
        vendorName: vendorName || null,
        notes: notes || null,
        createdById: user.id,
      },
    });

    await createAuditLog(user.id, "RECEIVE", "ReceivingRecord", record.id, {
      skuId,
      quantity,
      poNumber,
      vendorName,
    });

    return { success: true, message: `Received ${quantity} units` };
  }

  // Bulk create receiving records
  if (intent === "bulk-create") {
    const poNumber = formData.get("poNumber") as string;
    const vendorName = formData.get("vendorName") as string;
    const notes = formData.get("notes") as string;

    // Parse items from form data
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

    if (items.length === 0) {
      return { error: "At least one item with quantity is required" };
    }

    // Create receiving records for each item
    let totalQuantity = 0;
    for (const item of items) {
      const record = await prisma.receivingRecord.create({
        data: {
          skuId: item.skuId,
          quantity: item.quantity,
          poNumber: poNumber || null,
          vendorName: vendorName || null,
          notes: notes || null,
          createdById: user.id,
        },
      });

      await createAuditLog(user.id, "RECEIVE", "ReceivingRecord", record.id, {
        skuId: item.skuId,
        quantity: item.quantity,
        poNumber,
        vendorName,
      });

      totalQuantity += item.quantity;
    }

    return {
      success: true,
      message: `Received ${totalQuantity} units across ${items.length} SKU(s)`,
    };
  }

  // Sign off on receiving record
  if (intent === "signoff") {
    const recordId = formData.get("recordId") as string;
    const action = formData.get("action") as "approve" | "reject";

    const record = await prisma.receivingRecord.findUnique({
      where: { id: recordId },
      include: { sku: true },
    });

    if (!record) {
      return { error: "Record not found" };
    }

    if (record.status !== "PENDING") {
      return { error: "Record already processed" };
    }

    const newStatus = action === "approve" ? "APPROVED" : "REJECTED";

    await prisma.receivingRecord.update({
      where: { id: recordId },
      data: {
        status: newStatus,
        signedOffById: user.id,
        signedOffAt: new Date(),
      },
    });

    // If approved, add to RAW inventory
    if (action === "approve") {
      await addInventory(record.skuId, record.quantity, "RAW");
    }

    await createAuditLog(user.id, "SIGN_OFF", "ReceivingRecord", recordId, {
      action,
      quantity: record.quantity,
      skuId: record.skuId,
    });

    return {
      success: true,
      message: action === "approve"
        ? `Approved and added ${record.quantity} units to inventory`
        : "Receiving record rejected",
    };
  }

  return { error: "Invalid action" };
};

export default function Receiving() {
  const {
    user,
    records,
    skus,
    counts,
    currentStatus,
    buildableData,
    rawInventory,
    assemblyInventory,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Track quantities being received (for build impact calculation)
  const [receivingQuantities, setReceivingQuantities] = useState<Record<string, number>>({});

  // Calculate build impact based on receiving quantities
  const buildImpact = useMemo(() => {
    // Create combined inventory (current + receiving)
    const projectedRawInventory: Record<string, number> = { ...rawInventory };
    for (const [skuId, qty] of Object.entries(receivingQuantities)) {
      projectedRawInventory[skuId] = (projectedRawInventory[skuId] || 0) + qty;
    }

    // Calculate max buildable for each buildable SKU
    return buildableData.map((sku) => {
      let currentMaxBuild = Infinity;
      let projectedMaxBuild = Infinity;
      let bottleneck: { sku: string; needed: number; have: number } | null = null;

      for (const comp of sku.components) {
        // Get available inventory based on component type
        const currentAvailable =
          comp.type === "RAW"
            ? rawInventory[comp.skuId] || 0
            : assemblyInventory[comp.skuId] || 0;

        const projectedAvailable =
          comp.type === "RAW"
            ? projectedRawInventory[comp.skuId] || 0
            : assemblyInventory[comp.skuId] || 0;

        const currentCanBuild = Math.floor(currentAvailable / comp.quantityRequired);
        const projectedCanBuild = Math.floor(projectedAvailable / comp.quantityRequired);

        if (currentCanBuild < currentMaxBuild) {
          currentMaxBuild = currentCanBuild;
        }
        if (projectedCanBuild < projectedMaxBuild) {
          projectedMaxBuild = projectedCanBuild;
          if (projectedCanBuild === 0) {
            bottleneck = {
              sku: comp.sku,
              needed: comp.quantityRequired,
              have: projectedAvailable,
            };
          }
        }
      }

      if (currentMaxBuild === Infinity) currentMaxBuild = 0;
      if (projectedMaxBuild === Infinity) projectedMaxBuild = 0;

      return {
        ...sku,
        currentMaxBuild,
        projectedMaxBuild,
        gain: projectedMaxBuild - currentMaxBuild,
        bottleneck,
      };
    });
  }, [receivingQuantities, rawInventory, assemblyInventory, buildableData]);

  const hasReceivingInput = Object.values(receivingQuantities).some((q) => q > 0);
  const totalGain = buildImpact.reduce((sum, item) => sum + item.gain, 0);

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "pending", label: "Pending", count: counts.pending },
    { id: "approved", label: "Approved", count: counts.approved },
    { id: "rejected", label: "Rejected", count: counts.rejected },
  ];

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start">
        <div>
          <h1 className="page-title">Receiving</h1>
          <p className="page-subtitle">Record and sign off on incoming inventory</p>
        </div>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Bulk Receiving Form */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Bulk Receive Raw Materials</h2>
          <p className="text-sm text-gray-500 mt-1">
            Enter quantities to see build impact in real-time
          </p>
        </div>
        <div className="card-body">
          <Form method="post" id="bulk-receive-form">
            <input type="hidden" name="intent" value="bulk-create" />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="form-group mb-0">
                <label className="form-label">PO Number</label>
                <input
                  type="text"
                  name="poNumber"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Vendor</label>
                <input
                  type="text"
                  name="vendorName"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
            </div>

            {/* Raw Materials Table */}
            <div className="overflow-x-auto mb-4">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th className="text-right">Current Stock</th>
                    <th className="w-32">Receive Qty</th>
                    <th className="text-right">New Total</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map((sku, index) => {
                    const currentQty = rawInventory[sku.id] || 0;
                    const receiving = receivingQuantities[sku.id] || 0;
                    const newTotal = currentQty + receiving;

                    return (
                      <tr key={sku.id}>
                        <td>
                          <input
                            type="hidden"
                            name={`items[${index}][skuId]`}
                            value={sku.id}
                          />
                          <span className="font-mono text-sm">{sku.sku}</span>
                        </td>
                        <td className="max-w-xs truncate">{sku.name}</td>
                        <td className="text-right">
                          <span
                            className={
                              currentQty > 0
                                ? "font-semibold text-green-600"
                                : "text-gray-400"
                            }
                          >
                            {currentQty}
                          </span>
                        </td>
                        <td>
                          <input
                            type="number"
                            name={`items[${index}][quantity]`}
                            className="form-input w-24"
                            min="0"
                            value={receiving || ""}
                            placeholder="0"
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 0;
                              setReceivingQuantities((prev) => ({
                                ...prev,
                                [sku.id]: val,
                              }));
                            }}
                          />
                        </td>
                        <td className="text-right">
                          {receiving > 0 ? (
                            <span className="font-semibold text-blue-600">
                              {newTotal}
                              <span className="text-xs text-green-600 ml-1">
                                (+{receiving})
                              </span>
                            </span>
                          ) : (
                            <span className="text-gray-400">{currentQty}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Build Impact Preview */}
            {hasReceivingInput && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <h3 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605"
                    />
                  </svg>
                  Build Impact Preview
                  {totalGain > 0 && (
                    <span className="bg-green-100 text-green-800 px-2 py-0.5 rounded text-sm">
                      +{totalGain} total buildable
                    </span>
                  )}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-blue-800">
                        <th className="pb-2">Product</th>
                        <th className="pb-2">Type</th>
                        <th className="pb-2 text-right">Current</th>
                        <th className="pb-2 text-right">After Receipt</th>
                        <th className="pb-2 text-right">Gain</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buildImpact.map((item) => (
                        <tr key={item.id} className="border-t border-blue-200">
                          <td className="py-2">
                            <span className="font-mono text-xs">{item.sku}</span>
                            <span className="text-gray-600 ml-2">{item.name}</span>
                          </td>
                          <td className="py-2">
                            <span
                              className={`badge ${
                                item.type === "ASSEMBLY"
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-green-100 text-green-800"
                              }`}
                            >
                              {item.type}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <span
                              className={
                                item.currentMaxBuild > 0
                                  ? "text-gray-700"
                                  : "text-gray-400"
                              }
                            >
                              {item.currentMaxBuild}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <span
                              className={
                                item.projectedMaxBuild > 0
                                  ? "font-semibold text-blue-700"
                                  : "text-gray-400"
                              }
                            >
                              {item.projectedMaxBuild}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            {item.gain > 0 ? (
                              <span className="font-semibold text-green-600">
                                +{item.gain}
                              </span>
                            ) : item.bottleneck ? (
                              <span className="text-xs text-orange-600">
                                Need {item.bottleneck.sku}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea
                name="notes"
                className="form-textarea"
                rows={2}
                placeholder="Optional notes for this receipt..."
              />
            </div>

            <div className="flex gap-3 mt-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || !hasReceivingInput}
              >
                {isSubmitting ? "Recording..." : "Record Receipt"}
              </button>
              {hasReceivingInput && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setReceivingQuantities({})}
                >
                  Clear All
                </button>
              )}
            </div>
          </Form>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/receiving?status=${tab.id}`}
            className={`tab ${currentStatus === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Records Table */}
      <div className="card">
        {records.length === 0 ? (
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
                  d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12"
                />
              </svg>
              <h3 className="empty-state-title">No receiving records</h3>
              <p className="empty-state-description">
                Record your first receipt using the form above.
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Quantity</th>
                <th>PO #</th>
                <th>Received</th>
                <th>Status</th>
                <th>Signed Off By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <span className="font-mono text-sm">{record.sku.sku}</span>
                  </td>
                  <td className="max-w-xs truncate">{record.sku.name}</td>
                  <td className="font-semibold">{record.quantity}</td>
                  <td>{record.poNumber || "—"}</td>
                  <td>{new Date(record.receivedAt).toLocaleDateString()}</td>
                  <td>
                    <span
                      className={`badge ${
                        record.status === "PENDING"
                          ? "status-pending"
                          : record.status === "APPROVED"
                          ? "status-approved"
                          : "status-rejected"
                      }`}
                    >
                      {record.status}
                    </span>
                  </td>
                  <td>
                    {record.signedOffBy
                      ? `${record.signedOffBy.firstName} ${record.signedOffBy.lastName}`
                      : "—"}
                  </td>
                  <td>
                    {record.status === "PENDING" && (
                      <div className="flex gap-2">
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="signoff" />
                          <input type="hidden" name="recordId" value={record.id} />
                          <input type="hidden" name="action" value="approve" />
                          <button
                            type="submit"
                            className="btn btn-sm btn-primary"
                            disabled={isSubmitting}
                          >
                            Approve
                          </button>
                        </Form>
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="signoff" />
                          <input type="hidden" name="recordId" value={record.id} />
                          <input type="hidden" name="action" value="reject" />
                          <button
                            type="submit"
                            className="btn btn-sm btn-danger"
                            disabled={isSubmitting}
                          >
                            Reject
                          </button>
                        </Form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
