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

  if (!isClockedIn) {
    return redirect("/time-clock");
  }

  // Get today's time entry with all submitted tasks
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

  let timeEntry = null;
  if (clockInEvent) {
    timeEntry = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockInEvent.id },
      include: {
        lines: {
          include: { sku: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  }

  // Calculate hours worked today
  const todayEvents = await prisma.clockEvent.findMany({
    where: {
      userId: user.id,
      timestamp: { gte: today },
    },
    orderBy: { timestamp: "asc" },
  });

  let totalMs = 0;
  let clockInTime: Date | null = null;

  for (const event of todayEvents) {
    if (event.type === "CLOCK_IN") {
      clockInTime = event.timestamp;
    } else if (event.type === "CLOCK_OUT") {
      if (clockInTime) {
        totalMs += event.timestamp.getTime() - clockInTime.getTime();
        clockInTime = null;
      }
    } else if (event.type === "BREAK_START") {
      if (clockInTime) {
        totalMs += event.timestamp.getTime() - clockInTime.getTime();
      }
      clockInTime = null;
    } else if (event.type === "BREAK_END") {
      clockInTime = event.timestamp;
    }
  }

  // Add time from last clock in to now
  if (clockInTime) {
    totalMs += Date.now() - clockInTime.getTime();
  }

  const hoursWorked = totalMs / (1000 * 60 * 60);

  // Check for incomplete assigned tasks
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const incompleteTasks = await prisma.workerTask.findMany({
    where: {
      userId: user.id,
      status: "PENDING",
      assignmentType: "DAILY",
      dueDate: {
        gte: today,
        lt: tomorrow,
      },
    },
    include: { sku: true },
    orderBy: { priority: "desc" },
  });

  return {
    user,
    timeEntry,
    clockInTime: clockInEvent?.timestamp,
    hoursWorked,
    incompleteTasks
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const confirmed = formData.get("confirmed");

  if (confirmed !== "true") {
    return { error: "Please confirm your tasks before clocking out" };
  }

  // Check if user is clocked in
  const lastEvent = await prisma.clockEvent.findFirst({
    where: { userId: user.id },
    orderBy: { timestamp: "desc" },
  });

  const isClockedIn =
    lastEvent?.type === "CLOCK_IN" || lastEvent?.type === "BREAK_END";

  if (!isClockedIn) {
    return { error: "You are not clocked in" };
  }

  // Create clock-out event
  const event = await prisma.clockEvent.create({
    data: {
      userId: user.id,
      type: "CLOCK_OUT",
    },
  });

  await createAuditLog(user.id, "CLOCK_OUT", "ClockEvent", event.id, {});

  // Update time entry status to PENDING (submitted for approval)
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

  if (clockInEvent) {
    const timeEntry = await prisma.workerTimeEntry.findUnique({
      where: { clockInEventId: clockInEvent.id },
    });

    if (timeEntry) {
      // Calculate actual minutes worked
      const actualMinutes = Math.round(
        (event.timestamp.getTime() - clockInEvent.timestamp.getTime()) / (1000 * 60)
      );

      await prisma.workerTimeEntry.update({
        where: { id: timeEntry.id },
        data: {
          clockOutEventId: event.id,
          clockOutTime: event.timestamp,
          actualMinutes,
          status: "PENDING",
        },
      });

      // Redirect to work summary
      return redirect(`/worker-work-summary?entryId=${timeEntry.id}`);
    }
  }

  // If no time entry, just go to time clock
  return redirect("/time-clock");
};

export default function WorkerClockOutConfirm() {
  const { user, timeEntry, clockInTime, hoursWorked, incompleteTasks } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

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

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Confirm Clock Out</h1>
        <p className="page-subtitle">Review your tasks before clocking out</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Shift summary */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Shift Summary</h2>
          </div>
          <div className="card-body">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Clock In:</span>
                <span className="font-medium">
                  {clockInTime ? formatTime(clockInTime) : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Total Hours:</span>
                <span className="font-medium text-green-600">
                  {formatHours(hoursWorked)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Tasks Submitted:</span>
                <span className="font-medium">
                  {timeEntry?.lines.length || 0}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tasks submitted */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Tasks Completed Today</h2>
        </div>
        <div className="card-body">
          {!timeEntry || timeEntry.lines.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No tasks submitted today.</p>
              <p className="text-sm mt-2">
                If you completed work, please go back and submit your tasks.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {timeEntry.lines.map((line, index) => (
                <div
                  key={line.id}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-600 rounded-full font-semibold">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium">
                        {line.processName.replace(/_/g, " ")}
                      </p>
                      {line.sku && (
                        <p className="text-sm text-gray-600">
                          {line.sku.sku} | {line.sku.name}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold">
                      {line.quantityCompleted}
                    </p>
                    <p className="text-xs text-gray-500">units</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Incomplete tasks warning */}
      {incompleteTasks.length > 0 && (
        <div className="card mb-6 border-yellow-500">
          <div className="card-header bg-yellow-50">
            <h2 className="card-title text-yellow-800">⚠️ Incomplete Assigned Tasks</h2>
          </div>
          <div className="card-body">
            <p className="text-sm text-gray-700 mb-4">
              You have {incompleteTasks.length} assigned task{incompleteTasks.length > 1 ? 's' : ''} for today that {incompleteTasks.length > 1 ? 'are' : 'is'} still pending:
            </p>
            <div className="space-y-2">
              {incompleteTasks.map((task) => (
                <div
                  key={task.id}
                  className="p-3 bg-white border border-yellow-300 rounded-lg"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium text-gray-900">
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
                    </div>
                    {task.priority > 0 && (
                      <span className="badge badge-error">High Priority</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation form */}
      <div className="card">
        <div className="card-body">
          <Form method="post">
            {incompleteTasks.length > 0 && (
              <div className="alert alert-warning mb-6">
                <p className="font-medium">You have incomplete assigned tasks.</p>
                <p className="text-sm mt-1">
                  Please confirm you understand these tasks will remain incomplete for today.
                </p>
              </div>
            )}

            <div className="flex items-start gap-3 mb-6">
              <input
                type="checkbox"
                id="confirmed"
                name="confirmed"
                value="true"
                required
                className="mt-1"
              />
              <label htmlFor="confirmed" className="text-sm">
                {incompleteTasks.length > 0 ? (
                  <>I confirm that I cannot complete my assigned tasks today and that all work I did complete has been submitted accurately.</>
                ) : (
                  <>I confirm that all tasks I completed today have been submitted and the information above is accurate.</>
                )}
              </label>
            </div>

            <div className="flex gap-3">
              <a href="/worker-submit-task" className="btn btn-secondary flex-1">
                Add More Tasks
              </a>
              <button
                type="submit"
                className="btn btn-primary flex-1"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Clocking Out..." : "Confirm & Clock Out"}
              </button>
            </div>
          </Form>
        </div>
      </div>
    </Layout>
  );
}
