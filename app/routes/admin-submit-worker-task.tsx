import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { useState } from "react";

interface PendingTask {
  id: string;
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

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all workers
  const workers = await prisma.user.findMany({
    where: {
      role: "WORKER",
      isActive: true
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Get all active processes
  const processes = await prisma.processConfig.findMany({
    where: { isActive: true },
    orderBy: { displayName: "asc" },
  });

  // Get all active SKUs
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      category: true,
      material: true,
      type: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  return { user, workers, processes, skus };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "submit-tasks") {
    const workerId = formData.get("workerId") as string;
    const date = formData.get("date") as string;
    const tasksJson = formData.get("tasks") as string;

    if (!workerId || !date || !tasksJson) {
      return { error: "Missing required fields" };
    }

    const tasks: PendingTask[] = JSON.parse(tasksJson);

    if (tasks.length === 0) {
      return { error: "No tasks to submit" };
    }

    // Parse the selected date
    const selectedDate = new Date(date);
    selectedDate.setHours(12, 0, 0, 0);

    // Find clock-in event for the worker on the selected date
    const startOfDay = new Date(selectedDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(selectedDate);
    endOfDay.setHours(23, 59, 59, 999);

    const clockInEvent = await prisma.clockEvent.findFirst({
      where: {
        userId: workerId,
        type: "CLOCK_IN",
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { timestamp: "desc" },
    });

    if (!clockInEvent) {
      return { error: "No clock-in found for this worker on the selected date" };
    }

    // Get or create time entry
    let timeEntry = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockInEvent.id },
    });

    if (!timeEntry) {
      timeEntry = await prisma.workerTimeEntry.create({
        data: {
          userId: workerId,
          clockInEventId: clockInEvent.id,
          clockInTime: clockInEvent.timestamp,
          status: "DRAFT",
        },
      });
    }

    // Create all TimeEntryLine records
    let totalExpectedSeconds = 0;
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

      totalExpectedSeconds += task.quantity * task.secondsPerUnit;

      await createAuditLog(user.id, "ADMIN_SUBMIT_TASK", "TimeEntryLine", timeEntry.id, {
        workerId,
        processName: task.processName,
        skuId: task.skuId,
        quantity: task.quantity,
        isMisc: task.isMisc,
      });
    }

    // Update time entry to PENDING status so it shows in approvals
    // Admin-submitted tasks are ready for approval
    await prisma.workerTimeEntry.update({
      where: { id: timeEntry.id },
      data: {
        status: "PENDING",
        expectedMinutes: totalExpectedSeconds / 60,
      },
    });

    return { success: true, message: `Successfully submitted ${tasks.length} task(s) for worker. Entry is now pending approval.` };
  }

  return { error: "Invalid action" };
};

export default function AdminSubmitWorkerTask() {
  const { user, workers, processes, skus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedWorker, setSelectedWorker] = useState("");
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split("T")[0]);
  const [selectedProcess, setSelectedProcess] = useState("");
  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [miscDescription, setMiscDescription] = useState("");
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);

  const selectedProcessConfig = processes.find(p => p.processName === selectedProcess);
  const isMiscTask = selectedProcess === "MISC";

  // Filter SKUs based on selected process (same logic as worker submit)
  const filteredSkus = isMiscTask
    ? []
    : skus.filter(sku => {
        if (!selectedProcessConfig) return false;

        // Match SKU material field to process displayName
        // SKU material: "Bladed", "Tipped", "Stud Tested", "Completed Packs"
        // Process displayName: "Blading", "Tipping", "Stud Testing", "Complete Packs"
        if (!sku.material) return false;

        const matLower = sku.material.toLowerCase().trim();
        const procLower = selectedProcessConfig.displayName.toLowerCase().trim();

        // Direct match
        if (matLower === procLower) return true;

        // "bladed" -> "blading", "tipped" -> "tipping", "stud tested" -> "stud testing"
        if (matLower.replace(/ed$/, 'ing') === procLower) return true;

        // "completed packs" -> "complete packs"
        if (matLower.replace('completed', 'complete') === procLower) return true;

        return false;
      });

  const handleAddTask = () => {
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

    const selectedSkuObj = skus.find(s => s.id === selectedSku);

    const newTask: PendingTask = {
      id: crypto.randomUUID(),
      processName: selectedProcess,
      processDisplayName: selectedProcessConfig?.displayName || "MISC",
      skuId: isMiscTask ? null : selectedSku,
      skuDisplay: isMiscTask ? null : `${selectedSkuObj?.sku} | ${selectedSkuObj?.name}`,
      quantity,
      isMisc: isMiscTask,
      miscDescription: isMiscTask ? miscDescription : null,
      secondsPerUnit: selectedProcessConfig?.secondsPerUnit || 0,
    };

    setPendingTasks([...pendingTasks, newTask]);

    // Reset form
    setSelectedProcess("");
    setSelectedSku("");
    setQuantity(0);
    setMiscDescription("");
  };

  const handleRemoveTask = (taskId: string) => {
    setPendingTasks(pendingTasks.filter(t => t.id !== taskId));
  };

  const handleSubmitAll = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!selectedWorker) {
      alert("Please select a worker");
      return;
    }

    if (pendingTasks.length === 0) {
      alert("Please add at least one task");
      return;
    }

    // Submit the form with hidden input
    const form = e.currentTarget;
    const tasksInput = document.createElement("input");
    tasksInput.type = "hidden";
    tasksInput.name = "tasks";
    tasksInput.value = JSON.stringify(pendingTasks);
    form.appendChild(tasksInput);

    form.submit();
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Submit Tasks for Worker</h1>
        <p className="page-subtitle">Admin tool to submit tasks on behalf of workers</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success mb-6">
          {actionData.message}
          <button
            onClick={() => {
              setPendingTasks([]);
              setSelectedWorker("");
            }}
            className="btn btn-sm btn-ghost ml-4"
          >
            Submit Another
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Task Entry Form */}
        <div className="space-y-6">
          {/* Worker and Date Selection */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Select Worker & Date</h2>
            </div>
            <div className="card-body space-y-4">
              <div className="form-group">
                <label className="form-label">Worker *</label>
                <select
                  value={selectedWorker}
                  onChange={(e) => setSelectedWorker(e.target.value)}
                  className="form-select"
                  required
                >
                  <option value="">Select a worker...</option>
                  {workers.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.firstName} {worker.lastName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Date *</label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="form-input"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Worker must have clocked in on this date
                </p>
              </div>
            </div>
          </div>

          {/* Add Task Form */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Add Task</h2>
            </div>
            <div className="card-body space-y-4">
              <div className="form-group">
                <label className="form-label">Process Type *</label>
                <select
                  value={selectedProcess}
                  onChange={(e) => {
                    setSelectedProcess(e.target.value);
                    setSelectedSku("");
                  }}
                  className="form-select"
                >
                  <option value="">Select process...</option>
                  {processes.map((process) => (
                    <option key={process.id} value={process.processName}>
                      {process.displayName}
                    </option>
                  ))}
                  <option value="MISC">MISC (Miscellaneous)</option>
                </select>
              </div>

              {!isMiscTask && selectedProcess && (
                <div className="form-group">
                  <label className="form-label">SKU *</label>
                  <select
                    value={selectedSku}
                    onChange={(e) => setSelectedSku(e.target.value)}
                    className="form-select"
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

              {isMiscTask && (
                <div className="form-group">
                  <label className="form-label">Description *</label>
                  <textarea
                    value={miscDescription}
                    onChange={(e) => setMiscDescription(e.target.value)}
                    className="form-textarea"
                    rows={3}
                    placeholder="Describe the miscellaneous task..."
                  />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Quantity Completed *</label>
                <input
                  type="number"
                  value={quantity || ""}
                  onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                  className="form-input"
                  min="1"
                  placeholder="Enter quantity..."
                />
              </div>

              <button
                type="button"
                onClick={handleAddTask}
                className="btn btn-secondary w-full"
              >
                Add to Task List
              </button>
            </div>
          </div>
        </div>

        {/* Right: Pending Tasks & Submit */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Tasks to Submit ({pendingTasks.length})</h2>
          </div>
          <div className="card-body">
            {pendingTasks.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No tasks added yet.</p>
                <p className="text-sm mt-2">Add tasks using the form on the left.</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-6">
                  {pendingTasks.map((task, index) => (
                    <div
                      key={task.id}
                      className="flex items-start justify-between p-4 bg-gray-50 rounded-lg border border-gray-200"
                    >
                      <div className="flex items-start gap-4 flex-1">
                        <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-600 rounded-full font-semibold text-sm">
                          {index + 1}
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-gray-900">
                            {task.processDisplayName}
                          </p>
                          {task.isMisc ? (
                            <p className="text-sm text-gray-600 mt-1">
                              {task.miscDescription}
                            </p>
                          ) : (
                            <p className="text-sm text-gray-600 mt-1">
                              {task.skuDisplay}
                            </p>
                          )}
                          <p className="text-sm text-gray-500 mt-1">
                            Quantity: {task.quantity}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveTask(task.id)}
                        className="btn btn-ghost btn-sm text-red-600 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>

                <Form method="post" onSubmit={handleSubmitAll}>
                  <input type="hidden" name="intent" value="submit-tasks" />
                  <input type="hidden" name="workerId" value={selectedWorker} />
                  <input type="hidden" name="date" value={selectedDate} />

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setPendingTasks([])}
                      className="btn btn-ghost flex-1"
                    >
                      Clear All
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary flex-1"
                      disabled={isSubmitting || !selectedWorker}
                    >
                      {isSubmitting ? "Submitting..." : "Submit All Tasks"}
                    </button>
                  </div>
                </Form>
              </>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
