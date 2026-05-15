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
    orderBy: { createdAt: "asc" },
  });

  // Aggregated view across every pending tray entry — one row per
  // component SKU, summing the remaining qty across every rejection.
  // This is the main interaction surface: cherry-pick by component, not
  // by which specific task it came from.
  type AggRow = {
    skuId: string;
    sku: string;
    name: string;
    type: string;
    inTray: number;
    recovered: number;
    disposed: number;
    brokenApart: number;
    remaining: number;
    sourceTrayCount: number;
  };
  const aggMap = new Map<string, AggRow>();
  for (const tray of pendingTrays) {
    for (const item of tray.items) {
      const remaining =
        item.quantity - item.recoveredQty - item.disposedQty - item.brokenApartQty;
      if (remaining <= 0) continue;
      const c = item.componentSku;
      const row = aggMap.get(c.id);
      if (row) {
        row.inTray += item.quantity;
        row.recovered += item.recoveredQty;
        row.disposed += item.disposedQty;
        row.brokenApart += item.brokenApartQty;
        row.remaining += remaining;
        row.sourceTrayCount += 1;
      } else {
        aggMap.set(c.id, {
          skuId: c.id,
          sku: c.sku,
          name: c.name,
          type: c.type,
          inTray: item.quantity,
          recovered: item.recoveredQty,
          disposed: item.disposedQty,
          brokenApart: item.brokenApartQty,
          remaining,
          sourceTrayCount: 1,
        });
      }
    }
  }
  const aggregated = Array.from(aggMap.values()).sort((a, b) => {
    // Assemblies first (so user sees what's break-apart-able at the top)
    if (a.type !== b.type) {
      if (a.type === "ASSEMBLY") return -1;
      if (b.type === "ASSEMBLY") return 1;
    }
    return a.sku.localeCompare(b.sku);
  });

  return { user, skusWithInventory, recentDisposals, pendingTrays, aggregated };
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

  // Aggregated cherry-pick actions — operate on a component SKU across
  // ALL pending tray entries at once, FIFO consuming through them by
  // tray creation date.
  if (
    intent === "recover-by-sku" ||
    intent === "dispose-by-sku" ||
    intent === "break-apart-by-sku"
  ) {
    const skuId = formData.get("skuId") as string;
    const qtyRaw = parseInt(formData.get("quantity") as string, 10);
    const qty = isNaN(qtyRaw) ? 0 : qtyRaw;

    if (!skuId || qty <= 0) {
      return { error: "Quantity must be greater than zero" };
    }

    const sku = await prisma.sku.findUnique({
      where: { id: skuId },
      select: { id: true, sku: true, name: true, type: true },
    });
    if (!sku) return { error: "Component SKU not found" };

    if (intent === "break-apart-by-sku" && sku.type === "RAW") {
      return { error: "Raw materials can't be broken apart further" };
    }

    try {
      await prisma.$transaction(async (tx) => {
        const column =
          intent === "recover-by-sku"
            ? ("recoveredQty" as const)
            : intent === "dispose-by-sku"
            ? ("disposedQty" as const)
            : ("brokenApartQty" as const);

        const consumed = await consumeTrayItemsFifo(tx, skuId, qty, column);

        // Side effects depending on intent
        if (intent === "recover-by-sku") {
          // Components return to inventory in the state they were
          // originally consumed from — RAW for raws, ASSEMBLED for
          // assemblies (the most common state for assemblies pre-stud-test).
          const state: InventoryState = sku.type === "RAW" ? "RAW" : "ASSEMBLED";
          await addInventory(
            skuId,
            qty,
            state,
            undefined,
            `Recovered ${qty} from rejection tray`,
            consumed[0]?.trayId ?? null,
            "REJECTION_TRAY",
            undefined,
            user.id,
            tx
          );
        } else if (intent === "dispose-by-sku") {
          // Inventory was already deducted at approval time — this is
          // bookkeeping so the disposal shows up in the recent-disposals
          // table and audit log.
          await tx.inventoryLog.create({
            data: {
              skuId,
              action: "DISPOSED",
              quantity: qty,
              relatedResource: consumed[0]?.trayId ?? null,
              relatedResourceType: "REJECTION_TRAY",
              notes: "Disposed from rejection tray",
              performedById: user.id,
            },
          });
        } else {
          // Break apart: consume `qty` of the assembly from the tray and
          // add `qty * componentQty` of each direct child as new tray
          // items. The new items inherit the source tray's id so the
          // chain of ownership is preserved for resolution.
          const directChildren = await tx.bomComponent.findMany({
            where: { parentSkuId: skuId },
          });
          if (directChildren.length === 0) {
            throw new Error(`${sku.sku} has no BOM components to break apart into`);
          }

          // Spread the new children across the source trays in proportion
          // to how much we consumed from each. Simplest correct approach:
          // attach to the first tray we touched (consumed[0]).
          const targetTrayId = consumed[0]?.trayId;
          if (!targetTrayId) throw new Error("No source tray to attach broken-apart children to");

          for (const child of directChildren) {
            await tx.rejectionTrayItem.create({
              data: {
                rejectionTrayId: targetTrayId,
                componentSkuId: child.componentSkuId,
                quantity: child.quantity * qty,
              },
            });
          }
        }

        // Re-evaluate the affected trays — any that are now fully
        // resolved get marked RESOLVED and drop off the pending list.
        const trayIds = Array.from(new Set(consumed.map((c) => c.trayId)));
        for (const trayId of trayIds) {
          await maybeResolveTray(tx, trayId);
        }
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const verb =
      intent === "recover-by-sku"
        ? "Recovered"
        : intent === "dispose-by-sku"
        ? "Disposed"
        : "Broke apart";
    await createAuditLog(user.id, intent.toUpperCase().replace(/-/g, "_"), "Sku", skuId, {
      sku: sku.sku,
      quantity: qty,
    });
    return { success: true, message: `${verb} ${qty} of ${sku.sku}` };
  }

  return { error: "Invalid action" };
};

// FIFO across pending tray items for a given component SKU. Increments the
// provided column (recoveredQty / disposedQty / brokenApartQty) on each
// item up to the requested quantity. Throws if the tray doesn't hold
// enough unresolved units.
async function consumeTrayItemsFifo(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  componentSkuId: string,
  qty: number,
  column: "recoveredQty" | "disposedQty" | "brokenApartQty"
): Promise<{ id: string; qty: number; trayId: string }[]> {
  const items = await tx.rejectionTrayItem.findMany({
    where: {
      componentSkuId,
      rejectionTray: { status: "PENDING" },
    },
    include: { rejectionTray: { select: { id: true, createdAt: true } } },
    orderBy: { rejectionTray: { createdAt: "asc" } },
  });

  let remaining = qty;
  const consumed: { id: string; qty: number; trayId: string }[] = [];
  for (const item of items) {
    if (remaining <= 0) break;
    const available =
      item.quantity - item.recoveredQty - item.disposedQty - item.brokenApartQty;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    await tx.rejectionTrayItem.update({
      where: { id: item.id },
      data: { [column]: { increment: take } },
    });
    consumed.push({ id: item.id, qty: take, trayId: item.rejectionTrayId });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(`Tray doesn't hold enough of this SKU — short by ${remaining}`);
  }
  return consumed;
}

// If every item in the tray has been fully recovered/disposed/broken-apart,
// mark the tray RESOLVED so it drops off the pending list.
async function maybeResolveTray(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  trayId: string
) {
  const items = await tx.rejectionTrayItem.findMany({
    where: { rejectionTrayId: trayId },
  });
  const fullyResolved = items.every(
    (i) => i.recoveredQty + i.disposedQty + i.brokenApartQty >= i.quantity
  );
  if (fullyResolved) {
    await tx.rejectionTray.update({
      where: { id: trayId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
}

export default function Disposals() {
  const { user, skusWithInventory, recentDisposals, pendingTrays, aggregated } = useLoaderData<typeof loader>();
  const [showSources, setShowSources] = useState(false);
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

      {/* Rejection Tray — aggregated cherry-pick view across every pending
          rejection. One row per component SKU; act on it once and the
          quantity gets consumed FIFO across the underlying tray entries. */}
      {aggregated.length > 0 && (
        <div className="card mb-6 border-2 border-orange-300">
          <div className="card-header bg-orange-50">
            <h2 className="card-title text-orange-900">
              Rejection Tray
              <span className="ml-2 text-sm font-normal text-orange-800">
                ({aggregated.length} component type{aggregated.length !== 1 ? "s" : ""} across {pendingTrays.length} rejection{pendingTrays.length !== 1 ? "s" : ""})
              </span>
            </h2>
            <p className="text-sm text-orange-800 mt-1">
              Everything sitting in the rejection tray, rolled up by component.
              Recover what's still usable, dispose of what isn't. Break apart
              an assembly to access the sub-components inside (e.g. the tip
              from a tipped ferrule).
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Type</th>
                  <th className="text-right">Remaining</th>
                  <th className="text-right">Recovered</th>
                  <th className="text-right">Disposed</th>
                  <th className="text-right">Broken apart</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {aggregated.map((row) => (
                  <tr key={row.skuId}>
                    <td>
                      <div className="font-mono text-sm">{row.sku}</div>
                      <div className="text-xs text-gray-500">{row.name}</div>
                      {row.sourceTrayCount > 1 && (
                        <div className="text-xs text-gray-400">
                          from {row.sourceTrayCount} rejections
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge text-xs ${
                        row.type === "RAW"
                          ? "bg-gray-100 text-gray-700"
                          : row.type === "ASSEMBLY"
                          ? "bg-blue-100 text-blue-800"
                          : "bg-green-100 text-green-800"
                      }`}>
                        {row.type}
                      </span>
                    </td>
                    <td className="text-right font-semibold text-lg">{row.remaining}</td>
                    <td className="text-right text-green-700">
                      {row.recovered > 0 ? row.recovered : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="text-right text-red-700">
                      {row.disposed > 0 ? row.disposed : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="text-right text-blue-700">
                      {row.brokenApart > 0 ? row.brokenApart : <span className="text-gray-300">—</span>}
                    </td>
                    <td>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Form method="post" className="inline-flex items-center gap-1">
                          <input type="hidden" name="intent" value="recover-by-sku" />
                          <input type="hidden" name="skuId" value={row.skuId} />
                          <input
                            type="number"
                            name="quantity"
                            min="1"
                            max={row.remaining}
                            defaultValue={row.remaining}
                            className="form-input w-16 text-sm text-right"
                          />
                          <button
                            type="submit"
                            className="btn btn-xs btn-primary"
                            disabled={isSubmitting}
                            title={`Add back to ${row.type === "RAW" ? "RAW" : "ASSEMBLED"} inventory`}
                          >
                            Recover
                          </button>
                        </Form>
                        <Form method="post" className="inline-flex items-center gap-1">
                          <input type="hidden" name="intent" value="dispose-by-sku" />
                          <input type="hidden" name="skuId" value={row.skuId} />
                          <input
                            type="number"
                            name="quantity"
                            min="1"
                            max={row.remaining}
                            defaultValue={row.remaining}
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
                        {row.type !== "RAW" && (
                          <Form method="post" className="inline-flex items-center gap-1">
                            <input type="hidden" name="intent" value="break-apart-by-sku" />
                            <input type="hidden" name="skuId" value={row.skuId} />
                            <input
                              type="number"
                              name="quantity"
                              min="1"
                              max={row.remaining}
                              defaultValue={row.remaining}
                              className="form-input w-16 text-sm text-right"
                            />
                            <button
                              type="submit"
                              className="btn btn-xs btn-secondary"
                              disabled={isSubmitting}
                              title="Disassemble these units and put their direct sub-components into the tray"
                            >
                              Break apart
                            </button>
                          </Form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Source rejections — audit drilldown */}
          <div className="border-t bg-gray-50">
            <button
              type="button"
              onClick={() => setShowSources((v) => !v)}
              className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center justify-between"
            >
              <span>
                {showSources ? "▾" : "▸"} Source rejections ({pendingTrays.length})
              </span>
              <span className="text-xs text-gray-500">audit detail</span>
            </button>
            {showSources && (
              <div className="px-4 pb-4 space-y-3">
                {pendingTrays.map((tray) => (
                  <div key={tray.id} className="bg-white border rounded p-3 text-sm">
                    <div className="flex items-baseline justify-between flex-wrap gap-2">
                      <div>
                        <span className="font-mono font-semibold">{tray.outputSku.sku}</span>{" "}
                        <span className="text-gray-600">— {tray.outputSku.name}</span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {tray.rejectedQty} rejected · {tray.processName} ·{" "}
                        {new Date(tray.createdAt).toLocaleDateString()}
                        {tray.createdBy && (
                          <> · {tray.createdBy.firstName} {tray.createdBy.lastName}</>
                        )}
                      </div>
                    </div>
                    {tray.rejectionReason && (
                      <div className="text-xs text-gray-600 italic mt-1">
                        Reason: {tray.rejectionReason}
                      </div>
                    )}
                    <div className="mt-2 text-xs text-gray-700">
                      {tray.items.map((item) => {
                        const remaining =
                          item.quantity - item.recoveredQty - item.disposedQty - item.brokenApartQty;
                        return (
                          <span
                            key={item.id}
                            className="inline-block mr-3 mb-1"
                          >
                            <span className="font-mono">{item.componentSku.sku}</span>:{" "}
                            {remaining}/{item.quantity} remaining
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
