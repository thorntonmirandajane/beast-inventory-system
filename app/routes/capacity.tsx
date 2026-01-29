import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

// Helper to match SKU material field to process config
// SKU material: "Tipped", "Bladed", "Stud Tested", "Completed Packs"
// Process displayName: "Tipping", "Blading", "Stud Testing", "Complete Packs"
function matchesProcess(skuMaterial: string | null, processDisplayName: string): boolean {
  if (!skuMaterial) return false;
  const materialLower = skuMaterial.toLowerCase().replace(/\s+/g, ' ');
  const processLower = processDisplayName.toLowerCase().replace(/\s+/g, ' ');

  // Direct match
  if (materialLower === processLower) return true;

  // "Tipped" -> "Tipping", "Bladed" -> "Blading"
  if (materialLower.replace(/ed$/, 'ing') === processLower) return true;

  // "Stud Tested" -> "Stud Testing"
  if (materialLower.replace(/ed$/, 'ing') === processLower) return true;

  // "Completed Packs" -> "Complete Packs"
  if (materialLower.replace('completed', 'complete') === processLower) return true;

  return false;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get process configurations
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
    orderBy: { displayName: "asc" },
  });

  // Get all SKUs for process assignment
  const allSkus = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
    select: { id: true, sku: true, name: true, type: true, category: true, material: true },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get active workers with their schedules
  const workers = await prisma.user.findMany({
    where: { isActive: true },
    include: {
      schedules: {
        where: { isActive: true },
        orderBy: { dayOfWeek: "asc" },
      },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Calculate weekly hours for each worker
  const workersWithHours = workers.map((worker) => {
    const weeklyHours = worker.schedules.reduce((total, schedule) => {
      const start = parseTime(schedule.startTime);
      const end = parseTime(schedule.endTime);
      return total + (end - start);
    }, 0);
    return { ...worker, weeklyHours };
  });

  // Calculate total scheduled hours per week
  const totalWeeklyHours = workersWithHours.reduce((sum, w) => sum + w.weeklyHours, 0);
  const scheduledWorkers = workersWithHours.filter((w) => w.weeklyHours > 0).length;

  // Get inventory by category for current state
  const inventoryByCategory = await prisma.sku.findMany({
    where: { isActive: true, category: { not: null } },
    include: {
      inventoryItems: {
        where: { quantity: { gt: 0 } },
      },
    },
  });

  const categoryInventory: Record<string, { available: number; skuCount: number }> = {};
  for (const sku of inventoryByCategory) {
    const category = sku.category || "UNCATEGORIZED";
    if (!categoryInventory[category]) {
      categoryInventory[category] = { available: 0, skuCount: 0 };
    }
    categoryInventory[category].skuCount++;
    categoryInventory[category].available += sku.inventoryItems.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
  }

  // Get unique categories for management
  const uniqueCategories = await prisma.sku.findMany({
    where: { category: { not: null }, isActive: true },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });

  const categories = uniqueCategories.map(c => c.category).filter(Boolean) as string[];

  return {
    user,
    processConfigs,
    allSkus,
    workers: workersWithHours,
    totalWeeklyHours,
    scheduledWorkers,
    categoryInventory,
    categories,
  };
};

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours + minutes / 60;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Only admins can update process times" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create-process") {
    const displayName = formData.get("displayName") as string;
    const processOrderStr = formData.get("processOrder") as string;
    const processOrder = processOrderStr ? parseInt(processOrderStr, 10) : null;
    const secondsPerUnit = parseInt(formData.get("secondsPerUnit") as string, 10);
    const description = formData.get("description") as string;

    // Generate process name (uppercase, underscores)
    const processName = displayName
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/[^A-Z_0-9]/g, "");

    // Validation
    if (!displayName || !processName) {
      return { error: "Display name is required" };
    }

    // secondsPerUnit is now optional - can be 0 or null for "Unassigned"
    if (secondsPerUnit && secondsPerUnit < 1) {
      return { error: "Seconds per unit must be at least 1 if provided" };
    }

    // Check for duplicates
    const existing = await prisma.processConfig.findUnique({
      where: { processName },
    });

    if (existing) {
      return { error: `Process "${processName}" already exists` };
    }

    // Create process (secondsPerUnit defaults to 0 if not provided)
    const process = await prisma.processConfig.create({
      data: {
        processName,
        displayName,
        processOrder,
        description: description || null,
        secondsPerUnit: secondsPerUnit || 0,
        isActive: true,
      },
    });

    await createAuditLog(user.id, "CREATE_PROCESS", "ProcessConfig", process.id, {
      processName,
      displayName,
      processOrder,
      secondsPerUnit,
    });

    return {
      success: true,
      message: `Process "${displayName}" created successfully`,
      warning: "Remember to add inventory transitions in productivity.server.ts if needed",
    };
  }

  if (intent === "update-process") {
    const processId = formData.get("processId") as string;
    const secondsPerUnit = parseInt(formData.get("secondsPerUnit") as string, 10);

    if (!secondsPerUnit || secondsPerUnit < 1) {
      return { error: "Seconds per unit must be at least 1" };
    }

    await prisma.processConfig.update({
      where: { id: processId },
      data: { secondsPerUnit },
    });

    await createAuditLog(user.id, "UPDATE_PROCESS_TIME", "ProcessConfig", processId, {
      secondsPerUnit,
    });

    return { success: true, message: "Process time updated" };
  }

  if (intent === "edit-process") {
    const processId = formData.get("processId") as string;
    const processName = formData.get("processName") as string;
    const displayName = formData.get("displayName") as string;
    const processOrderStr = formData.get("processOrder") as string;
    const processOrder = processOrderStr ? parseInt(processOrderStr, 10) : null;
    const description = formData.get("description") as string;
    const secondsPerUnit = parseInt(formData.get("secondsPerUnit") as string, 10);
    const selectedSkuIds = formData.getAll("skuIds") as string[];

    if (!processName || processName.trim().length === 0) {
      return { error: "Process name is required" };
    }

    if (!displayName || displayName.trim().length === 0) {
      return { error: "Display name is required" };
    }

    if (!secondsPerUnit || secondsPerUnit < 1) {
      return { error: "Seconds per unit must be at least 1" };
    }

    // Check if processName is being changed and if new name already exists
    const existingProcess = await prisma.processConfig.findUnique({
      where: { id: processId },
    });

    if (existingProcess && processName !== existingProcess.processName) {
      const duplicate = await prisma.processConfig.findUnique({
        where: { processName },
      });
      if (duplicate) {
        return { error: `Process name "${processName}" already exists` };
      }
    }

    await prisma.processConfig.update({
      where: { id: processId },
      data: {
        processName: processName.trim().toUpperCase(),
        displayName: displayName.trim(),
        processOrder,
        description: description?.trim() || null,
        secondsPerUnit,
      },
    });

    // Update SKU categories to match this process
    if (selectedSkuIds.length > 0) {
      await prisma.sku.updateMany({
        where: {
          id: { in: selectedSkuIds },
        },
        data: {
          category: displayName.trim(),
        },
      });
    }

    await createAuditLog(user.id, "EDIT_PROCESS", "ProcessConfig", processId, {
      processName,
      displayName,
      secondsPerUnit,
      skuCount: selectedSkuIds.length,
    });

    return { success: true, message: `Process "${displayName}" updated successfully with ${selectedSkuIds.length} SKUs` };
  }

  if (intent === "delete-process") {
    const processId = formData.get("processId") as string;

    const process = await prisma.processConfig.findUnique({
      where: { id: processId },
    });

    if (!process) {
      return { error: "Process not found" };
    }

    // Soft delete by setting isActive to false
    await prisma.processConfig.update({
      where: { id: processId },
      data: { isActive: false },
    });

    await createAuditLog(user.id, "DELETE_PROCESS", "ProcessConfig", processId, {
      processName: process.processName,
      displayName: process.displayName,
    });

    return { success: true, message: `Process "${process.displayName}" deleted successfully` };
  }

  if (intent === "rename-category") {
    const oldName = formData.get("oldName") as string;
    const newName = formData.get("newName") as string;

    if (!oldName || !newName) {
      return { error: "Both old and new category names are required" };
    }

    if (oldName === newName) {
      return { error: "New category name must be different" };
    }

    // Update all SKUs with this category
    const result = await prisma.sku.updateMany({
      where: { category: oldName },
      data: { category: newName },
    });

    await createAuditLog(user.id, "RENAME_CATEGORY", "Sku", "", {
      oldName,
      newName,
      skuCount: result.count,
    });

    return { success: true, message: `Category renamed from "${oldName}" to "${newName}" (${result.count} SKUs updated)` };
  }

  if (intent === "delete-category") {
    const categoryName = formData.get("categoryName") as string;

    if (!categoryName) {
      return { error: "Category name is required" };
    }

    // Remove category from all SKUs (set to null)
    const result = await prisma.sku.updateMany({
      where: { category: categoryName },
      data: { category: null },
    });

    await createAuditLog(user.id, "DELETE_CATEGORY", "Sku", "", {
      categoryName,
      skuCount: result.count,
    });

    return { success: true, message: `Category "${categoryName}" deleted (${result.count} SKUs now uncategorized)` };
  }

  return { error: "Invalid action" };
};

export default function Capacity() {
  const {
    user,
    processConfigs,
    allSkus,
    workers,
    totalWeeklyHours,
    scheduledWorkers,
    categoryInventory,
    categories,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [editingProcess, setEditingProcess] = useState<any | null>(null);
  const [selectedSkuIds, setSelectedSkuIds] = useState<Set<string>>(new Set());
  const [skuSearchQuery, setSkuSearchQuery] = useState("");

  // Filter SKUs based on search query
  const filteredSkus = allSkus.filter(sku => {
    if (!skuSearchQuery) return true;

    const query = skuSearchQuery.toLowerCase();
    return (
      sku.sku.toLowerCase().includes(query) ||
      (sku.name && sku.name.toLowerCase().includes(query)) ||
      (sku.category && sku.category.toLowerCase().includes(query))
    );
  });

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Process Times</h1>
        <p className="page-subtitle">Configure time per unit for each process</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{scheduledWorkers}</div>
          <div className="stat-label">Scheduled Workers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalWeeklyHours.toFixed(1)}</div>
          <div className="stat-label">Weekly Hours Available</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{processConfigs.length}</div>
          <div className="stat-label">Process Types</div>
        </div>
      </div>

      {/* Process Time Configuration */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Process Times</h2>
          <p className="text-sm text-gray-500">Time per unit for each process</p>
        </div>
        <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Process Name</th>
                  <th>SKUs Assigned</th>
                  <th>Description</th>
                  <th>Time per Unit</th>
                  {user.role === "ADMIN" && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {processConfigs.map((config) => {
                  const skusForProcess = allSkus.filter(s => matchesProcess(s.material, config.displayName));
                  return (
                    <tr key={config.id}>
                      <td>
                        <span className="text-gray-600 font-mono text-sm">
                          {config.processOrder ?? "—"}
                        </span>
                      </td>
                      <td>
                        <div className="font-semibold">{config.displayName}</div>
                      </td>
                      <td>
                        <span className="font-semibold text-blue-600">
                          {skusForProcess.length}
                        </span>
                        <span className="text-sm text-gray-500 ml-1">SKU{skusForProcess.length !== 1 ? 's' : ''}</span>
                      </td>
                      <td>
                        <div className="text-sm text-gray-600">{config.description || "—"}</div>
                      </td>
                      <td>
                        {config.secondsPerUnit > 0 ? (
                          <>
                            <span className="font-mono font-semibold">{config.secondsPerUnit}</span>
                            <span className="text-sm text-gray-500 ml-1">sec/unit</span>
                          </>
                        ) : (
                          <span className="badge bg-yellow-100 text-yellow-800">Unassigned</span>
                        )}
                      </td>
                      {user.role === "ADMIN" && (
                        <td>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSkuIds(new Set(skusForProcess.map(s => s.id)));
                                setEditingProcess(config);
                              }}
                              className="btn btn-sm btn-secondary"
                            >
                              Edit
                            </button>
                          <Form method="post" className="inline" onSubmit={(e) => {
                            if (!confirm(`Are you sure you want to delete "${config.displayName}"?`)) {
                              e.preventDefault();
                            }
                          }}>
                            <input type="hidden" name="intent" value="delete-process" />
                            <input type="hidden" name="processId" value={config.id} />
                            <button type="submit" className="btn btn-sm btn-error">
                              Delete
                            </button>
                          </Form>
                        </div>
                      </td>
                    )}
                    </tr>
                  );
                })}

                {processConfigs.length === 0 && (
                  <tr>
                    <td colSpan={user.role === "ADMIN" ? 6 : 5} className="text-center text-gray-500 py-4">
                      No process configurations found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Create New Process */}
            {user.role === "ADMIN" && (
              <div className="mt-6 pt-6 border-t">
                <h3 className="font-semibold mb-4">Create New Process</h3>
                <Form method="post">
                  <input type="hidden" name="intent" value="create-process" />

                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="form-group mb-0">
                      <label className="form-label">Process Order</label>
                      <input
                        type="number"
                        name="processOrder"
                        min="1"
                        step="1"
                        placeholder="e.g., 1, 2, 3..."
                        className="form-input"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Order in production workflow
                      </p>
                    </div>

                    <div className="form-group mb-0">
                      <label className="form-label">Display Name *</label>
                      <input
                        type="text"
                        name="displayName"
                        required
                        placeholder="e.g., Tipping"
                        className="form-input"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        User-friendly process name
                      </p>
                    </div>

                    <div className="form-group mb-0">
                      <label className="form-label">Seconds Per Unit</label>
                      <input
                        type="number"
                        name="secondsPerUnit"
                        min="1"
                        step="1"
                        placeholder="120"
                        className="form-input"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Time to complete one unit
                      </p>
                    </div>
                  </div>

                  <div className="form-group mb-4">
                    <label className="form-label">Description (Optional)</label>
                    <textarea
                      name="description"
                      placeholder="Describe what this process involves..."
                      className="form-input"
                      rows={2}
                    />
                  </div>

                  {actionData?.warning && (
                    <div className="alert alert-warning mb-4 text-sm">
                      <strong>Note:</strong> {actionData.warning}
                    </div>
                  )}

                  <button type="submit" className="btn btn-primary w-full" disabled={isSubmitting}>
                    {isSubmitting ? "Creating..." : "Create Process"}
                  </button>
                </Form>
              </div>
            )}
        </div>
      </div>

      {/* Current Inventory by Category */}
      {Object.keys(categoryInventory).length > 0 && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Inventory by Process Category</h2>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(categoryInventory).map(([category, data]) => (
                <div key={category} className="p-4 bg-gray-50 rounded border">
                  <div className="font-semibold">{category}</div>
                  <div className="text-2xl font-bold text-beast-600">
                    {data.available.toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-500">{data.skuCount} SKUs</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Category Management */}
      {user.role === "ADMIN" && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Category Management</h2>
            <p className="text-sm text-gray-500">Manage SKU categories for organization</p>
          </div>
          <div className="card-body">
            {categories.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                <p>No categories defined yet</p>
                <p className="text-sm mt-2">Categories are created automatically when you assign them to SKUs</p>
              </div>
            ) : (
              <div className="space-y-4">
                {categories.map((category) => {
                  const skuCount = Object.values(allSkus).filter(s => s.category === category).length;
                  return (
                    <div key={category} className="flex items-center justify-between p-4 bg-gray-50 rounded border">
                      <div className="flex-1">
                        <div className="font-semibold">{category}</div>
                        <div className="text-sm text-gray-500">{skuCount} SKU{skuCount !== 1 ? 's' : ''}</div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const newName = prompt(`Rename category "${category}" to:`, category);
                            if (newName && newName.trim() !== "" && newName !== category) {
                              const form = document.createElement('form');
                              form.method = 'POST';
                              form.innerHTML = `
                                <input type="hidden" name="intent" value="rename-category" />
                                <input type="hidden" name="oldName" value="${category}" />
                                <input type="hidden" name="newName" value="${newName.trim()}" />
                              `;
                              document.body.appendChild(form);
                              form.submit();
                            }
                          }}
                          className="btn btn-sm btn-secondary"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Delete category "${category}"? This will remove the category from ${skuCount} SKU${skuCount !== 1 ? 's' : ''}.`)) {
                              const form = document.createElement('form');
                              form.method = 'POST';
                              form.innerHTML = `
                                <input type="hidden" name="intent" value="delete-category" />
                                <input type="hidden" name="categoryName" value="${category}" />
                              `;
                              document.body.appendChild(form);
                              form.submit();
                            }
                          }}
                          className="btn btn-sm btn-error"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-6 pt-6 border-t">
              <p className="text-sm text-gray-600 mb-2">
                <strong>Note:</strong> Categories are automatically created when you assign them to SKUs during SKU creation or editing.
                You can rename or delete existing categories here.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Edit Process Modal */}
      {editingProcess && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">Edit Process</h3>
                <button
                  onClick={() => {
                    setEditingProcess(null);
                    setSelectedSkuIds(new Set());
                  }}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <Form method="post" className="p-6">
              <input type="hidden" name="intent" value="edit-process" />
              <input type="hidden" name="processId" value={editingProcess.id} />

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="form-group">
                    <label className="form-label">Process Order</label>
                    <input
                      type="number"
                      name="processOrder"
                      defaultValue={editingProcess.processOrder || ""}
                      className="form-input"
                      min="1"
                      step="1"
                      placeholder="e.g., 1, 2, 3..."
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Order in production workflow
                    </p>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Seconds Per Unit *</label>
                    <input
                      type="number"
                      name="secondsPerUnit"
                      defaultValue={editingProcess.secondsPerUnit}
                      className="form-input"
                      required
                      min="1"
                      step="1"
                      placeholder="120"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Time to complete one unit
                    </p>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Process Name *</label>
                  <input
                    type="text"
                    name="processName"
                    defaultValue={editingProcess.processName}
                    className="form-input"
                    required
                    placeholder="e.g., TIPPING, BLADING"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Internal name used in code (UPPERCASE with underscores)
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Display Name *</label>
                  <input
                    type="text"
                    name="displayName"
                    defaultValue={editingProcess.displayName}
                    className="form-input"
                    required
                    placeholder="e.g., Tipping, Blading"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    User-friendly name shown in the interface
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Description</label>
                  <textarea
                    name="description"
                    defaultValue={editingProcess.description || ""}
                    className="form-input"
                    rows={3}
                    placeholder="Describe what this process involves..."
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">SKUs in This Process ({selectedSkuIds.size} selected)</label>
                  <p className="text-sm text-gray-600 mb-3">
                    Select which SKUs are processed in this step. Selected SKUs will have their category updated to match this process.
                  </p>

                  {/* Search input */}
                  <input
                    type="text"
                    placeholder="Search by SKU code, name, or category..."
                    value={skuSearchQuery}
                    onChange={(e) => setSkuSearchQuery(e.target.value)}
                    className="form-input text-sm mb-3"
                  />

                  <div className="border rounded-lg max-h-64 overflow-y-auto p-3 space-y-2">
                    {filteredSkus.length === 0 ? (
                      <p className="text-sm text-gray-500 text-center py-4">
                        No SKUs match your search
                      </p>
                    ) : (
                      <>
                        {skuSearchQuery && (
                          <div className="text-xs text-gray-500 pb-2 mb-2 border-b">
                            Showing {filteredSkus.length} SKU{filteredSkus.length !== 1 ? 's' : ''}
                          </div>
                        )}
                        {filteredSkus.map((sku) => (
                      <label key={sku.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <input
                          type="checkbox"
                          name="skuIds"
                          value={sku.id}
                          checked={selectedSkuIds.has(sku.id)}
                          onChange={(e) => {
                            const newSet = new Set(selectedSkuIds);
                            if (e.target.checked) {
                              newSet.add(sku.id);
                            } else {
                              newSet.delete(sku.id);
                            }
                            setSelectedSkuIds(newSet);
                          }}
                          className="form-checkbox"
                        />
                        <div className="flex-1">
                          <div className="font-mono text-sm font-semibold">{sku.sku}</div>
                          <div className="text-sm text-gray-600">{sku.name}</div>
                          <div className="text-xs text-gray-500">
                            {sku.type} {sku.category && `• Current: ${sku.category}`}
                          </div>
                        </div>
                      </label>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6 pt-4 border-t">
                <button
                  type="submit"
                  className="btn btn-primary flex-1"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Saving..." : "Save Changes"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingProcess(null);
                    setSelectedSkuIds(new Set());
                    setSkuSearchQuery("");
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </Layout>
  );
}
