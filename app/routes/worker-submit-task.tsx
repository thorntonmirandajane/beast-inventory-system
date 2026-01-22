import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Check if user is clocked in
  const lastEvent = await prisma.clockEvent.findFirst({
    where: { userId: user.id },
    orderBy: { timestamp: "desc" },
  });

  const isClockedIn =
    lastEvent?.type === "CLOCK_IN" || lastEvent?.type === "BREAK_END";
  const isOnBreak = lastEvent?.type === "BREAK_START";

  if (!isClockedIn || isOnBreak) {
    return redirect("/time-clock");
  }

  // Get today's clock-in time to find active time entry
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const clockInEvent = await prisma.clockEvent.findFirst({
    where: {
      userId: user.id,
      type: "CLOCK_IN",
      timestamp: { gte: today },
    },
    orderBy: { timestamp: "desc" },
  });

  // Get or create draft time entry
  let timeEntry = null;
  if (clockInEvent) {
    timeEntry = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockInEvent.id },
      include: {
        lines: {
          include: { sku: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!timeEntry) {
      timeEntry = await prisma.workerTimeEntry.create({
        data: {
          userId: user.id,
          clockInEventId: clockInEvent.id,
          clockInTime: clockInEvent.timestamp,
          status: "DRAFT",
        },
        include: {
          lines: {
            include: { sku: true },
            orderBy: { createdAt: "desc" },
          },
        },
      });
    }
  }

  // Get process categories for selection
  const processCategories = ["TIPPING", "BLADING", "STUD_TESTING", "COMPLETE_PACKS"];

  // Get all active SKUs grouped by category
  const skus = await prisma.sku.findMany({
    where: { isActive: true },
    select: { id: true, sku: true, name: true, category: true },
    orderBy: [{ category: "asc" }, { sku: "asc" }],
  });

  // Get assigned tasks (as notes)
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

  return { user, timeEntry, processCategories, skus, assignedTasks };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add-task") {
    const processName = formData.get("processName") as string;
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (!processName || !skuId || isNaN(quantity) || quantity <= 0) {
      return { error: "Please provide process, SKU, and valid quantity" };
    }

    // Find today's time entry
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const clockInEvent = await prisma.clockEvent.findFirst({
      where: {
        userId: user.id,
        type: "CLOCK_IN",
        timestamp: { gte: today },
      },
      orderBy: { timestamp: "desc" },
    });

    if (!clockInEvent) {
      return { error: "No active clock-in found" };
    }

    let timeEntry = await prisma.workerTimeEntry.findUnique({
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

    // Get process config for seconds per unit (default if not found)
    const processConfig = await prisma.processConfig.findUnique({
      where: { processName },
    });
    const secondsPerUnit = processConfig?.secondsPerUnit || 60;

    // Create time entry line
    await prisma.timeEntryLine.create({
      data: {
        timeEntryId: timeEntry.id,
        processName,
        skuId,
        quantityCompleted: quantity,
        secondsPerUnit,
        expectedSeconds: quantity * secondsPerUnit,
      },
    });

    await createAuditLog(user.id, "SUBMIT_TASK", "TimeEntryLine", timeEntry.id, {
      processName,
      skuId,
      quantity,
    });

    return { success: true, message: `Task submitted: ${quantity} units` };
  }

  if (intent === "delete-task") {
    const lineId = formData.get("lineId") as string;

    if (!lineId) {
      return { error: "No task specified" };
    }

    // Verify this line belongs to the user's current time entry
    const line = await prisma.timeEntryLine.findUnique({
      where: { id: lineId },
      include: { timeEntry: true },
    });

    if (!line || line.timeEntry.userId !== user.id) {
      return { error: "Unauthorized" };
    }

    await prisma.timeEntryLine.delete({
      where: { id: lineId },
    });

    return { success: true, message: "Task removed" };
  }

  return { error: "Invalid action" };
};

export default function WorkerSubmitTask() {
  const { user, timeEntry, processCategories, skus, assignedTasks } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Submit Task</h1>
        <p className="page-subtitle">Record work completed during your shift</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      {actionData?.success && (
        <div className="alert alert-success mb-6">{actionData.message}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Submit new task */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Add Completed Work</h2>
          </div>
          <div className="card-body">
            <Form method="post">
              <input type="hidden" name="intent" value="add-task" />

              <div className="form-group">
                <label htmlFor="processName" className="form-label">
                  Process Type
                </label>
                <select
                  id="processName"
                  name="processName"
                  className="form-input"
                  required
                >
                  <option value="">Select process...</option>
                  {processCategories.map((proc) => (
                    <option key={proc} value={proc}>
                      {proc.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="skuId" className="form-label">
                  SKU
                </label>
                <select
                  id="skuId"
                  name="skuId"
                  className="form-input"
                  required
                >
                  <option value="">Select SKU...</option>
                  {skus.map((sku) => (
                    <option key={sku.id} value={sku.id}>
                      {sku.sku} | {sku.name}
                      {sku.category ? ` (${sku.category})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="quantity" className="form-label">
                  Quantity Completed
                </label>
                <input
                  type="number"
                  id="quantity"
                  name="quantity"
                  className="form-input"
                  min="1"
                  required
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Submitting..." : "Submit Task"}
              </button>
            </Form>
          </div>
        </div>

        {/* Assigned tasks (notes) */}
        {assignedTasks.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Assigned Tasks (Notes)</h2>
            </div>
            <div className="card-body">
              <p className="text-sm text-gray-600 mb-4">
                These are your assigned tasks for reference. They won't be
                automatically marked complete.
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

      {/* Today's submitted tasks */}
      {timeEntry && timeEntry.lines.length > 0 && (
        <div className="card mt-6">
          <div className="card-header">
            <h2 className="card-title">Tasks Submitted Today</h2>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              {timeEntry.lines.map((line) => (
                <div
                  key={line.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="flex-1">
                    <p className="font-medium">
                      {line.processName.replace(/_/g, " ")}
                    </p>
                    {line.sku && (
                      <p className="text-sm text-gray-600">
                        {line.sku.sku} | {line.sku.name}
                      </p>
                    )}
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
