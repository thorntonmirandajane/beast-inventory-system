import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { createWorkerTask, getAllProcessConfigs } from "../utils/productivity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Only admins/managers can access
  if (user.role === "WORKER") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all active workers
  const workers = await prisma.user.findMany({
    where: { isActive: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Get all process configs
  const processConfigs = await getAllProcessConfigs();

  // Get all active SKUs for optional SKU-specific tasks
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      category: true,
      type: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get existing pending tasks grouped by worker
  const existingTasks = await prisma.workerTask.findMany({
    where: {
      status: "PENDING",
    },
    include: {
      user: {
        select: { firstName: true, lastName: true },
      },
      sku: {
        select: { sku: true, name: true },
      },
      assignedBy: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: [
      { userId: "asc" },
      { assignmentType: "asc" },
      { priority: "desc" },
      { createdAt: "asc" },
    ],
  });

  // Group tasks by worker
  const tasksByWorker: Record<string, typeof existingTasks> = {};
  for (const task of existingTasks) {
    if (!tasksByWorker[task.userId]) {
      tasksByWorker[task.userId] = [];
    }
    tasksByWorker[task.userId].push(task);
  }

  return { user, workers, processConfigs, skus, tasksByWorker };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role === "WORKER") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create-task") {
    const userId = formData.get("userId") as string;
    const processName = formData.get("processName") as string;
    const skuId = formData.get("skuId") as string | null;
    const targetQuantity = formData.get("targetQuantity") as string;
    const priority = formData.get("priority") as string;
    const assignmentType = formData.get("assignmentType") as "DAILY" | "BACKLOG";
    const dueDate = formData.get("dueDate") as string;
    const notes = formData.get("notes") as string;

    if (!userId || !processName || !assignmentType) {
      return { error: "Worker, process, and assignment type are required" };
    }

    const task = await createWorkerTask({
      userId,
      processName,
      skuId: skuId || null,
      targetQuantity: targetQuantity ? parseInt(targetQuantity, 10) : null,
      priority: priority ? parseInt(priority, 10) : 0,
      assignmentType,
      assignedById: user.id,
      dueDate: dueDate ? new Date(dueDate) : null,
      notes: notes || null,
    });

    await createAuditLog(user.id, "CREATE_WORKER_TASK", "WorkerTask", task.id, {
      userId,
      processName,
      assignmentType,
    });

    return { success: true, message: "Task assigned successfully" };
  }

  if (intent === "delete-task") {
    const taskId = formData.get("taskId") as string;

    await prisma.workerTask.update({
      where: { id: taskId },
      data: { status: "CANCELLED" },
    });

    await createAuditLog(user.id, "CANCEL_WORKER_TASK", "WorkerTask", taskId, {});

    return { success: true, message: "Task cancelled" };
  }

  return { error: "Invalid action" };
};

export default function TaskAssignments() {
  const { user, workers, processConfigs, skus, tasksByWorker } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedWorker, setSelectedWorker] = useState("");
  const [assignmentType, setAssignmentType] = useState<"DAILY" | "BACKLOG">("DAILY");
  const [selectedProcess, setSelectedProcess] = useState("");

  // Get today's date for the date input default
  const today = new Date().toISOString().split("T")[0];

  // Get selected process config
  const selectedProcessConfig = processConfigs.find(p => p.processName === selectedProcess);

  // Filter SKUs based on selected process (same logic as worker submit)
  const filteredSkus = selectedProcess
    ? skus.filter(sku => {
        if (!selectedProcessConfig) return false;

        const processName = selectedProcessConfig.processName;

        // TIPPING: Works with ASSEMBLY items (creates assembled tips from raw materials)
        if (processName === "TIPPING") {
          return sku.type === "ASSEMBLY" && (sku.category === "Ferrules" || sku.category === "Broadheads" || sku.category === "Tips");
        }

        // BLADING: Works with ASSEMBLY items that can have blades added
        if (processName === "BLADING") {
          return sku.type === "ASSEMBLY" && (sku.category === "Ferrules" || sku.category === "Broadheads");
        }

        // STUD_TESTING: Works with raw studs
        if (processName === "STUD_TESTING") {
          return sku.category === "Studs";
        }

        // COMPLETE_PACKS: Works with COMPLETED (packaged) products
        if (processName === "COMPLETE_PACKS") {
          return sku.type === "COMPLETED";
        }

        return true;
      })
    : skus;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Task Assignments</h1>
        <p className="page-subtitle">Assign work to production workers</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Create Task Form */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Assign New Task</h2>
          </div>
          <div className="card-body">
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="create-task" />

              <div className="form-group">
                <label className="form-label">Worker *</label>
                <select
                  name="userId"
                  className="form-select"
                  required
                  value={selectedWorker}
                  onChange={(e) => setSelectedWorker(e.target.value)}
                >
                  <option value="">Select worker...</option>
                  {workers.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.lastName.toUpperCase()}, {worker.firstName.toUpperCase()} ({worker.role})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Process *</label>
                <select
                  name="processName"
                  className="form-select"
                  required
                  value={selectedProcess}
                  onChange={(e) => setSelectedProcess(e.target.value)}
                >
                  <option value="">Select process...</option>
                  {processConfigs.map((config) => (
                    <option key={config.processName} value={config.processName}>
                      {config.displayName} ({config.secondsPerUnit} sec/unit)
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Assignment Type *</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="assignmentType"
                      value="DAILY"
                      checked={assignmentType === "DAILY"}
                      onChange={() => setAssignmentType("DAILY")}
                      className="form-radio"
                    />
                    <span>Daily (specific date)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="assignmentType"
                      value="BACKLOG"
                      checked={assignmentType === "BACKLOG"}
                      onChange={() => setAssignmentType("BACKLOG")}
                      className="form-radio"
                    />
                    <span>Backlog (queue)</span>
                  </label>
                </div>
              </div>

              {assignmentType === "DAILY" && (
                <div className="form-group">
                  <label className="form-label">Due Date</label>
                  <input
                    type="date"
                    name="dueDate"
                    className="form-input"
                    defaultValue={today}
                  />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">SKU (optional)</label>
                <select name="skuId" className="form-select">
                  <option value="">
                    {!selectedProcess ? "Select process first..." : "Any SKU / General task"}
                  </option>
                  {filteredSkus.map((sku) => (
                    <option key={sku.id} value={sku.id}>
                      {sku.sku} | {sku.name}
                    </option>
                  ))}
                </select>
                {selectedProcess && filteredSkus.length === 0 ? (
                  <p className="text-sm text-yellow-600 mt-1">
                    No SKUs found for this process type
                  </p>
                ) : (
                  <p className="text-sm text-gray-500 mt-1">
                    Optionally specify which SKU to work on
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="form-group">
                  <label className="form-label">Target Quantity</label>
                  <input
                    type="number"
                    name="targetQuantity"
                    className="form-input"
                    placeholder="Optional"
                    min="1"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Priority</label>
                  <select name="priority" className="form-select">
                    <option value="0">Normal</option>
                    <option value="1">High</option>
                    <option value="2">Urgent</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea
                  name="notes"
                  className="form-textarea"
                  rows={2}
                  placeholder="Optional instructions..."
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Assigning..." : "Assign Task"}
              </button>
            </Form>
          </div>
        </div>

        {/* Current Assignments */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Current Assignments</h2>
            <p className="text-sm text-gray-500">
              Pending and in-progress tasks by worker
            </p>
          </div>
          <div className="card-body max-h-[600px] overflow-y-auto">
            {Object.entries(tasksByWorker).length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                No pending tasks assigned
              </div>
            ) : (
              <div className="space-y-6">
                {workers.map((worker) => {
                  const workerTasks = tasksByWorker[worker.id];
                  if (!workerTasks || workerTasks.length === 0) return null;

                  return (
                    <div key={worker.id}>
                      <h3 className="font-semibold text-gray-700 mb-2 border-b pb-1">
                        {worker.lastName.toUpperCase()}, {worker.firstName.toUpperCase()}
                      </h3>
                      <div className="space-y-2">
                        {workerTasks.map((task) => (
                          <div
                            key={task.id}
                            className={`flex items-center justify-between p-2 rounded border ${
                              task.assignmentType === "DAILY"
                                ? "bg-blue-50 border-blue-200"
                                : "bg-gray-50 border-gray-200"
                            }`}
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">
                                  {processConfigs.find(
                                    (p) => p.processName === task.processName
                                  )?.displayName || task.processName}
                                </span>
                                <span
                                  className={`badge text-xs ${
                                    task.assignmentType === "DAILY"
                                      ? "bg-blue-200 text-blue-700"
                                      : "bg-gray-200 text-gray-700"
                                  }`}
                                >
                                  {task.assignmentType}
                                </span>
                                {task.priority > 0 && (
                                  <span
                                    className={`badge text-xs ${
                                      task.priority >= 2
                                        ? "bg-red-200 text-red-700"
                                        : "bg-yellow-200 text-yellow-700"
                                    }`}
                                  >
                                    {task.priority >= 2 ? "URGENT" : "HIGH"}
                                  </span>
                                )}
                              </div>
                              {task.sku && (
                                <div className="text-xs text-gray-500 font-mono">
                                  {task.sku.sku}
                                </div>
                              )}
                              {task.targetQuantity && (
                                <div className="text-xs text-gray-500">
                                  Target: {task.targetQuantity.toLocaleString()} units
                                </div>
                              )}
                              {task.dueDate && (
                                <div className="text-xs text-gray-500">
                                  Due: {new Date(task.dueDate).toLocaleDateString()}
                                </div>
                              )}
                            </div>
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete-task" />
                              <input type="hidden" name="taskId" value={task.id} />
                              <button
                                type="submit"
                                className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                                title="Cancel task"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  strokeWidth={1.5}
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </Form>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
