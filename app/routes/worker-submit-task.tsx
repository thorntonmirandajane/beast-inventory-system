import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, redirect, useFetcher } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { useState } from "react";

interface PendingTask {
  id: string; // Client-side temp ID
  processName: string;
  processDisplayName: string;
  skuId: string | null;
  skuDisplay: string | null;
  quantity: number;
  isMisc: boolean;
  miscDescription: string | null;
  secondsPerUnit: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get today's date for task history
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get today's tasks (if any) - these are tasks submitted today
  // Workers can now submit tasks without being clocked in
  const todaysTasks = await prisma.timeEntryLine.findMany({
    where: {
      timeEntry: {
        userId: user.id,
        createdAt: { gte: today },
      },
    },
    include: { sku: true },
    orderBy: { createdAt: "desc" },
  });

  // Get all active processes from ProcessConfig
  const processes = await prisma.processConfig.findMany({
    where: { isActive: true },
    orderBy: { displayName: "asc" },
  });

  // Get all active ASSEMBLY and COMPLETED SKUs with category info
  // Workers only work on assemblies and completed products, not raw materials
  const skus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLY", "COMPLETED"] }
    },
    select: {
      id: true,
      sku: true,
      name: true,
      category: true,
      type: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get assigned tasks for display
  const assignedTasks = await prisma.workerTask.findMany({
    where: {
      userId: user.id,
      status: "PENDING",
      OR: [
        { dueDate: { lte: new Date() } },
        { assignmentType: "BACKLOG" },
      ],
    },
    include: { sku: true },
    orderBy: { priority: "desc" },
  });

  return { user, todaysTasks, processes, skus, assignedTasks };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "submit-tasks") {
    const tasksJson = formData.get("tasks") as string;

    if (!tasksJson) {
      return { error: "No tasks to submit" };
    }

    const tasks: PendingTask[] = JSON.parse(tasksJson);

    if (tasks.length === 0) {
      return { error: "No tasks to submit" };
    }

    // Find or create today's time entry
    // Workers can now submit tasks without being clocked in
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Try to find today's clock-in event first
    const clockInEvent = await prisma.clockEvent.findFirst({
      where: {
        userId: user.id,
        type: "CLOCK_IN",
        timestamp: { gte: today, lt: tomorrow },
      },
      orderBy: { timestamp: "desc" },
    });

    let timeEntry;

    if (clockInEvent) {
      // If there's a clock-in today, use/create time entry linked to it
      timeEntry = await prisma.workerTimeEntry.findUnique({
        where: { clockInEventId: clockInEvent.id },
      });

      if (!timeEntry) {
        timeEntry = await prisma.workerTimeEntry.create({
          data: {
            userId: user.id,
            clockInEventId: clockInEvent.id,
            clockInTime: clockInEvent.timestamp,
            status: "DRAFT",
          },
        });
      }
    } else {
      // No clock-in today, find or create a standalone time entry for today
      timeEntry = await prisma.workerTimeEntry.findFirst({
        where: {
          userId: user.id,
          createdAt: { gte: today, lt: tomorrow },
          clockInEventId: null, // Standalone entry
        },
      });

      if (!timeEntry) {
        // Create standalone time entry for tasks submitted without clocking in
        timeEntry = await prisma.workerTimeEntry.create({
          data: {
            userId: user.id,
            clockInTime: new Date(), // Use current time
            status: "DRAFT",
            // Note: clockInEventId is null for standalone entries
          },
        });
      }
    }

    // Create all TimeEntryLine records
    for (const task of tasks) {
      await prisma.timeEntryLine.create({
        data: {
          timeEntryId: timeEntry.id,
          processName: task.processName,
          skuId: task.isMisc ? null : task.skuId,
          quantityCompleted: task.quantity,
          secondsPerUnit: task.secondsPerUnit,
          expectedSeconds: task.quantity * task.secondsPerUnit,
          isMisc: task.isMisc,
          miscDescription: task.isMisc ? task.miscDescription : null,
        },
      });

      await createAuditLog(user.id, "SUBMIT_TASK", "TimeEntryLine", timeEntry.id, {
        processName: task.processName,
        skuId: task.skuId,
        quantity: task.quantity,
        isMisc: task.isMisc,
      });
    }

    return redirect("/worker-dashboard?submitted=true");
  }

  if (intent === "delete-task") {
    const lineId = formData.get("lineId") as string;

    if (!lineId) {
      return { error: "No task specified" };
    }

    // Verify this line belongs to the user
    const line = await prisma.timeEntryLine.findUnique({
      where: { id: lineId },
      include: { timeEntry: true },
    });

    if (!line || line.timeEntry.userId !== user.id) {
      return { error: "Unauthorized" };
    }

    // Only allow deletion if time entry is still in DRAFT status
    if (line.timeEntry.status !== "DRAFT") {
      return { error: "Cannot delete tasks from submitted time entries" };
    }

    await prisma.timeEntryLine.delete({
      where: { id: lineId },
    });

    return { success: true, message: "Task removed" };
  }

  return { error: "Invalid action" };
};

export default function WorkerSubmitTask() {
  const { user, todaysTasks, processes, skus, assignedTasks } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const isSubmitting = navigation.state === "submitting";

  // Client-side state for task staging
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);
  const [selectedProcess, setSelectedProcess] = useState("");
  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [miscDescription, setMiscDescription] = useState("");

  // Filter SKUs based on selected process
  const selectedProcessConfig = processes.find(p => p.processName === selectedProcess);
  const isMiscTask = selectedProcess === "MISC";

  const filteredSkus = isMiscTask
    ? []
    : skus.filter(sku => {
        if (!selectedProcessConfig) return false;

        // Filter SKUs based on process type
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

        // Default: show all SKUs for other processes
        return true;
      });

  const handleAddTask = () => {
    // Validation
    if (!selectedProcess) {
      alert("Please select a process");
      return;
    }

    if (!isMiscTask && !selectedSku) {
      alert("Please select a SKU");
      return;
    }

    if (isMiscTask && !miscDescription.trim()) {
      alert("Please provide a description for MISC task");
      return;
    }

    if (!quantity || quantity <= 0) {
      alert("Please enter a valid quantity");
      return;
    }

    const processConfig = processes.find(p => p.processName === selectedProcess);
    const sku = skus.find(s => s.id === selectedSku);

    const newTask: PendingTask = {
      id: crypto.randomUUID(),
      processName: selectedProcess,
      processDisplayName: processConfig?.displayName || selectedProcess,
      skuId: isMiscTask ? null : selectedSku,
      skuDisplay: isMiscTask ? null : (sku ? `${sku.sku} | ${sku.name}` : null),
      quantity,
      isMisc: isMiscTask,
      miscDescription: isMiscTask ? miscDescription : null,
      secondsPerUnit: processConfig?.secondsPerUnit || 60,
    };

    setPendingTasks([...pendingTasks, newTask]);

    // Reset form
    setQuantity(0);
    setMiscDescription("");
    setSelectedSku("");
  };

  const handleDeletePending = (taskId: string) => {
    setPendingTasks(pendingTasks.filter(t => t.id !== taskId));
  };

  const handleSubmitAll = () => {
    if (pendingTasks.length === 0) {
      alert("No tasks to submit");
      return;
    }

    const form = document.createElement("form");
    form.method = "post";
    form.style.display = "none";

    const intentInput = document.createElement("input");
    intentInput.type = "hidden";
    intentInput.name = "intent";
    intentInput.value = "submit-tasks";
    form.appendChild(intentInput);

    const tasksInput = document.createElement("input");
    tasksInput.type = "hidden";
    tasksInput.name = "tasks";
    tasksInput.value = JSON.stringify(pendingTasks);
    form.appendChild(tasksInput);

    document.body.appendChild(form);
    form.submit();
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Submit Tasks</h1>
        <p className="page-subtitle">Add multiple tasks, then submit all at once</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      {actionData?.success && (
        <div className="alert alert-success mb-6">{actionData.message}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Add task form */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Add Completed Work</h2>
          </div>
          <div className="card-body">
            <div className="space-y-4">
              <div className="form-group">
                <label htmlFor="processName" className="form-label">
                  Process Type
                </label>
                <select
                  id="processName"
                  value={selectedProcess}
                  onChange={(e) => {
                    setSelectedProcess(e.target.value);
                    setSelectedSku(""); // Reset SKU when process changes
                  }}
                  className="form-input"
                >
                  <option value="">Select process...</option>
                  {processes.map((proc) => (
                    <option key={proc.processName} value={proc.processName}>
                      {proc.displayName}
                    </option>
                  ))}
                  <option value="MISC">MISC (Miscellaneous)</option>
                </select>
              </div>

              {isMiscTask ? (
                <div className="form-group">
                  <label htmlFor="miscDescription" className="form-label">
                    Task Description *
                  </label>
                  <textarea
                    id="miscDescription"
                    value={miscDescription}
                    onChange={(e) => setMiscDescription(e.target.value)}
                    className="form-input"
                    rows={3}
                    placeholder="Describe the miscellaneous task..."
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label htmlFor="skuId" className="form-label">
                    SKU {selectedProcess && `(${selectedProcessConfig?.displayName})`}
                  </label>
                  <select
                    id="skuId"
                    value={selectedSku}
                    onChange={(e) => setSelectedSku(e.target.value)}
                    className="form-input"
                    disabled={!selectedProcess || isMiscTask}
                  >
                    <option value="">
                      {!selectedProcess ? "Select process first..." : "Select SKU..."}
                    </option>
                    {filteredSkus.map((sku) => (
                      <option key={sku.id} value={sku.id}>
                        {sku.sku} | {sku.name}
                      </option>
                    ))}
                  </select>
                  {selectedProcess && !isMiscTask && filteredSkus.length === 0 && (
                    <p className="text-sm text-yellow-600 mt-1">
                      No SKUs found for this process type
                    </p>
                  )}
                </div>
              )}

              <div className="form-group">
                <label htmlFor="quantity" className="form-label">
                  Quantity Completed
                </label>
                <input
                  type="number"
                  id="quantity"
                  value={quantity || ""}
                  onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                  className="form-input"
                  min="1"
                />
              </div>

              <button
                type="button"
                onClick={handleAddTask}
                className="btn btn-secondary w-full"
              >
                Add to List
              </button>
            </div>
          </div>
        </div>

        {/* Assigned tasks reference */}
        {assignedTasks.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Assigned Tasks (Reference)</h2>
            </div>
            <div className="card-body">
              <p className="text-sm text-gray-600 mb-4">
                These are your assigned tasks for reference.
              </p>
              <div className="space-y-3">
                {assignedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-3 bg-blue-50 border border-blue-200 rounded-lg"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">
                          {task.processName.replace(/_/g, " ")}
                        </p>
                        {task.sku && (
                          <p className="text-sm text-gray-600">
                            {task.sku.sku} | {task.sku.name}
                          </p>
                        )}
                        {task.targetQuantity && (
                          <p className="text-sm text-gray-500">
                            Target: {task.targetQuantity} units
                          </p>
                        )}
                        {task.notes && (
                          <p className="text-sm text-gray-500 mt-1">
                            {task.notes}
                          </p>
                        )}
                      </div>
                      {task.priority > 0 && (
                        <span className="badge bg-red-100 text-red-800 text-xs">
                          Priority {task.priority}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pending tasks staging area */}
      {pendingTasks.length > 0 && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Tasks to Submit ({pendingTasks.length})</h2>
          </div>
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>SKU / Description</th>
                  <th>Quantity</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingTasks.map((task) => (
                  <tr key={task.id}>
                    <td className="font-medium">{task.processDisplayName}</td>
                    <td>
                      {task.isMisc ? (
                        <div className="text-sm">
                          <span className="badge badge-secondary">MISC</span>
                          <p className="mt-1 text-gray-600">{task.miscDescription}</p>
                        </div>
                      ) : (
                        <span className="text-sm">{task.skuDisplay}</span>
                      )}
                    </td>
                    <td className="font-semibold">{task.quantity}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => handleDeletePending(task.id)}
                        className="btn btn-sm btn-danger"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 flex gap-4">
              <button
                type="button"
                onClick={handleSubmitAll}
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Submitting..." : "Approve & Submit All"}
              </button>
              <button
                type="button"
                onClick={() => setPendingTasks([])}
                className="btn btn-ghost"
              >
                Clear All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Previously submitted tasks today */}
      {todaysTasks && todaysTasks.length > 0 && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Previously Submitted Tasks Today</h2>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              {todaysTasks.map((line) => (
                <div
                  key={line.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="flex-1">
                    <p className="font-medium">
                      {line.processName.replace(/_/g, " ")}
                    </p>
                    {line.isMisc ? (
                      <div className="text-sm text-gray-600">
                        <span className="badge badge-secondary">MISC</span>
                        <p className="mt-1">{line.miscDescription}</p>
                      </div>
                    ) : line.sku ? (
                      <p className="text-sm text-gray-600">
                        {line.sku.sku} | {line.sku.name}
                      </p>
                    ) : null}
                    <p className="text-sm text-gray-500">
                      Quantity: {line.quantityCompleted}
                    </p>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete-task" />
                    <input type="hidden" name="lineId" value={line.id} />
                    <button
                      type="submit"
                      className="btn btn-sm btn-danger"
                      disabled={isSubmitting}
                    >
                      Remove
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
