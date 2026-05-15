import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory, logInventoryMovement } from "../utils/inventory.server";
import type { InventoryState } from "@prisma/client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all active SKUs with their current inventory
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    include: {
      inventoryItems: {
        where: { quantity: { gt: 0 } },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Calculate total inventory for each SKU
  const skusWithInventory = skus.map(sku => ({
    ...sku,
    totalInventory: sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0),
  }));

  // Get recent disposals (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentDisposals = await prisma.inventoryLog.findMany({
    where: {
      action: "DISPOSED",
      createdAt: { gte: thirtyDaysAgo },
    },
    include: {
      sku: {
        select: { sku: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Pending rejection trays — components parked here after a task approval
  // with rejections, awaiting a human to decide what's recoverable.
  const pendingTrays = await prisma.rejectionTray.findMany({
    where: { status: "PENDING" },
    include: {
      outputSku: { select: { sku: true, name: true } },
      createdBy: { select: { firstName: true, lastName: true } },
      items: {
        include: {
          componentSku: { select: { id: true, sku: true, name: true, type: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return { user, skusWithInventory, recentDisposals, pendingTrays };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "dispose") {
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    const reason = formData.get("reason") as string;
    const state = formData.get("state") as "RAW" | "ASSEMBLED" | "COMPLETED" | "RECEIVED";

    if (!skuId || !quantity || quantity <= 0 || !reason || !state) {
      return { error: "All fields are required" };
    }

    // Check if there's enough inventory in the specified state
    const inventoryItem = await prisma.inventoryItem.findFirst({
      where: {
        skuId,
        state,
        quantity: { gte: quantity },
      },
    });

    if (!inventoryItem) {
      return {
        error: `Insufficient inventory in ${state} state. Cannot dispose ${quantity} units.`,
      };
    }

    // Deduct from inventory
    const newQuantity = inventoryItem.quantity - quantity;

    if (newQuantity === 0) {
      await prisma.inventoryItem.delete({
        where: { id: inventoryItem.id },
      });
    } else {
      await prisma.inventoryItem.update({
        where: { id: inventoryItem.id },
        data: { quantity: newQuantity },
      });
    }

    // Log the disposal
    await logInventoryMovement(
      skuId,
      "DISPOSED",
      quantity,
      state,
      undefined,
      undefined,
      "DISPOSAL",
      undefined,
      reason,
      user.id
    );

    // Create audit log
    await createAuditLog(user.id, "DISPOSE_INVENTORY", "InventoryItem", inventoryItem.id, {
      skuId,
      quantity,
      state,
      reason,
    });

    return {
      success: true,
      message: `Successfully disposed ${quantity} units`,
    };
  }

  // Cherry-pick a portion of a rejected component back into inventory.
  if (intent === "recover-tray-item") {
    const itemId = formData.get("itemId") as string;
    const qtyRaw = parseInt(formData.get("quantity") as string, 10);
    const qty = isNaN(qtyRaw) ? 0 : qtyRaw;

    if (!itemId || qty <= 0) {
      return { error: "Quantity must be greater than zero" };
    }

    const item = await prisma.rejectionTrayItem.findUnique({
      where: { id: itemId },
      include: {
        componentSku: { select: { id: true, sku: true, type: true } },
        rejectionTray: { select: { id: true, processName: true } },
      },
    });
    if (!item) return { error: "Tray item not found" };

    const remaining = item.quantity - item.recoveredQty - item.disposedQty;
    if (qty > remaining) {
      return { error: `Only ${remaining} unresolved — can't recover ${qty}` };
    }

    // Components go back to the state they were originally consumed from.
    const targetState: InventoryState =
      item.componentSku.type === "RAW" ? "RAW" : "ASSEMBLED";

    await prisma.$transaction(async (tx) => {
      await addInventory(
        item.componentSku.id,
        qty,
        targetState,
        undefined,
        `Recovered from rejection tray (${item.rejectionTray.processName})`,
        item.rejectionTray.id,
        "REJECTION_TRAY",
        undefined,
        user.id,
        tx
      );
      await tx.rejectionTrayItem.update({
        where: { id: itemId },
        data: { recoveredQty: { increment: qty } },
      });
      await maybeResolveTray(tx, item.rejectionTray.id);
    });

    await createAuditLog(user.id, "RECOVER_REJECTION", "RejectionTrayItem", itemId, {
      sku: item.componentSku.sku,
      quantity: qty,
      state: targetState,
    });
    return { success: true, message: `Recovered ${qty} of ${item.componentSku.sku}` };
  }

  // Mark a portion as truly disposed — same effect as the existing manual
  // disposal flow, but tied to a rejection-tray item for record keeping.
  if (intent === "dispose-tray-item") {
    const itemId = formData.get("itemId") as string;
    const qtyRaw = parseInt(formData.get("quantity") as string, 10);
    const qty = isNaN(qtyRaw) ? 0 : qtyRaw;

    if (!itemId || qty <= 0) {
      return { error: "Quantity must be greater than zero" };
    }

    const item = await prisma.rejectionTrayItem.findUnique({
      where: { id: itemId },
      include: {
        componentSku: { select: { id: true, sku: true } },
        rejectionTray: { select: { id: true, processName: true } },
      },
    });
    if (!item) return { error: "Tray item not found" };

    const remaining = item.quantity - item.recoveredQty - item.disposedQty;
    if (qty > remaining) {
      return { error: `Only ${remaining} unresolved — can't dispose ${qty}` };
    }

    await prisma.$transaction(async (tx) => {
      // Disposal here is bookkeeping only — the inventory was already
      // deducted when the task was approved (the full attempted qty is
      // consumed up front). We just log it so it shows in the recent
      // disposals list and the audit log.
      await tx.inventoryLog.create({
        data: {
          skuId: item.componentSku.id,
          action: "DISPOSED",
          quantity: qty,
          relatedResource: item.rejectionTray.id,
          relatedResourceType: "REJECTION_TRAY",
          processName: item.rejectionTray.processName,
          notes: "Disposed from rejection tray",
          performedById: user.id,
        },
      });
      await tx.rejectionTrayItem.update({
        where: { id: itemId },
        data: { disposedQty: { increment: qty } },
      });
      await maybeResolveTray(tx, item.rejectionTray.id);
    });

    await createAuditLog(user.id, "DISPOSE_REJECTION", "RejectionTrayItem", itemId, {
      sku: item.componentSku.sku,
      quantity: qty,
    });
    return { success: true, message: `Disposed ${qty} of ${item.componentSku.sku}` };
  }

  return { error: "Invalid action" };
};

// If every item in the tray has been fully recovered or disposed, mark the
// tray RESOLVED so it drops off the pending list.
async function maybeResolveTray(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  trayId: string
) {
  const items = await tx.rejectionTrayItem.findMany({
    where: { rejectionTrayId: trayId },
  });
  const fullyResolved = items.every(
    (i) => i.recoveredQty + i.disposedQty >= i.quantity
  );
  if (fullyResolved) {
    await tx.rejectionTray.update({
      where: { id: trayId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
}

export default function Disposals() {
  const { user, skusWithInventory, recentDisposals, pendingTrays } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [selectedState, setSelectedState] = useState("");
  const [reason, setReason] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Filter SKUs based on search term
  const filteredSkus = skusWithInventory.filter(sku => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      sku.sku.toLowerCase().includes(search) ||
      sku.name.toLowerCase().includes(search)
    );
  });

  // Get selected SKU details
  const selectedSkuData = skusWithInventory.find(s => s.id === selectedSku);

  // Get available states for selected SKU
  const availableStates = selectedSkuData?.inventoryItems.map(item => ({
    state: item.state,
    quantity: item.quantity,
  })) || [];

  const handleSubmit = () => {
    if (!selectedSku || !quantity || !selectedState || !reason) {
      return;
    }

    setSelectedSku("");
    setQuantity(0);
    setSelectedState("");
    setReason("");
    setSearchTerm("");
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Inventory Disposals</h1>
        <p className="page-subtitle">Record damaged or discarded inventory</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}

      {actionData?.success && (
        <div className="alert alert-success mb-4">{actionData.message}</div>
      )}

      {/* Rejection Tray — pending components from rejected task attempts */}
      {pendingTrays.length > 0 && (
        <div className="card mb-6 border-2 border-orange-300">
          <div className="card-header bg-orange-50">
            <h2 className="card-title text-orange-900">Rejection Tray ({pendingTrays.length})</h2>
            <p className="text-sm text-orange-800 mt-1">
              Components from rejected task attempts. Recover what's still usable,
              dispose of what isn't. Once every line is fully accounted for, the
              tray entry resolves and drops off this list.
            </p>
          </div>
          <div className="card-body space-y-6">
            {pendingTrays.map((tray) => (
              <div key={tray.id} className="border rounded p-4 bg-gray-50">
                <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
                  <div>
                    <div className="font-semibold">
                      <span className="font-mono">{tray.outputSku.sku}</span>{" "}
                      <span className="text-gray-600">— {tray.outputSku.name}</span>
                    </div>
                    <div className="text-sm text-gray-500">
                      {tray.rejectedQty} unit{tray.rejectedQty !== 1 ? "s" : ""} rejected
                      from <span className="font-mono">{tray.processName}</span>
                      {" · "}
                      {new Date(tray.createdAt).toLocaleDateString()}
                      {tray.createdBy && (
                        <> · approved by {tray.createdBy.firstName} {tray.createdBy.lastName}</>
                      )}
                    </div>
                    {tray.rejectionReason && (
                      <div className="text-xs text-gray-600 mt-1 italic">
                        Reason: {tray.rejectionReason}
                      </div>
                    )}
                  </div>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th className="text-right">In tray</th>
                      <th className="text-right">Recovered</th>
                      <th className="text-right">Disposed</th>
                      <th className="text-right">Remaining</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tray.items.map((item) => {
                      const remaining = item.quantity - item.recoveredQty - item.disposedQty;
                      return (
                        <tr key={item.id}>
                          <td>
                            <div className="font-mono text-sm">{item.componentSku.sku}</div>
                            <div className="text-xs text-gray-500">{item.componentSku.name}</div>
                            <span className="text-xs text-gray-400">{item.componentSku.type}</span>
                          </td>
                          <td className="text-right">{item.quantity}</td>
                          <td className="text-right text-green-700">
                            {item.recoveredQty > 0 ? item.recoveredQty : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="text-right text-red-700">
                            {item.disposedQty > 0 ? item.disposedQty : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="text-right font-semibold">
                            {remaining}
                          </td>
                          <td className="text-right">
                            {remaining > 0 ? (
                              <div className="flex items-center justify-end gap-2 flex-wrap">
                                <Form method="post" className="inline-flex items-center gap-1">
                                  <input type="hidden" name="intent" value="recover-tray-item" />
                                  <input type="hidden" name="itemId" value={item.id} />
                                  <input
                                    type="number"
                                    name="quantity"
                                    min="1"
                                    max={remaining}
                                    defaultValue={remaining}
                                    className="form-input w-16 text-sm text-right"
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-xs btn-primary"
                                    disabled={isSubmitting}
                                    title={`Add back to ${item.componentSku.type === "RAW" ? "RAW" : "ASSEMBLED"} inventory`}
                                  >
                                    Recover
                                  </button>
                                </Form>
                                <Form method="post" className="inline-flex items-center gap-1">
                                  <input type="hidden" name="intent" value="dispose-tray-item" />
                                  <input type="hidden" name="itemId" value={item.id} />
                                  <input
                                    type="number"
                                    name="quantity"
                                    min="1"
                                    max={remaining}
                                    defaultValue={remaining}
                                    className="form-input w-16 text-sm text-right"
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-xs btn-error"
                                    disabled={isSubmitting}
                                  >
                                    Dispose
                                  </button>
                                </Form>
                              </div>
                            ) : (
                              <span className="badge bg-green-100 text-green-700 text-xs">Resolved</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disposal Form */}
      <div className="card mb-6">
        <div className="card-header bg-red-50">
          <h2 className="card-title text-red-900">Dispose of Damaged Inventory</h2>
          <p className="text-sm text-red-700 mt-1">
            This will permanently remove items from inventory
          </p>
        </div>
        <div className="card-body">
          <Form method="post" onSubmit={handleSubmit}>
            <input type="hidden" name="intent" value="dispose" />

            <div className="space-y-4">
              {/* SKU Selection */}
              <div className="form-group">
                <label className="form-label">SKU *</label>
                <input
                  type="text"
                  placeholder="Search by SKU code or name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="form-input mb-2"
                />
                <select
                  name="skuId"
                  value={selectedSku}
                  onChange={(e) => {
                    setSelectedSku(e.target.value);
                    setSelectedState("");
                    setQuantity(0);
                  }}
                  className="form-select"
                  required
                >
                  <option value="">Select SKU...</option>
                  {filteredSkus.map((sku) => (
                    <option key={sku.id} value={sku.id}>
                      {sku.sku} - {sku.name} (Total: {sku.totalInventory})
                    </option>
                  ))}
                </select>
                {filteredSkus.length === 0 && searchTerm && (
                  <p className="text-sm text-gray-500 mt-1">No SKUs match your search</p>
                )}
              </div>

              {/* State Selection */}
              {selectedSku && (
                <div className="form-group">
                  <label className="form-label">Inventory State *</label>
                  <select
                    name="state"
                    value={selectedState}
                    onChange={(e) => setSelectedState(e.target.value)}
                    className="form-select"
                    required
                  >
                    <option value="">Select state...</option>
                    {availableStates.map((item) => (
                      <option key={item.state} value={item.state}>
                        {item.state} (Available: {item.quantity})
                      </option>
                    ))}
                  </select>
                  {availableStates.length === 0 && (
                    <p className="text-sm text-red-600 mt-1">
                      No inventory available for this SKU
                    </p>
                  )}
                </div>
              )}

              {/* Quantity */}
              {selectedState && (
                <div className="form-group">
                  <label className="form-label">Quantity to Dispose *</label>
                  <input
                    type="number"
                    name="quantity"
                    value={quantity}
                    onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                    className="form-input"
                    min="1"
                    max={availableStates.find(s => s.state === selectedState)?.quantity || 0}
                    required
                  />
                  <p className="text-sm text-gray-500 mt-1">
                    Max: {availableStates.find(s => s.state === selectedState)?.quantity || 0} units available
                  </p>
                </div>
              )}

              {/* Reason */}
              <div className="form-group">
                <label className="form-label">Reason for Disposal *</label>
                <textarea
                  name="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="form-textarea"
                  rows={3}
                  placeholder="e.g., Damaged during production, Quality defect, Expired material..."
                  required
                />
                <p className="text-sm text-gray-500 mt-1">
                  Describe why this inventory is being disposed
                </p>
              </div>

              {/* Submit Button */}
              <div className="flex gap-3">
                <button
                  type="submit"
                  className="btn bg-red-600 text-white hover:bg-red-700"
                  disabled={isSubmitting || !selectedSku || !selectedState || !quantity || !reason}
                >
                  {isSubmitting ? "Disposing..." : "Dispose Inventory"}
                </button>
                {(selectedSku || quantity || reason) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSku("");
                      setQuantity(0);
                      setSelectedState("");
                      setReason("");
                      setSearchTerm("");
                    }}
                    className="btn btn-secondary"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </Form>
        </div>
      </div>

      {/* Recent Disposals */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Disposals</h2>
          <p className="text-sm text-gray-500">Last 30 days</p>
        </div>
        <div className="card-body">
          {recentDisposals.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              <p>No disposals recorded in the last 30 days</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>SKU</th>
                    <th>Quantity</th>
                    <th>State</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDisposals.map((disposal) => (
                    <tr key={disposal.id}>
                      <td className="text-sm whitespace-nowrap">
                        {new Date(disposal.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <div>
                          <div className="font-mono text-sm">{disposal.sku.sku}</div>
                          <div className="text-xs text-gray-500">{disposal.sku.name}</div>
                        </div>
                      </td>
                      <td className="font-semibold text-red-600">
                        {disposal.quantity.toLocaleString()}
                      </td>
                      <td>
                        <span className="badge bg-gray-100 text-gray-700 text-xs">
                          {disposal.fromState}
                        </span>
                      </td>
                      <td className="max-w-xs text-sm">
                        {disposal.notes || <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
