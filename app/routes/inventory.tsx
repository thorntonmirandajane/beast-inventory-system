import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams, useFetcher } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { autoDeductRawMaterials } from "../utils/inventory.server";
import { useState, useEffect } from "react";

// Type for tracking pending changes
type PendingChange = {
  skuId: string;
  state: string;
  quantity: number;
};

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

  // Calculate "In Assembly" - how much of each RAW material is locked in assembled products
  // This needs to be RECURSIVE to account for nested sub-assemblies
  const inAssemblyBySkuId: Record<string, number> = {};

  // Helper function to recursively explode BOM and accumulate raw material usage
  async function explodeBOMForInAssembly(
    skuId: string,
    quantity: number,
    accumulated: Record<string, number>
  ): Promise<void> {
    const sku = await prisma.sku.findUnique({
      where: { id: skuId },
      include: {
        bomComponents: {
          include: {
            componentSku: true,
          },
        },
      },
    });

    if (!sku) return;

    // If this is a RAW material, add it to the accumulated map
    if (sku.type === "RAW") {
      if (!accumulated[skuId]) {
        accumulated[skuId] = 0;
      }
      accumulated[skuId] += quantity;
      return;
    }

    // If this is an ASSEMBLY or COMPLETED, recursively process its components
    if (sku.type === "ASSEMBLY" || sku.type === "COMPLETED") {
      for (const bomItem of sku.bomComponents) {
        const requiredQty = bomItem.quantity * quantity;
        await explodeBOMForInAssembly(bomItem.componentSkuId, requiredQty, accumulated);
      }
    }
  }

  // Get all SKUs with their assembled inventory
  const skusWithBoms = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
    include: {
      inventoryItems: {
        where: { state: { in: ["ASSEMBLED", "COMPLETED"] } },
      },
    },
  });

  // For each assembled/completed product, recursively calculate raw material usage
  for (const sku of skusWithBoms) {
    const assembledQty = sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0);

    if (assembledQty > 0) {
      // Recursively explode the BOM to get ALL raw materials
      await explodeBOMForInAssembly(sku.id, assembledQty, inAssemblyBySkuId);
    }
  }

  // Debug: Log the inAssemblyBySkuId to verify calculation
  const totalRawMaterialsWithInAssembly = Object.keys(inAssemblyBySkuId).length;
  console.log(`[Inventory Loader] Calculated "In Assembly" for ${totalRawMaterialsWithInAssembly} raw materials`);
  if (totalRawMaterialsWithInAssembly > 0) {
    const sampleSkuIds = Object.keys(inAssemblyBySkuId).slice(0, 3);
    console.log(`[Inventory Loader] Sample values:`, sampleSkuIds.map(id => `${id}: ${inAssemblyBySkuId[id]}`));

    // Find BLADE-2IN for debugging
    const blade2inSku = await prisma.sku.findFirst({ where: { sku: "BLADE-2IN" } });
    if (blade2inSku) {
      const blade2inValue = inAssemblyBySkuId[blade2inSku.id];
      console.log(`[DEBUG] BLADE-2IN lookup: id=${blade2inSku.id}, inAssembly=${blade2inValue || "NOT FOUND IN MAP"}`);
      console.log(`[DEBUG] Map keys sample:`, Object.keys(inAssemblyBySkuId).slice(0, 10));
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

    // Debug: Log if there's a mismatch
    if (sku.type === "RAW" && inAssembly > 0 && sku.sku === "BLADE-2IN") {
      console.log(`[DEBUG] BLADE-2IN: id=${sku.id}, inAssembly=${inAssembly}`);
    }

    return {
      id: sku.id,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      category: sku.category,
      process: sku.material, // Renamed from material to process
      raw: byState.RAW,
      // For COMPLETED type, show COMPLETED state. For ASSEMBLY type, show ASSEMBLED state
      assembled: sku.type === "COMPLETED" ? byState.COMPLETED : byState.ASSEMBLED,
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
      case "process":
        aVal = a.process || "";
        bVal = b.process || "";
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

    if (!skuId || !state || isNaN(newQuantity)) {
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
    } else if (newQuantity !== 0) {
      // Create new item for non-zero values (including negative)
      await prisma.inventoryItem.create({
        data: { skuId, state, quantity: newQuantity },
      });
    }

    // Auto-deduct components when increasing assembled/completed quantities
    const sku = await prisma.sku.findUnique({ where: { id: skuId } });

    if (quantityChange > 0 && sku) {
      // For assemblies: deduct when ASSEMBLED state increases
      if (sku.type === "ASSEMBLY" && state === "ASSEMBLED") {
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

      // For completed products: deduct when COMPLETED state increases
      if (sku.type === "COMPLETED" && state === "COMPLETED") {
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
    const deductionResults: string[] = [];
    const errors: string[] = [];

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
      } else if (quantity !== 0) {
        // Create new item for non-zero values (including negative)
        await prisma.inventoryItem.create({
          data: { skuId, state, quantity },
        });
      }

      // Auto-deduct components if needed
      if (quantityChange > 0) {
        const sku = await prisma.sku.findUnique({ where: { id: skuId } });
        if (sku && ((sku.type === "ASSEMBLY" && state === "ASSEMBLED") || (sku.type === "COMPLETED" && state === "COMPLETED"))) {
          const deductResult = await autoDeductRawMaterials(skuId, quantityChange);

          if (deductResult.success) {
            if (deductResult.deducted.length > 0) {
              deductionResults.push(
                `${sku.sku}: Deducted ${deductResult.deducted.map(d => `${d.sku} (-${d.quantity})`).join(", ")}`
              );
            }
          } else {
            errors.push(`${sku.sku}: ${deductResult.error}`);
          }
        }
      }
    }

    let message = `Batch updated ${updates.length} items`;
    if (deductionResults.length > 0) {
      message += `. Auto-deductions: ${deductionResults.join("; ")}`;
    }
    if (errors.length > 0) {
      message += `. Warnings: ${errors.join("; ")}`;
    }

    return { success: true, message };
  }

  return { error: "Invalid action" };
};

// Editable cell component for inline editing with drag-fill
function EditableCell({
  skuId,
  state,
  initialValue,
  isAdmin,
  onDragFillStart,
  onPendingChange,
  pendingValue
}: {
  skuId: string;
  state: string;
  initialValue: number;
  isAdmin: boolean;
  onDragFillStart: (skuId: string, state: string, value: number) => void;
  onPendingChange: (skuId: string, state: string, quantity: number) => void;
  pendingValue?: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const displayValue = pendingValue !== undefined ? pendingValue : initialValue;
  const [value, setValue] = useState(displayValue.toString());
  const hasPendingChange = pendingValue !== undefined && pendingValue !== initialValue;

  useEffect(() => {
    setValue(displayValue.toString());
  }, [displayValue]);

  const handleSubmit = () => {
    if (!isAdmin) return;
    const newValue = parseInt(value, 10);
    if (isNaN(newValue)) {
      setValue(displayValue.toString());
      setIsEditing(false);
      return;
    }
    // Allow negative values for RAW materials
    if (newValue !== initialValue) {
      onPendingChange(skuId, state, newValue);
    }
    setIsEditing(false);
  };

  if (!isAdmin) {
    return (
      <span className={
        initialValue > 0
          ? "text-gray-900 font-medium"
          : initialValue < 0
            ? "text-red-600 font-medium"
            : "text-gray-400"
      }>
        {initialValue}
      </span>
    );
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
            onDragFillStart(skuId, state, displayValue);
          }
        }
      }}
      className={`cursor-pointer px-2 py-1 rounded hover:bg-blue-50 relative ${
        displayValue > 0
          ? "text-gray-900 font-medium"
          : displayValue < 0
            ? "text-red-600 font-medium"
            : "text-gray-400"
      } ${hasPendingChange ? "bg-yellow-100 border border-yellow-400" : ""}`}
      style={{
        position: "relative",
      }}
      title={
        hasPendingChange
          ? "Unsaved change - click Save Changes button"
          : displayValue < 0
            ? "Negative inventory - materials used before all work submissions recorded"
            : "Click to edit, or drag bottom-right corner to fill down"
      }
    >
      {displayValue}
      {hasPendingChange && (
        <span className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-500 rounded-full" title="Unsaved change" />
      )}
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
    process: "",
  });
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [showHiddenColumnsDropdown, setShowHiddenColumnsDropdown] = useState(false);
  const [dragFillState, setDragFillState] = useState<{
    active: boolean;
    startSkuId: string;
    state: string;
    value: number;
    selectedRows: string[];
  } | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const fetcher = useFetcher();

  const toggleColumnVisibility = (column: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      return next;
    });
  };

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
    { id: "assembly", label: "Assemblies", count: counts.assembly + counts.completed },
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
      // Assembly tab now includes both ASSEMBLY and COMPLETED
      if (typeFilter === "assembly") {
        if (item.type !== "ASSEMBLY" && item.type !== "COMPLETED") return false;
      } else if (item.type !== typeFilter.toUpperCase()) {
        return false;
      }
    }

    // Filter by search/filter inputs
    if (filters.sku && !item.sku.toLowerCase().includes(filters.sku.toLowerCase())) return false;
    if (filters.name && !item.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
    if (filters.type && item.type !== filters.type) return false;
    if (filters.category && (!item.category || !item.category.toLowerCase().includes(filters.category.toLowerCase()))) return false;
    if (filters.process && (!item.process || !item.process.toLowerCase().includes(filters.process.toLowerCase()))) return false;
    return true;
  });

  // Determine which columns to show based on tab
  const shouldShowColumn = (column: string): boolean => {
    // Check if column is hidden by user
    if (hiddenColumns.has(column)) return false;

    // All tab - show all except "inAssembly" since we have "assembled"
    if (typeFilter === "all") {
      return column !== "inAssembly";
    }

    // Raw Materials tab - show RAW, Assembled (where used), and On Order
    if (typeFilter === "raw") {
      return ["sku", "name", "category", "process", "raw", "assembled", "onOrder"].includes(column);
    }

    // Assembly tab - show Type, Assembled columns (includes both ASSEMBLY and COMPLETED)
    if (typeFilter === "assembly") {
      return ["sku", "name", "category", "type", "process", "assembled"].includes(column);
    }

    return true;
  };

  // Check if a cell should show N/A
  const shouldShowNA = (item: any, column: string): boolean => {
    // Process: only ASSEMBLY items have values, RAW and COMPLETED show N/A
    if (column === "process") {
      return item.type !== "ASSEMBLY";
    }

    // Raw materials can be in RAW state or used in assembled/completed products
    // So they should NOT show N/A for assembled column
    if (item.type === "RAW") {
      return ["onOrder"].includes(column) === false && !["sku", "name", "category", "process", "raw", "assembled", "inAssembly"].includes(column);
    }

    // For "All" tab, show N/A for invalid state/type combinations
    if (typeFilter === "all") {
      if (item.type === "ASSEMBLY") {
        return ["raw", "onOrder"].includes(column);
      }
      if (item.type === "COMPLETED") {
        return ["raw", "onOrder"].includes(column); // COMPLETED items use assembled column to show quantity
      }
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

  // Handle adding a pending change
  const handlePendingChange = (skuId: string, state: string, quantity: number) => {
    const key = `${skuId}-${state}`;
    setPendingChanges((prev) => {
      const next = new Map(prev);
      next.set(key, { skuId, state, quantity });
      return next;
    });
  };

  // Handle saving all pending changes
  const handleSaveChanges = () => {
    if (pendingChanges.size === 0) return;

    const updates = Array.from(pendingChanges.values());
    fetcher.submit(
      { intent: "batch-update", updates: JSON.stringify(updates) },
      { method: "post" }
    );

    // Clear pending changes after submit
    setPendingChanges(new Map());
  };

  // Handle canceling all pending changes
  const handleCancelChanges = () => {
    if (window.confirm("Are you sure you want to discard all unsaved changes?")) {
      setPendingChanges(new Map());
    }
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
      // Add to pending changes instead of immediate submit
      dragFillState.selectedRows.forEach((skuId) => {
        handlePendingChange(skuId, dragFillState.state, dragFillState.value);
      });
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
        <div>
          <h1 className="page-title">Inventory</h1>
          <p className="page-subtitle">View and edit inventory levels - click cells to edit, drag corner to fill down</p>
        </div>

        {/* Save Changes Button */}
        {pendingChanges.size > 0 && user.role === "ADMIN" && (
          <div className="flex gap-3 items-center">
            <div className="text-sm text-yellow-700 bg-yellow-100 px-3 py-2 rounded border border-yellow-300">
              {pendingChanges.size} unsaved change{pendingChanges.size > 1 ? "s" : ""}
            </div>
            <button
              onClick={handleSaveChanges}
              className="btn btn-success"
              disabled={fetcher.state === "submitting"}
            >
              {fetcher.state === "submitting" ? "Saving..." : "Save Changes"}
            </button>
            <button
              onClick={handleCancelChanges}
              className="btn btn-ghost"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Success/Error Messages */}
      {fetcher.data?.success && (
        <div className="alert alert-success mb-6">
          {fetcher.data.message}
        </div>
      )}
      {fetcher.data?.error && (
        <div className="alert alert-error mb-6">
          {fetcher.data.error}
        </div>
      )}

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

      {/* Show Hidden Columns Button */}
      {hiddenColumns.size > 0 && (
        <div className="mb-4 relative">
          <button
            onClick={() => setShowHiddenColumnsDropdown(!showHiddenColumnsDropdown)}
            className="btn btn-secondary text-sm"
          >
            Show Hidden Columns ({hiddenColumns.size})
            <svg className="w-4 h-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showHiddenColumnsDropdown && (
            <div className="absolute top-full mt-1 bg-white border border-gray-300 rounded shadow-lg z-20 min-w-[200px]">
              <div className="p-2">
                <div className="text-xs text-gray-500 font-semibold mb-2 px-2">Hidden Columns</div>
                {Array.from(hiddenColumns).map((column) => (
                  <button
                    key={column}
                    onClick={() => toggleColumnVisibility(column)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-gray-100 rounded text-sm text-gray-400"
                  >
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                    <span className="capitalize">
                      {column === "inAssembly" ? "In Completed Package" :
                       column === "process" ? "Process" : column}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
                    <th className="sticky left-0 bg-white z-10">
                      <div className="flex items-center justify-between gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("sku")}>SKU {sortBy === "sku" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("sku"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("name") && (
                    <th>
                      <div className="flex items-center justify-between gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("name")}>Name {sortBy === "name" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("name"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("type") && (
                    <th>
                      <div className="flex items-center justify-between gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("type")}>Type {sortBy === "type" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("type"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("category") && (
                    <th>
                      <div className="flex items-center justify-between gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("category")}>Category {sortBy === "category" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("category"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("process") && (
                    <th>
                      <div className="flex items-center justify-between gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("process")}>Process {sortBy === "process" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("process"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("raw") && (
                    <th className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("raw")}>{typeFilter === "assembly" ? "RAW (Components)" : "RAW"} {sortBy === "raw" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("raw"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("assembled") && (
                    <th className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("assembled")}>{typeFilter === "raw" ? "In Assembled" : "Assembled"} {sortBy === "assembled" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("assembled"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("inAssembly") && (
                    <th className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("inAssembly")}>In Assembly {sortBy === "inAssembly" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("inAssembly"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
                    </th>
                  )}
                  {shouldShowColumn("onOrder") && (
                    <th className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="cursor-pointer" onClick={() => handleSort("onOrder")}>On Order {sortBy === "onOrder" && (sortDir === "asc" ? "↑" : "↓")}</span>
                        <button onClick={(e) => { e.stopPropagation(); toggleColumnVisibility("onOrder"); }} className="text-gray-400 hover:text-gray-600" title="Hide column">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                        </button>
                      </div>
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
                  {shouldShowColumn("type") && (
                    <th>
                      <select
                        value={filters.type}
                        onChange={(e) => setFilters({ ...filters, type: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      >
                        <option value="">All</option>
                        {getUniqueValues("type")
                          .filter((val) => typeFilter !== "assembly" || val !== "RAW")
                          .map((val) => (
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
                  {shouldShowColumn("process") && (
                    <th>
                      <select
                        value={filters.process}
                        onChange={(e) => setFilters({ ...filters, process: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      >
                        <option value="">All</option>
                        {getUniqueValues("process").map((val) => (
                          <option key={val} value={val}>{val}</option>
                        ))}
                      </select>
                    </th>
                  )}
                  {shouldShowColumn("raw") && <th></th>}
                  {shouldShowColumn("assembled") && <th></th>}
                  {shouldShowColumn("inAssembly") && <th></th>}
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
                    {shouldShowColumn("type") && (
                      <td>
                        <span className={`badge ${getTypeClass(item.type)}`}>
                          {item.type}
                        </span>
                      </td>
                    )}
                    {shouldShowColumn("category") && (
                      <td className="text-sm text-gray-600">{item.category || "—"}</td>
                    )}
                    {shouldShowColumn("process") && (
                      <td className="text-sm text-gray-600">
                        {shouldShowNA(item, "process") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : (
                          item.process || "—"
                        )}
                      </td>
                    )}
                    {shouldShowColumn("raw") && (
                      <td className="text-right">
                        {shouldShowNA(item, "raw") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : typeFilter === "all" ? (
                          <span className="text-sm">{item.raw || 0}</span>
                        ) : (
                          <EditableCell
                            skuId={item.id}
                            state="RAW"
                            initialValue={item.raw || 0}
                            isAdmin={user.role === "ADMIN"}
                            onDragFillStart={handleDragFillStart}
                            onPendingChange={handlePendingChange}
                            pendingValue={pendingChanges.get(`${item.id}-RAW`)?.quantity}
                          />
                        )}
                      </td>
                    )}
                    {shouldShowColumn("assembled") && (
                      <td className="text-right">
                        {shouldShowNA(item, "assembled") ? (
                          <span className="text-gray-400">N/A</span>
                        ) : typeFilter === "raw" ? (
                          <span className={item.assembled > 0 ? "text-blue-600 text-sm" : "text-gray-400 text-sm"}>
                            {item.assembled || 0}
                          </span>
                        ) : typeFilter === "all" ? (
                          <span className="text-sm">{item.assembled || 0}</span>
                        ) : (
                          <EditableCell
                            skuId={item.id}
                            state={item.type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED"}
                            initialValue={item.assembled || 0}
                            isAdmin={user.role === "ADMIN"}
                            onDragFillStart={handleDragFillStart}
                            onPendingChange={handlePendingChange}
                            pendingValue={pendingChanges.get(`${item.id}-${item.type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED"}`)?.quantity}
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
