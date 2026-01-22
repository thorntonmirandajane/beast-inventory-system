import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams, useFetcher } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { autoDeductRawMaterials } from "../utils/inventory.server";
import { useState, useEffect } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type") || "all";
  const search = url.searchParams.get("search") || "";
  const sortBy = url.searchParams.get("sortBy") || "sku";
  const sortDir = url.searchParams.get("sortDir") || "asc";

  // Build where clause - always fetch all active SKUs
  const whereClause: any = { isActive: true };
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

  // Build map of on-order quantities by SKU
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
  let inventory = skus.map((sku) => {
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
      raw: byState.RAW,
      assembled: byState.ASSEMBLED,
      completed: byState.COMPLETED,
      inAssembly,
      onOrderPOs,
      totalOnOrder,
    };
  });

  // Apply sorting
  inventory.sort((a, b) => {
    let aVal: any, bVal: any;
    switch (sortBy) {
      case "sku":
        aVal = a.sku;
        bVal = b.sku;
        break;
      case "name":
        aVal = a.name;
        bVal = b.name;
        break;
      case "type":
        aVal = a.type;
        bVal = b.type;
        break;
      case "category":
        aVal = a.category || "";
        bVal = b.category || "";
        break;
      case "material":
        aVal = a.material || "";
        bVal = b.material || "";
        break;
      case "raw":
        aVal = a.raw;
        bVal = b.raw;
        break;
      case "inAssembly":
        aVal = a.inAssembly;
        bVal = b.inAssembly;
        break;
      case "assembled":
        aVal = a.assembled;
        bVal = b.assembled;
        break;
      case "completed":
        aVal = a.completed;
        bVal = b.completed;
        break;
      case "onOrder":
        aVal = a.totalOnOrder;
        bVal = b.totalOnOrder;
        break;
      default:
        aVal = a.sku;
        bVal = b.sku;
    }

    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    } else {
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    }
  });

  // Get counts by type
  const counts = {
    all: await prisma.sku.count({ where: { isActive: true } }),
    raw: await prisma.sku.count({ where: { isActive: true, type: "RAW" } }),
    assembly: await prisma.sku.count({ where: { isActive: true, type: "ASSEMBLY" } }),
    completed: await prisma.sku.count({ where: { isActive: true, type: "COMPLETED" } }),
  };

  return { user, inventory, counts, typeFilter, search, sortBy, sortDir };
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

  if (intent === "batch-update") {
    const updates = JSON.parse(formData.get("updates") as string);

    for (const update of updates) {
      const { skuId, state, quantity } = update;

      // Get current quantity
      const existingItem = await prisma.inventoryItem.findFirst({
        where: { skuId, state },
      });

      const oldQuantity = existingItem?.quantity || 0;
      const quantityChange = quantity - oldQuantity;

      // Update or create inventory item
      if (existingItem) {
        if (quantity === 0) {
          await prisma.inventoryItem.delete({ where: { id: existingItem.id } });
        } else {
          await prisma.inventoryItem.update({
            where: { id: existingItem.id },
            data: { quantity },
          });
        }
      } else if (quantity > 0) {
        await prisma.inventoryItem.create({
          data: { skuId, state, quantity },
        });
      }

      // Auto-deduct if needed
      if (state === "ASSEMBLED" && quantityChange > 0) {
        const sku = await prisma.sku.findUnique({ where: { id: skuId } });
        if (sku?.type === "ASSEMBLY") {
          await autoDeductRawMaterials(skuId, quantityChange);
        }
      }
    }

    return { success: true, message: `Batch updated ${updates.length} items` };
  }

  return { error: "Invalid action" };
};

// Editable cell component for inline editing with drag-fill
function EditableCell({
  skuId,
  state,
  initialValue,
  isAdmin,
  onDragFillStart
}: {
  skuId: string;
  state: string;
  initialValue: number;
  isAdmin: boolean;
  onDragFillStart: (skuId: string, state: string, value: number) => void;
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
      onMouseDown={(e) => {
        if (e.button === 0) {
          const target = e.target as HTMLElement;
          const rect = target.getBoundingClientRect();
          const isCorner = e.clientX > rect.right - 10 && e.clientY > rect.bottom - 10;
          if (isCorner) {
            e.preventDefault();
            onDragFillStart(skuId, state, initialValue);
          }
        }
      }}
      className={`cursor-pointer px-2 py-1 rounded hover:bg-blue-50 relative ${
        initialValue > 0 ? "text-gray-900 font-medium" : "text-gray-400"
      }`}
      style={{
        position: "relative",
      }}
      title="Click to edit, or drag bottom-right corner to fill down"
    >
      {initialValue}
      <span
        className="absolute bottom-0 right-0 w-2 h-2 bg-blue-500 cursor-se-resize"
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
        }}
      />
    </span>
  );
}

export default function Inventory() {
  const { user, inventory, counts, typeFilter, search, sortBy, sortDir } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    sku: "",
    name: "",
    type: "",
    category: "",
    material: "",
  });
  const [dragFillState, setDragFillState] = useState<{
    active: boolean;
    startSkuId: string;
    state: string;
    value: number;
    selectedRows: string[];
  } | null>(null);
  const fetcher = useFetcher();

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

  const handleSort = (column: string) => {
    const params = new URLSearchParams(searchParams);
    if (sortBy === column) {
      params.set("sortDir", sortDir === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", column);
      params.set("sortDir", "asc");
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

  // Apply client-side filters
  const filteredInventory = inventory.filter((item) => {
    // Filter by tab type
    if (typeFilter !== "all") {
      if (item.type !== typeFilter.toUpperCase()) return false;
    }

    // Filter by search/filter inputs
    if (filters.sku && !item.sku.toLowerCase().includes(filters.sku.toLowerCase())) return false;
    if (filters.name && !item.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
    if (filters.type && item.type !== filters.type) return false;
    if (filters.category && (!item.category || !item.category.toLowerCase().includes(filters.category.toLowerCase()))) return false;
    if (filters.material && (!item.material || !item.material.toLowerCase().includes(filters.material.toLowerCase()))) return false;
    return true;
  });

  // Determine which columns to show based on tab
  const shouldShowColumn = (column: string): boolean => {
    // All tab shows everything
    if (typeFilter === "all") return true;

    // Raw Materials tab
    if (typeFilter === "raw") {
      return ["sku", "name", "category", "material", "raw", "inAssembly", "onOrder"].includes(column);
    }

    // Assembly tab
    if (typeFilter === "assembly") {
      return ["sku", "name", "category", "material", "raw", "assembled"].includes(column);
    }

    // Completed tab
    if (typeFilter === "completed") {
      return ["sku", "name", "category", "material", "completed"].includes(column);
    }

    return true;
  };

  // Check if a cell should show N/A
  const shouldShowNA = (item: any, column: string): boolean => {
    if (typeFilter !== "all") return false;

    if (item.type === "ASSEMBLY") {
      return ["raw", "onOrder"].includes(column);
    }
    if (item.type === "COMPLETED") {
      return ["raw", "inAssembly", "onOrder"].includes(column);
    }
    return false;
  };

  // Handle drag fill start
  const handleDragFillStart = (skuId: string, state: string, value: number) => {
    setDragFillState({
      active: true,
      startSkuId: skuId,
      state,
      value,
      selectedRows: [skuId],
    });
  };

  // Handle drag fill end
  const handleDragFillEnd = () => {
    if (!dragFillState || dragFillState.selectedRows.length <= 1) {
      setDragFillState(null);
      return;
    }

    const count = dragFillState.selectedRows.length - 1;
    const confirmed = window.confirm(
      `Fill ${dragFillState.value} to ${count} cell${count > 1 ? "s" : ""} below?`
    );

    if (confirmed) {
      const updates = dragFillState.selectedRows.map((skuId) => ({
        skuId,
        state: dragFillState.state,
        quantity: dragFillState.value,
      }));

      fetcher.submit(
        { intent: "batch-update", updates: JSON.stringify(updates) },
        { method: "post" }
      );
    }

    setDragFillState(null);
  };

  // Handle row hover during drag
  const handleRowMouseEnter = (skuId: string) => {
    if (dragFillState?.active) {
      const startIdx = filteredInventory.findIndex((i) => i.id === dragFillState.startSkuId);
      const currentIdx = filteredInventory.findIndex((i) => i.id === skuId);

      if (currentIdx >= startIdx) {
        const selectedRows = filteredInventory
          .slice(startIdx, currentIdx + 1)
          .map((i) => i.id);
        setDragFillState({ ...dragFillState, selectedRows });
      }
    }
  };

  // Listen for mouse up globally
  useEffect(() => {
    const handleMouseUp = () => {
      if (dragFillState?.active) {
        handleDragFillEnd();
      }
    };

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [dragFillState]);

  // Get unique values for filter dropdowns
  const getUniqueValues = (key: keyof typeof filteredInventory[0]) => {
    const values = new Set(inventory.map((item) => item[key]).filter(Boolean));
    return Array.from(values).sort();
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">View and edit inventory levels - click cells to edit, drag corner to fill down</p>
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
        {filteredInventory.length === 0 ? (
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
                  {shouldShowColumn("sku") && (
                    <th className="sticky left-0 bg-white z-10 cursor-pointer" onClick={() => handleSort("sku")}>
                      SKU {sortBy === "sku" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("name") && (
                    <th className="cursor-pointer" onClick={() => handleSort("name")}>
                      Name {sortBy === "name" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("type") && typeFilter === "all" && (
                    <th className="cursor-pointer" onClick={() => handleSort("type")}>
                      Type {sortBy === "type" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("category") && (
                    <th className="cursor-pointer" onClick={() => handleSort("category")}>
                      Category {sortBy === "category" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("material") && (
                    <th className="cursor-pointer" onClick={() => handleSort("material")}>
                      Material {sortBy === "material" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("raw") && (
                    <th className="text-right cursor-pointer" onClick={() => handleSort("raw")}>
                      {typeFilter === "assembly" ? "RAW (Components)" : "RAW"} {sortBy === "raw" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("inAssembly") && (
                    <th className="text-right cursor-pointer" onClick={() => handleSort("inAssembly")}>
                      In Assembly {sortBy === "inAssembly" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("assembled") && (
                    <th className="text-right cursor-pointer" onClick={() => handleSort("assembled")}>
                      Assembled {sortBy === "assembled" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("completed") && (
                    <th className="text-right cursor-pointer" onClick={() => handleSort("completed")}>
                      Completed {sortBy === "completed" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                  {shouldShowColumn("onOrder") && (
                    <th className="text-right cursor-pointer" onClick={() => handleSort("onOrder")}>
                      On Order {sortBy === "onOrder" && (sortDir === "asc" ? "↑" : "↓")}
                    </th>
                  )}
                </tr>
                <tr>
                  {shouldShowColumn("sku") && (
                    <th className="sticky left-0 bg-white z-10">
                      <input
                        type="text"
                        placeholder="Filter..."
                        value={filters.sku}
                        onChange={(e) => setFilters({ ...filters, sku: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </th>
                  )}
                  {shouldShowColumn("name") && (
                    <th>
                      <input
                        type="text"
                        placeholder="Filter..."
                        value={filters.name}
                        onChange={(e) => setFilters({ ...filters, name: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </th>
                  )}
                  {shouldShowColumn("type") && typeFilter === "all" && (
                    <th>
                      <select
                        value={filters.type}
                        onChange={(e) => setFilters({ ...filters, type: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      >
                        <option value="">All</option>
                        {getUniqueValues("type").map((val) => (
                          <option key={val} value={val}>{val}</option>
                        ))}
                      </select>
                    </th>
                  )}
                  {shouldShowColumn("category") && (
                    <th>
                      <select
                        value={filters.category}
                        onChange={(e) => setFilters({ ...filters, category: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      >
                        <option value="">All</option>
                        {getUniqueValues("category").map((val) => (
                          <option key={val} value={val}>{val}</option>
                        ))}
                      </select>
                    </th>
                  )}
                  {shouldShowColumn("material") && (
                    <th>
                      <select
                        value={filters.material}
                        onChange={(e) => setFilters({ ...filters, material: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      >
                        <option value="">All</option>
                        {getUniqueValues("material").map((val) => (
                          <option key={val} value={val}>{val}</option>
                        ))}
                      </select>
                    </th>
                  )}
                  {shouldShowColumn("raw") && <th></th>}
                  {shouldShowColumn("inAssembly") && <th></th>}
                  {shouldShowColumn("assembled") && <th></th>}
                  {shouldShowColumn("completed") && <th></th>}
                  {shouldShowColumn("onOrder") && <th></th>}
                </tr>
              </thead>
              <tbody>
                {filteredInventory.map((item) => (
                  <tr
                    key={item.id}
                    className={`hover:bg-gray-50 ${
                      dragFillState?.selectedRows.includes(item.id) ? "bg-blue-50" : ""
                    }`}
                    onMouseEnter={() => handleRowMouseEnter(item.id)}
                  >
                    {shouldShowColumn("sku") && (
                      <td className="sticky left-0 bg-white">
                        <Link
                          to={`/skus/${item.id}`}
                          className="font-mono text-sm text-blue-600 hover:underline"
                        >
                          {item.sku}
                        </Link>
                      </td>
                    )}
                    {shouldShowColumn("name") && (
                      <td className="max-w-xs truncate text-sm">{item.name}</td>
                    )}
                    {shouldShowColumn("type") && typeFilter === "all" && (
                      <td>
                        <span className={`badge ${getTypeClass(item.type)}`}>
                          {item.type}
                        </span>
                      </td>
                    )}
                    {shouldShowColumn("category") && (
                      <td className="text-sm text-gray-600">{item.category || "—"}</td>
                    )}
                    {shouldShowColumn("material") && (
                      <td className="text-sm text-gray-600">{item.material || "—"}</td>
                    )}
                    {shouldShowColumn("raw") && (
                      <td className="text-right">
                        {shouldShowNA(item, "raw") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : (
                          <EditableCell
                            skuId={item.id}
                            state="RAW"
                            initialValue={item.raw || 0}
                            isAdmin={user.role === "ADMIN"}
                            onDragFillStart={handleDragFillStart}
                          />
                        )}
                      </td>
                    )}
                    {shouldShowColumn("inAssembly") && (
                      <td className="text-right">
                        {shouldShowNA(item, "inAssembly") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : (
                          <span className={item.inAssembly > 0 ? "text-blue-600 text-sm" : "text-gray-400 text-sm"}>
                            {item.inAssembly}
                          </span>
                        )}
                      </td>
                    )}
                    {shouldShowColumn("assembled") && (
                      <td className="text-right">
                        <EditableCell
                          skuId={item.id}
                          state="ASSEMBLED"
                          initialValue={item.assembled || 0}
                          isAdmin={user.role === "ADMIN"}
                          onDragFillStart={handleDragFillStart}
                        />
                      </td>
                    )}
                    {shouldShowColumn("completed") && (
                      <td className="text-right">
                        <EditableCell
                          skuId={item.id}
                          state="COMPLETED"
                          initialValue={item.completed || 0}
                          isAdmin={user.role === "ADMIN"}
                          onDragFillStart={handleDragFillStart}
                        />
                      </td>
                    )}
                    {shouldShowColumn("onOrder") && (
                      <td className="text-right">
                        {shouldShowNA(item, "onOrder") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : item.type === "RAW" && item.totalOnOrder > 0 ? (
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
