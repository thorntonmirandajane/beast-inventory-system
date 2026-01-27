import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get process configurations
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
    orderBy: { processName: "asc" },
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

  return {
    user,
    processConfigs,
    workers: workersWithHours,
    totalWeeklyHours,
    scheduledWorkers,
    categoryInventory,
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

    if (!secondsPerUnit || secondsPerUnit < 1) {
      return { error: "Seconds per unit must be at least 1" };
    }

    // Check for duplicates
    const existing = await prisma.processConfig.findUnique({
      where: { processName },
    });

    if (existing) {
      return { error: `Process "${processName}" already exists` };
    }

    // Create process
    const process = await prisma.processConfig.create({
      data: {
        processName,
        displayName,
        description: description || null,
        secondsPerUnit,
        isActive: true,
      },
    });

    await createAuditLog(user.id, "CREATE_PROCESS", "ProcessConfig", process.id, {
      processName,
      displayName,
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
    const displayName = formData.get("displayName") as string;
    const description = formData.get("description") as string;
    const secondsPerUnit = parseInt(formData.get("secondsPerUnit") as string, 10);

    if (!displayName || displayName.trim().length === 0) {
      return { error: "Display name is required" };
    }

    if (!secondsPerUnit || secondsPerUnit < 1) {
      return { error: "Seconds per unit must be at least 1" };
    }

    await prisma.processConfig.update({
      where: { id: processId },
      data: {
        displayName: displayName.trim(),
        description: description?.trim() || null,
        secondsPerUnit,
      },
    });

    await createAuditLog(user.id, "EDIT_PROCESS", "ProcessConfig", processId, {
      displayName,
      secondsPerUnit,
    });

    return { success: true, message: `Process "${displayName}" updated successfully` };
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

  return { error: "Invalid action" };
};

export default function Capacity() {
  const {
    user,
    processConfigs,
    workers,
    totalWeeklyHours,
    scheduledWorkers,
    categoryInventory,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

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
            <div className="space-y-4">
              {processConfigs.map((config) => (
                <Form
                  key={config.id}
                  method="post"
                  className="flex items-center justify-between p-3 bg-gray-50 rounded border"
                >
                  <input type="hidden" name="intent" value="update-process" />
                  <input type="hidden" name="processId" value={config.id} />

                  <div className="flex-1">
                    <div className="font-semibold">{config.displayName}</div>
                    <div className="text-sm text-gray-500">{config.processName}</div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        name="secondsPerUnit"
                        defaultValue={config.secondsPerUnit}
                        className="form-input w-20 text-center"
                        min="1"
                      />
                      <span className="text-sm text-gray-500">sec/unit</span>
                    </div>
                    {user.role === "ADMIN" && (
                      <button
                        type="submit"
                        className="btn btn-sm btn-secondary"
                        disabled={isSubmitting}
                      >
                        Save
                      </button>
                    )}
                  </div>
                </Form>
              ))}

              {processConfigs.length === 0 && (
                <div className="text-center text-gray-500 py-4">
                  No process configurations found
                </div>
              )}
            </div>

            {/* Create New Process */}
            {user.role === "ADMIN" && (
              <div className="mt-6 pt-6 border-t">
                <h3 className="font-semibold mb-4">Create New Process</h3>
                <Form method="post">
                  <input type="hidden" name="intent" value="create-process" />

                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="form-group mb-0">
                      <label className="form-label">Display Name *</label>
                      <input
                        type="text"
                        name="displayName"
                        required
                        placeholder="e.g., Packaging"
                        className="form-input"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Process name will be auto-generated (e.g., PACKAGING)
                      </p>
                    </div>

                    <div className="form-group mb-0">
                      <label className="form-label">Seconds Per Unit *</label>
                      <input
                        type="number"
                        name="secondsPerUnit"
                        required
                        min="1"
                        step="1"
                        placeholder="120"
                        className="form-input"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Average time to complete one unit
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
    </Layout>
  );
}
