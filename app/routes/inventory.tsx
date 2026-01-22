import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams, useFetcher } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { autoDeductRawMaterials } from "../utils/inventory.server";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type") || "all";
  const search = url.searchParams.get("search") || "";

  // Build where clause
  const whereClause: any = { isActive: true };
  if (typeFilter !== "all") {
    whereClause.type = typeFilter.toUpperCase();
  }
  if (search) {
    whereClause.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }

  // Get SKUs with inventory
  const skus = await prisma.sku.findMany({
    where: whereClause,
    include: {
      inventoryItems: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get pending PO items for raw materials
  const pendingPOItems = await prisma.pOItem.findMany({
    where: {
      purchaseOrder: {
        status: { in: ["SUBMITTED", "PARTIAL"] },
      },
    },
    include: {
      purchaseOrder: true,
    },
  });

  // Build map of on-order quantities by SKU (renamed from pending)
  const onOrderBySkuId: Record<string, { quantity: number; poId: string; poNumber: string }[]> = {};
  for (const item of pendingPOItems) {
    const pending = item.quantityOrdered - item.quantityReceived;
    if (pending > 0) {
      if (!onOrderBySkuId[item.skuId]) {
        onOrderBySkuId[item.skuId] = [];
      }
      onOrderBySkuId[item.skuId].push({
        quantity: pending,
        poId: item.purchaseOrder.id,
        poNumber: item.purchaseOrder.poNumber,
      });
    }
  }

  // Calculate "In Assembly" - how much of each component SKU is used in assembled products
  const inAssemblyBySkuId: Record<string, number> = {};

  // Get all SKUs with their BOMs and assembled inventory
  const skusWithBoms = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
    include: {
      bomComponents: {
        include: {
          componentSku: true,
        },
      },
      inventoryItems: {
        where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
      },
    },
  });

  // For each assembled/completed product, calculate how many components are "locked in"
  for (const sku of skusWithBoms) {
    const assembledQty = sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    // For each component in this SKU's BOM
    for (const bomComp of sku.bomComponents) {
      const componentSkuId = bomComp.componentSkuId;
      const qtyPerUnit = bomComp.quantity;
      const totalInAssembly = assembledQty * qtyPerUnit;

      if (!inAssemblyBySkuId[componentSkuId]) {
        inAssemblyBySkuId[componentSkuId] = 0;
      }
      inAssemblyBySkuId[componentSkuId] += totalInAssembly;
    }
  }

  // Calculate inventory totals for each SKU
  const inventory = skus.map((sku) => {
    const byState: Record<string, number> = {
      RECEIVED: 0,
      RAW: 0,
      ASSEMBLED: 0,
      COMPLETED: 0,
    };

    for (const item of sku.inventoryItems) {
      if (byState[item.state] !== undefined) {
        byState[item.state] += item.quantity;
      }
    }

    // Determine "available" based on type
    let available = 0;
    if (sku.type === "RAW") {
      available = byState.RAW;
    } else if (sku.type === "ASSEMBLY") {
      available = byState.ASSEMBLED;
    } else {
      available = byState.COMPLETED;
    }

    // Get on-order POs for this SKU (only for RAW materials)
    const onOrderPOs = sku.type === "RAW" ? onOrderBySkuId[sku.id] || [] : [];
    const totalOnOrder = onOrderPOs.reduce((sum, p) => sum + p.quantity, 0);

    // Get in-assembly quantity (how much of this SKU is locked in assemblies)
    const inAssembly = inAssemblyBySkuId[sku.id] || 0;

    return {
      id: sku.id,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      category: sku.category,
      material: sku.material,
      received: byState.RECEIVED,
      raw: byState.RAW,
      assembled: byState.ASSEMBLED,
      completed: byState.COMPLETED,
      inAssembly,
      onOrderPOs,
      totalOnOrder,
    };
  });

  // Get counts by type
  const counts = {
    all: await prisma.sku.count({ where: { isActive: true } }),
    raw: await prisma.sku.count({ where: { isActive: true, type: "RAW" } }),
    assembly: await prisma.sku.count({ where: { isActive: true, type: "ASSEMBLY" } }),
    completed: await prisma.sku.count({ where: { isActive: true, type: "COMPLETED" } }),
  };

  return { user, inventory, counts, typeFilter, search };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update-quantity") {
    const skuId = formData.get("skuId") as string;
    const state = formData.get("state") as string;
    const newQuantity = parseInt(formData.get("quantity") as string, 10);

    if (!skuId || !state || isNaN(newQuantity) || newQuantity < 0) {
      return { error: "Invalid data" };
    }

    // Get current quantity
    const existingItem = await prisma.inventoryItem.findFirst({
      where: { skuId, state },
    });

    const oldQuantity = existingItem?.quantity || 0;
    const quantityChange = newQuantity - oldQuantity;

    // Update or create inventory item
    if (existingItem) {
      if (newQuantity === 0) {
        await prisma.inventoryItem.delete({ where: { id: existingItem.id } });
      } else {
        await prisma.inventoryItem.update({
          where: { id: existingItem.id },
          data: { quantity: newQuantity },
        });
      }
    } else if (newQuantity > 0) {
      await prisma.inventoryItem.create({
        data: { skuId, state, quantity: newQuantity },
      });
    }

    // If this is an assembly and ASSEMBLED state is increasing, auto-deduct raw materials
    if (state === "ASSEMBLED" && quantityChange > 0) {
      const sku = await prisma.sku.findUnique({ where: { id: skuId } });

      if (sku?.type === "ASSEMBLY") {
        const deductResult = await autoDeductRawMaterials(skuId, quantityChange);

        if (!deductResult.success) {
          return {
            error: `Quantity updated but auto-deduction failed: ${deductResult.error}`,
            partialSuccess: true,
          };
        }

        return {
          success: true,
          message: `Updated to ${newQuantity}. Auto-deducted: ${deductResult.deducted.map(d => `${d.sku} (-${d.quantity})`).join(", ")}`,
        };
      }
    }

    return { success: true, message: `Updated to ${newQuantity}` };
  }

  return { error: "Invalid action" };
};

// Editable cell component for inline editing
function EditableCell({ skuId, state, initialValue, isAdmin }: {
  skuId: string;
  state: string;
  initialValue: number;
  isAdmin: boolean;
}) {
  const fetcher = useFetcher();
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(initialValue.toString());

  const handleSubmit = () => {
    if (!isAdmin) return;
    const newValue = parseInt(value, 10);
    if (isNaN(newValue) || newValue < 0) {
      setValue(initialValue.toString());
      setIsEditing(false);
      return;
    }
    if (newValue !== initialValue) {
      fetcher.submit(
        { intent: "update-quantity", skuId, state, quantity: value },
        { method: "post" }
      );
    }
    setIsEditing(false);
  };

  if (!isAdmin) {
    return <span className={initialValue > 0 ? "text-gray-900 font-medium" : "text-gray-400"}>{initialValue}</span>;
  }

  if (isEditing) {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") {
            setValue(initialValue.toString());
            setIsEditing(false);
          }
        }}
        className="w-20 px-2 py-1 text-right border-2 border-blue-500 rounded"
        autoFocus
        min="0"
      />
    );
  }

  return (
    <span
      onClick={() => setIsEditing(true)}
      className={`cursor-pointer px-2 py-1 rounded hover:bg-blue-50 ${
        initialValue > 0 ? "text-gray-900 font-medium" : "text-gray-400"
      }`}
      title="Click to edit"
    >
      {initialValue}
    </span>
  );
}

export default function Inventory() {
  const { user, inventory, counts, typeFilter, search } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newSearch = form.get("search") as string;
    const params = new URLSearchParams(searchParams);
    if (newSearch) {
      params.set("search", newSearch);
    } else {
      params.delete("search");
    }
    setSearchParams(params);
  };

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "raw", label: "Raw Materials", count: counts.raw },
    { id: "assembly", label: "Assemblies", count: counts.assembly },
    { id: "completed", label: "Completed", count: counts.completed },
  ];

  const getTypeClass = (type: string) => {
    switch (type) {
      case "RAW":
        return "sku-type-raw";
      case "ASSEMBLY":
        return "sku-type-assembly";
      case "COMPLETED":
        return "sku-type-completed";
      default:
        return "badge-gray";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">View current inventory levels by SKU</p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search by SKU or name..."
            className="form-input max-w-md uppercase"
          />
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
          {search && (
            <Link to="/inventory" className="btn btn-ghost">
              Clear
            </Link>
          )}
        </div>
      </form>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/inventory?type=${tab.id}${search ? `&search=${search}` : ""}`}
            className={`tab ${typeFilter === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Inventory Table */}
      <div className="card">
        {inventory.length === 0 ? (
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
                  d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                />
              </svg>
              <h3 className="empty-state-title">No inventory found</h3>
              <p className="empty-state-description">
                {search
                  ? "Try a different search term"
                  : "Receive inventory to see it here"}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white z-10">SKU</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Material</th>
                  {(typeFilter === "all" || typeFilter === "raw") && (
                    <>
                      <th className="text-right">Received</th>
                      <th className="text-right">RAW</th>
                      <th className="text-right">In Assembly</th>
                      <th className="text-right">On Order</th>
                    </>
                  )}
                  {(typeFilter === "all" || typeFilter === "assembly") && (
                    <>
                      <th className="text-right">RAW (Components)</th>
                      <th className="text-right">Assembled</th>
                    </>
                  )}
                  {(typeFilter === "all" || typeFilter === "completed") && (
                    <th className="text-right">Completed</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {inventory.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="sticky left-0 bg-white">
                      <Link
                        to={`/skus/${item.id}`}
                        className="font-mono text-sm text-blue-600 hover:underline"
                      >
                        {item.sku}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate text-sm">{item.name}</td>
                    <td>
                      <span className={`badge ${getTypeClass(item.type)}`}>
                        {item.type}
                      </span>
                    </td>
                    <td className="text-sm text-gray-600">{item.category || "—"}</td>
                    <td className="text-sm text-gray-600">{item.material || "—"}</td>
                    {(typeFilter === "all" || typeFilter === "raw") && (
                      <>
                        <td className="text-right">
                          <EditableCell
                            skuId={item.id}
                            state="RECEIVED"
                            initialValue={item.received || 0}
                            isAdmin={user.role === "ADMIN"}
                          />
                        </td>
                        <td className="text-right">
                          <EditableCell
                            skuId={item.id}
                            state="RAW"
                            initialValue={item.raw || 0}
                            isAdmin={user.role === "ADMIN"}
                          />
                        </td>
                        <td className="text-right">
                          <span className={item.inAssembly > 0 ? "text-blue-600 text-sm" : "text-gray-400 text-sm"}>
                            {item.inAssembly}
                          </span>
                        </td>
                        <td className="text-right">
                          {item.type === "RAW" && item.totalOnOrder > 0 ? (
                            <Link
                              to="/po?status=submitted"
                              className="text-yellow-600 text-sm hover:underline"
                            >
                              {item.totalOnOrder}
                            </Link>
                          ) : (
                            <span className="text-gray-400 text-sm">0</span>
                          )}
                        </td>
                      </>
                    )}
                    {(typeFilter === "all" || typeFilter === "assembly") && (
                      <>
                        <td className="text-right">
                          <EditableCell
                            skuId={item.id}
                            state="RAW"
                            initialValue={item.raw || 0}
                            isAdmin={user.role === "ADMIN"}
                          />
                        </td>
                        <td className="text-right">
                          <EditableCell
                            skuId={item.id}
                            state="ASSEMBLED"
                            initialValue={item.assembled || 0}
                            isAdmin={user.role === "ADMIN"}
                          />
                        </td>
                      </>
                    )}
                    {(typeFilter === "all" || typeFilter === "completed") && (
                      <td className="text-right">
                        <EditableCell
                          skuId={item.id}
                          state="COMPLETED"
                          initialValue={item.completed || 0}
                          isAdmin={user.role === "ADMIN"}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
