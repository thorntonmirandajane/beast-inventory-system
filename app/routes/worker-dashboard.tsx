import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
  Link,
  redirect,
} from "react-router";
import { useState } from "react";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  getWorkerTasks,
  getAllProcessConfigs,
  getOrCreateDraftTimeEntry,
  getWorkerEfficiencyStats,
} from "../utils/productivity.server";

type ClockEventType = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";

interface ClockStatus {
  isClockedIn: boolean;
  isOnBreak: boolean;
  lastClockIn: {
    id: string;
    timestamp: Date;
  } | null;
  lastEvent: {
    type: ClockEventType;
    timestamp: Date;
  } | null;
  todayHours: number;
  breakMinutes: number;
}

async function getClockStatus(userId: string): Promise<ClockStatus> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get last event
  const lastEvent = await prisma.clockEvent.findFirst({
    where: { userId },
    orderBy: { timestamp: "desc" },
  });

  // Get today's events
  const todayEvents = await prisma.clockEvent.findMany({
    where: {
      userId,
      timestamp: { gte: today },
    },
    orderBy: { timestamp: "asc" },
  });

  // Find last clock in
  let lastClockIn: { id: string; timestamp: Date } | null = null;
  for (let i = todayEvents.length - 1; i >= 0; i--) {
    if (todayEvents[i].type === "CLOCK_IN") {
      lastClockIn = { id: todayEvents[i].id, timestamp: todayEvents[i].timestamp };
      break;
    }
  }

  // Calculate hours worked and break time
  let totalMs = 0;
  let breakMs = 0;
  let clockInTime: Date | null = null;
  let breakStartTime: Date | null = null;

  for (const event of todayEvents) {
    switch (event.type) {
      case "CLOCK_IN":
        clockInTime = event.timestamp;
        break;
      case "CLOCK_OUT":
        if (clockInTime) {
          totalMs += event.timestamp.getTime() - clockInTime.getTime();
          clockInTime = null;
        }
        break;
      case "BREAK_START":
        breakStartTime = event.timestamp;
        break;
      case "BREAK_END":
        if (breakStartTime) {
          breakMs += event.timestamp.getTime() - breakStartTime.getTime();
          breakStartTime = null;
        }
        break;
    }
  }

  // If still clocked in, add time until now
  if (clockInTime && !breakStartTime) {
    totalMs += Date.now() - clockInTime.getTime();
  }

  // If currently on break, add break time until now
  if (breakStartTime) {
    breakMs += Date.now() - breakStartTime.getTime();
  }

  const isClockedIn =
    lastEvent?.type === "CLOCK_IN" || lastEvent?.type === "BREAK_END";
  const isOnBreak = lastEvent?.type === "BREAK_START";

  return {
    isClockedIn,
    isOnBreak,
    lastClockIn,
    lastEvent: lastEvent
      ? { type: lastEvent.type as ClockEventType, timestamp: lastEvent.timestamp }
      : null,
    todayHours: (totalMs - breakMs) / (1000 * 60 * 60),
    breakMinutes: Math.round(breakMs / (1000 * 60)),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Check for success message from task submission
  const url = new URL(request.url);
  const submitted = url.searchParams.get("submitted") === "true";

  const clockStatus = await getClockStatus(user.id);

  // Get worker's assigned tasks
  const tasks = await getWorkerTasks(user.id, true);

  // Separate daily vs backlog
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dailyTasks = tasks.filter(
    (t) =>
      t.assignmentType === "DAILY" &&
      t.dueDate &&
      new Date(t.dueDate) >= today &&
      new Date(t.dueDate) < tomorrow
  );

  const backlogTasks = tasks.filter((t) => t.assignmentType === "BACKLOG");

  // Get process configs for adding own tasks
  const processConfigs = await getAllProcessConfigs();

  // Get efficiency stats (last 30 days)
  const efficiencyStats = await getWorkerEfficiencyStats(user.id, 30);

  // Check if there's a draft time entry for current shift
  let currentTimeEntry = null;
  if (clockStatus.lastClockIn) {
    const existing = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockStatus.lastClockIn.id },
      include: { lines: true },
    });
    currentTimeEntry = existing;
  }

  // Get rejected tasks (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const rejectedLines = await prisma.timeEntryLine.findMany({
    where: {
      timeEntry: { userId: user.id },
      isRejected: true,
      createdAt: { gte: thirtyDaysAgo },
    },
    include: {
      sku: true,
      timeEntry: {
        select: {
          clockInTime: true,
          clockOutTime: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return {
    user,
    clockStatus,
    dailyTasks,
    backlogTasks,
    processConfigs,
    efficiencyStats,
    currentTimeEntry,
    rejectedLines,
    submitted,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "clock") {
    const eventType = formData.get("eventType") as ClockEventType;
    const currentStatus = await getClockStatus(user.id);

    // Validate transitions
    if (eventType === "CLOCK_IN" && (currentStatus.isClockedIn || currentStatus.isOnBreak)) {
      return { error: "You are already clocked in" };
    }
    if (eventType === "CLOCK_OUT" && !currentStatus.isClockedIn) {
      return { error: "You are not clocked in" };
    }
    if (eventType === "BREAK_START" && !currentStatus.isClockedIn) {
      return { error: "You must be clocked in to start a break" };
    }
    if (eventType === "BREAK_END" && !currentStatus.isOnBreak) {
      return { error: "You are not on a break" };
    }

    const event = await prisma.clockEvent.create({
      data: {
        userId: user.id,
        type: eventType,
      },
    });

    await createAuditLog(user.id, eventType, "ClockEvent", event.id, {});

    // If clocking in, create a draft time entry
    if (eventType === "CLOCK_IN") {
      await getOrCreateDraftTimeEntry(user.id, event.id, event.timestamp);
    }

    // If clocking out, redirect to the clock-out entry page
    if (eventType === "CLOCK_OUT") {
      // Find the clock-in event for this shift
      const status = await getClockStatus(user.id);
      if (status.lastClockIn) {
        return redirect(`/clock-out-entry?clockOut=${event.id}`);
      }
    }

    return { success: true };
  }

  if (intent === "add-task") {
    const processName = formData.get("processName") as string;
    const notes = formData.get("notes") as string;

    if (!processName) {
      return { error: "Process is required" };
    }

    await prisma.workerTask.create({
      data: {
        userId: user.id,
        processName,
        assignmentType: "BACKLOG",
        assignedById: user.id,
        notes: notes || null,
      },
    });

    return { success: true, message: "Task added to your backlog" };
  }

  return { error: "Invalid action" };
};

export default function WorkerDashboard() {
  const {
    user,
    clockStatus,
    dailyTasks,
    backlogTasks,
    processConfigs,
    efficiencyStats,
    currentTimeEntry,
    rejectedLines,
    submitted,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showAddTask, setShowAddTask] = useState(false);

  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatHours = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${m}m`;
  };

  const getEfficiencyColor = (efficiency: number) => {
    if (efficiency >= 100) return "text-green-600";
    if (efficiency >= 80) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">My Dashboard</h1>
        <p className="page-subtitle">
          {user.firstName} {user.lastName}
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && actionData.message && (
        <div className="alert alert-success">{actionData.message}</div>
      )}
      {submitted && (
        <div className="alert alert-success">
          Tasks submitted successfully! Your work has been recorded.
        </div>
      )}

      {/* Clock Status Card */}
      <div className="card mb-6">
        <div className="card-body">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            {/* Status */}
            <div className="text-center md:text-left">
              <div className="mb-2">
                <span
                  className={`inline-block px-4 py-2 rounded-full text-lg font-semibold ${
                    clockStatus.isOnBreak
                      ? "bg-yellow-100 text-yellow-800"
                      : clockStatus.isClockedIn
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {clockStatus.isOnBreak
                    ? "On Break"
                    : clockStatus.isClockedIn
                    ? "Clocked In"
                    : "Clocked Out"}
                </span>
              </div>
              {clockStatus.lastEvent && (
                <p className="text-sm text-gray-600">
                  Since {formatTime(clockStatus.lastEvent.timestamp)}
                </p>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap justify-center gap-3">
              {!clockStatus.isClockedIn && !clockStatus.isOnBreak && (
                <Form method="post">
                  <input type="hidden" name="intent" value="clock" />
                  <input type="hidden" name="eventType" value="CLOCK_IN" />
                  <button
                    type="submit"
                    className="btn btn-primary btn-lg"
                    disabled={isSubmitting}
                  >
                    Clock In
                  </button>
                </Form>
              )}

              {clockStatus.isClockedIn && !clockStatus.isOnBreak && (
                <>
                  <Form method="post">
                    <input type="hidden" name="intent" value="clock" />
                    <input type="hidden" name="eventType" value="BREAK_START" />
                    <button
                      type="submit"
                      className="btn btn-secondary btn-lg"
                      disabled={isSubmitting}
                    >
                      Start Break
                    </button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="clock" />
                    <input type="hidden" name="eventType" value="CLOCK_OUT" />
                    <button
                      type="submit"
                      className="btn btn-danger btn-lg"
                      disabled={isSubmitting}
                    >
                      Clock Out
                    </button>
                  </Form>
                </>
              )}

              {clockStatus.isOnBreak && (
                <Form method="post">
                  <input type="hidden" name="intent" value="clock" />
                  <input type="hidden" name="eventType" value="BREAK_END" />
                  <button
                    type="submit"
                    className="btn btn-primary btn-lg"
                    disabled={isSubmitting}
                  >
                    End Break
                  </button>
                </Form>
              )}
            </div>

            {/* Hours */}
            <div className="flex gap-6 justify-center">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {formatHours(clockStatus.todayHours)}
                </div>
                <div className="text-sm text-gray-500">Worked Today</div>
              </div>
              {efficiencyStats.overallEfficiency > 0 && (
                <div className="text-center">
                  <div
                    className={`text-2xl font-bold ${getEfficiencyColor(
                      efficiencyStats.overallEfficiency
                    )}`}
                  >
                    {efficiencyStats.overallEfficiency.toFixed(0)}%
                  </div>
                  <div className="text-sm text-gray-500">30-Day Efficiency</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's Tasks */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <div>
              <h2 className="card-title">Today's Tasks</h2>
              <p className="text-sm text-gray-500">
                {dailyTasks.length} task{dailyTasks.length !== 1 ? "s" : ""} assigned
              </p>
            </div>
          </div>
          <div className="card-body">
            {dailyTasks.length === 0 ? (
              <div className="text-center text-gray-500 py-4">
                No tasks assigned for today
              </div>
            ) : (
              <div className="space-y-3">
                {dailyTasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-3 rounded border bg-blue-50 border-blue-200"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">
                            {processConfigs.find(
                              (p) => p.processName === task.processName
                            )?.displayName || task.processName}
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
                          <div className="text-sm text-gray-600 font-mono">
                            {task.sku.sku}
                          </div>
                        )}
                        {task.targetQuantity && (
                          <div className="text-sm text-gray-500">
                            Target: {task.targetQuantity.toLocaleString()} units
                          </div>
                        )}
                        {task.notes && (
                          <div className="text-sm text-gray-500 mt-1">
                            {task.notes}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Backlog */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <div>
              <h2 className="card-title">Backlog</h2>
              <p className="text-sm text-gray-500">
                {backlogTasks.length} task{backlogTasks.length !== 1 ? "s" : ""} in queue
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddTask(!showAddTask)}
              className="btn btn-sm btn-secondary"
            >
              {showAddTask ? "Cancel" : "+ Add Task"}
            </button>
          </div>
          <div className="card-body">
            {showAddTask && (
              <Form method="post" className="mb-4 p-3 bg-gray-50 rounded border">
                <input type="hidden" name="intent" value="add-task" />
                <div className="form-group mb-3">
                  <label className="form-label">Process</label>
                  <select name="processName" className="form-select" required>
                    <option value="">Select...</option>
                    {processConfigs.map((config) => (
                      <option key={config.processName} value={config.processName}>
                        {config.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group mb-3">
                  <label className="form-label">Notes (optional)</label>
                  <input
                    type="text"
                    name="notes"
                    className="form-input"
                    placeholder="Any notes..."
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={isSubmitting}
                >
                  Add to Backlog
                </button>
              </Form>
            )}

            {backlogTasks.length === 0 && !showAddTask ? (
              <div className="text-center text-gray-500 py-4">
                No backlog tasks
              </div>
            ) : (
              <div className="space-y-2">
                {backlogTasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-2 rounded border bg-gray-50 border-gray-200"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">
                          {processConfigs.find(
                            (p) => p.processName === task.processName
                          )?.displayName || task.processName}
                        </span>
                        {task.notes && (
                          <div className="text-xs text-gray-500">{task.notes}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rejected Tasks */}
      {rejectedLines.length > 0 && (
        <div className="card mt-6 border-red-500">
          <div className="card-header bg-red-50">
            <h2 className="card-title text-red-800">⚠️ Rejected Tasks</h2>
          </div>
          <div className="card-body">
            <p className="text-sm text-gray-700 mb-4">
              The following tasks were rejected during quality control. Please review the feedback.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Process</th>
                  <th>SKU</th>
                  <th>Rejected Qty</th>
                  <th>Reason</th>
                  <th>Admin Notes</th>
                </tr>
              </thead>
              <tbody>
                {rejectedLines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {line.timeEntry.clockOutTime
                        ? new Date(line.timeEntry.clockOutTime).toLocaleDateString()
                        : new Date(line.timeEntry.clockInTime).toLocaleDateString()}
                    </td>
                    <td className="font-medium">
                      {line.processName.replace(/_/g, " ")}
                    </td>
                    <td>
                      {line.isMisc ? (
                        <div>
                          <span className="badge badge-secondary">MISC</span>
                          <p className="text-xs text-gray-600 mt-1">
                            {line.miscDescription}
                          </p>
                        </div>
                      ) : line.sku ? (
                        <div>
                          <div className="font-mono text-sm">{line.sku.sku}</div>
                          <div className="text-xs text-gray-500">{line.sku.name}</div>
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="text-red-600 font-bold">
                      {line.rejectionQuantity || line.quantityCompleted}
                    </td>
                    <td>
                      <div className="text-sm">
                        {line.rejectionReason || <span className="text-gray-400">—</span>}
                      </div>
                    </td>
                    <td>
                      <div className="text-sm text-gray-600">
                        {line.adminNotes || <span className="text-gray-400">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick Links */}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/my-efficiency" className="btn btn-secondary">
          View My Efficiency History
        </Link>
        <Link to="/time-clock" className="btn btn-secondary">
          View Time Clock Details
        </Link>
      </div>
    </Layout>
  );
}
