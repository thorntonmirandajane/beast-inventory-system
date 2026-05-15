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

  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    include: {
      inventoryItems: { where: { quantity: { gt: 0 } } },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  const skusWithInventory = skus.map((sku) => ({
    ...sku,
    totalInventory: sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0),
  }));

  // Recent disposals (last 30 days) — includes both manual disposals and
  // the per-component DISPOSED entries auto-logged when a worker task is
  // approved with rejections.
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentDisposals = await prisma.inventoryLog.findMany({
    where: { action: "DISPOSED", createdAt: { gte: thirtyDaysAgo } },
    include: {
      sku: { select: { sku: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Assembly + Completed SKUs with their direct BOM components, used as a
  // reference panel — gives the admin a quick "what's inside each
  // assembly?" lookup when deciding what to add back from the physical
  // rejection tray.
  const buildableSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      bomComponents: { some: {} },
    },
    include: {
      bomComponents: {
        include: {
          componentSku: { select: { id: true, sku: true, name: true, type: true } },
        },
        orderBy: { id: "asc" },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  return { user, skusWithInventory, recentDisposals, buildableSkus };
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

    const inventoryItem = await prisma.inventoryItem.findFirst({
      where: { skuId, state, quantity: { gte: quantity } },
    });

    if (!inventoryItem) {
      return {
        error: `Insufficient inventory in ${state} state. Cannot dispose ${quantity} units.`,
      };
    }

    const newQuantity = inventoryItem.quantity - quantity;
    if (newQuantity === 0) {
      await prisma.inventoryItem.delete({ where: { id: inventoryItem.id } });
    } else {
      await prisma.inventoryItem.update({
        where: { id: inventoryItem.id },
        data: { quantity: newQuantity },
      });
    }

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

    await createAuditLog(user.id, "DISPOSE_INVENTORY", "InventoryItem", inventoryItem.id, {
      skuId,
      quantity,
      state,
      reason,
    });

    return { success: true, message: `Successfully disposed ${quantity} units` };
  }

  // Add salvaged components back to inventory — used after physically
  // sorting through a tray of rejected materials and pulling out the
  // pieces that are still good. State is inferred from SKU type.
  if (intent === "add-back") {
    const skuId = formData.get("skuId") as string;
    const qtyRaw = parseInt(formData.get("quantity") as string, 10);
    const qty = isNaN(qtyRaw) ? 0 : qtyRaw;
    const reason = (formData.get("reason") as string)?.trim() || "Recovered from rejection tray";

    if (!skuId || qty <= 0) {
      return { error: "Pick a SKU and enter a quantity greater than zero" };
    }

    const sku = await prisma.sku.findUnique({
      where: { id: skuId },
      select: { id: true, sku: true, type: true },
    });
    if (!sku) return { error: "SKU not found" };

    const targetState: InventoryState =
      sku.type === "RAW" ? "RAW" : sku.type === "ASSEMBLY" ? "ASSEMBLED" : "COMPLETED";

    await addInventory(
      sku.id,
      qty,
      targetState,
      undefined,
      reason,
      undefined,
      "ADD_BACK",
      undefined,
      user.id
    );

    await createAuditLog(user.id, "ADD_BACK_INVENTORY", "Sku", sku.id, {
      sku: sku.sku,
      quantity: qty,
      state: targetState,
      reason,
    });

    return { success: true, message: `Added ${qty} ${sku.sku} back to ${targetState}` };
  }

  return { error: "Invalid action" };
};

export default function Disposals() {
  const { user, skusWithInventory, recentDisposals, buildableSkus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Dispose form state
  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [selectedState, setSelectedState] = useState("");
  const [reason, setReason] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Add-back form state
  const [addBackSku, setAddBackSku] = useState("");
  const [addBackSearch, setAddBackSearch] = useState("");

  // BOM reference panel state
  const [bomSearch, setBomSearch] = useState("");
  const [expandedBom, setExpandedBom] = useState<string | null>(null);

  const filteredSkus = skusWithInventory.filter((sku) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return sku.sku.toLowerCase().includes(search) || sku.name.toLowerCase().includes(search);
  });

  const selectedSkuData = skusWithInventory.find((s) => s.id === selectedSku);
  const availableStates =
    selectedSkuData?.inventoryItems.map((item) => ({
      state: item.state,
      quantity: item.quantity,
    })) || [];

  // Add-back picker — every active SKU is eligible (raw or assembly).
  const addBackChoices = skusWithInventory.filter((sku) => {
    if (!addBackSearch) return true;
    const search = addBackSearch.toLowerCase();
    return sku.sku.toLowerCase().includes(search) || sku.name.toLowerCase().includes(search);
  });

  // BOM reference: filter by SKU code/name match in the assembly itself.
  const filteredBoms = buildableSkus.filter((sku) => {
    if (!bomSearch) return true;
    const search = bomSearch.toLowerCase();
    return sku.sku.toLowerCase().includes(search) || sku.name.toLowerCase().includes(search);
  });

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Inventory Disposals</h1>
        <p className="page-subtitle">
          Record damaged or discarded inventory, and add back salvaged components
          from the rejection tray.
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-4">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success mb-4">{actionData.message}</div>
      )}

      {/* Add Back to Inventory — used after sorting through the physical
          tray of rejected materials and recovering whatever's still good. */}
      <div className="card mb-6 border-2 border-green-300">
        <div className="card-header bg-green-50">
          <h2 className="card-title text-green-900">Add Back to Inventory</h2>
          <p className="text-sm text-green-800 mt-1">
            Salvaged something from the physical rejection tray? Pick the SKU
            (raw material or assembly) and the quantity. State is set
            automatically based on the SKU's type.
          </p>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="add-back" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="form-group md:col-span-2">
                <label className="form-label">SKU *</label>
                <input
                  type="text"
                  placeholder="Search by SKU code or name..."
                  value={addBackSearch}
                  onChange={(e) => setAddBackSearch(e.target.value)}
                  className="form-input mb-2"
                />
                <select
                  name="skuId"
                  value={addBackSku}
                  onChange={(e) => setAddBackSku(e.target.value)}
                  className="form-select"
                  required
                >
                  <option value="">Select SKU...</option>
                  {addBackChoices.map((sku) => (
                    <option key={sku.id} value={sku.id}>
                      [{sku.type}] {sku.sku} — {sku.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Quantity *</label>
                <input
                  type="number"
                  name="quantity"
                  min="1"
                  className="form-input"
                  placeholder="0"
                  required
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Reason / note (optional)</label>
              <input
                type="text"
                name="reason"
                className="form-input"
                placeholder="Recovered from rejection tray"
              />
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || !addBackSku}
              >
                {isSubmitting ? "Adding..." : "Add to Inventory"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {/* Assembly Component Reference — quick lookup of "what's inside" each
          assembly so an admin can decide what's worth pulling out of the
          physical tray. */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Assembly Component Reference</h2>
          <p className="text-sm text-gray-500 mt-1">
            Click an assembly to see its direct components. Useful when
            deciding what to add back from a physical tray of rejected
            material.
          </p>
        </div>
        <div className="card-body">
          <input
            type="text"
            placeholder="Filter assemblies..."
            value={bomSearch}
            onChange={(e) => setBomSearch(e.target.value)}
            className="form-input mb-3"
          />
          {filteredBoms.length === 0 ? (
            <div className="text-sm text-gray-500 py-4 text-center">
              No assemblies match.
            </div>
          ) : (
            <div className="divide-y border rounded">
              {filteredBoms.map((sku) => {
                const isOpen = expandedBom === sku.id;
                return (
                  <div key={sku.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedBom(isOpen ? null : sku.id)}
                      className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500">{isOpen ? "▾" : "▸"}</span>
                        <span className="font-mono text-sm">{sku.sku}</span>
                        <span className="text-sm text-gray-600">{sku.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`badge text-xs ${
                          sku.type === "ASSEMBLY"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-green-100 text-green-800"
                        }`}>
                          {sku.type}
                        </span>
                        <span className="text-xs text-gray-400">
                          {sku.bomComponents.length} component{sku.bomComponents.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-3 pl-12 bg-gray-50">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-gray-600">
                              <th className="py-1">Component SKU</th>
                              <th className="py-1">Name</th>
                              <th className="py-1">Type</th>
                              <th className="py-1 text-right">Qty per unit</th>
                              <th className="py-1 text-right"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {sku.bomComponents.map((bom) => (
                              <tr key={bom.id} className="border-t border-gray-200">
                                <td className="py-1 font-mono text-xs">{bom.componentSku.sku}</td>
                                <td className="py-1 text-xs text-gray-600">{bom.componentSku.name}</td>
                                <td className="py-1">
                                  <span className="text-xs text-gray-500">{bom.componentSku.type}</span>
                                </td>
                                <td className="py-1 text-right">{bom.quantity}</td>
                                <td className="py-1 text-right">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAddBackSku(bom.componentSku.id);
                                      // Scroll to the form
                                      window.scrollTo({ top: 0, behavior: "smooth" });
                                    }}
                                    className="text-blue-600 hover:underline text-xs"
                                  >
                                    Add back →
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Manual Disposal Form */}
      <div className="card mb-6">
        <div className="card-header bg-red-50">
          <h2 className="card-title text-red-900">Dispose of Damaged Inventory</h2>
          <p className="text-sm text-red-700 mt-1">
            This will permanently remove items from inventory.
          </p>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="dispose" />
            <div className="space-y-4">
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
              </div>

              {selectedSkuData && (
                <div className="form-group">
                  <label className="form-label">Inventory state *</label>
                  <select
                    name="state"
                    value={selectedState}
                    onChange={(e) => setSelectedState(e.target.value)}
                    className="form-select"
                    required
                  >
                    <option value="">Select state...</option>
                    {availableStates.map((s) => (
                      <option key={s.state} value={s.state}>
                        {s.state} ({s.quantity} available)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Quantity *</label>
                <input
                  type="number"
                  name="quantity"
                  min="1"
                  value={quantity || ""}
                  onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                  className="form-input"
                  placeholder="0"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Reason *</label>
                <input
                  type="text"
                  name="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="form-input"
                  placeholder="Damage description, broken in handling, etc."
                  required
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  className="btn btn-error"
                  disabled={isSubmitting || !selectedSku || !quantity || !selectedState || !reason}
                >
                  {isSubmitting ? "Disposing..." : "Dispose"}
                </button>
                {selectedSku && (
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

      {/* Recent disposals — covers manual disposals AND auto-logged
          per-component disposals from approved-with-rejections tasks. */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Disposals</h2>
          <p className="text-sm text-gray-500">
            Last 30 days · includes rejections from worker task approvals
          </p>
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
                          {disposal.fromState ?? "—"}
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
