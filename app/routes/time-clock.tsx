import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, redirect, Link } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

type ClockEventType = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END";

interface ClockStatus {
  isClockedIn: boolean;
  isOnBreak: boolean;
  lastEvent: {
    type: ClockEventType;
    timestamp: Date;
  } | null;
  todayHours: number;
  weekHours: number;
}

async function getClockStatus(userId: string): Promise<ClockStatus> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

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

  // Get week's events
  const weekEvents = await prisma.clockEvent.findMany({
    where: {
      userId,
      timestamp: { gte: weekStart },
    },
    orderBy: { timestamp: "asc" },
  });

  // Calculate hours worked
  const calculateHours = (events: typeof todayEvents): number => {
    let totalMs = 0;
    let clockInTime: Date | null = null;
    let breakStartTime: Date | null = null;

    for (const event of events) {
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
          if (clockInTime) {
            totalMs += event.timestamp.getTime() - clockInTime.getTime();
          }
          breakStartTime = event.timestamp;
          break;
        case "BREAK_END":
          if (breakStartTime) {
            clockInTime = event.timestamp;
            breakStartTime = null;
          }
          break;
      }
    }

    // If still clocked in, add time until now
    if (clockInTime && !breakStartTime) {
      totalMs += Date.now() - clockInTime.getTime();
    }

    return totalMs / (1000 * 60 * 60); // Convert to hours
  };

  const isClockedIn =
    lastEvent?.type === "CLOCK_IN" || lastEvent?.type === "BREAK_END";
  const isOnBreak = lastEvent?.type === "BREAK_START";

  return {
    isClockedIn,
    isOnBreak,
    lastEvent: lastEvent
      ? { type: lastEvent.type as ClockEventType, timestamp: lastEvent.timestamp }
      : null,
    todayHours: calculateHours(todayEvents),
    weekHours: calculateHours(weekEvents),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const clockStatus = await getClockStatus(user.id);

  // Get recent clock events for current user
  const recentEvents = await prisma.clockEvent.findMany({
    where: { userId: user.id },
    orderBy: { timestamp: "desc" },
    take: 20,
  });

  // If admin, get all users' current status
  let allUsersStatus: Array<{
    user: { id: string; firstName: string; lastName: string };
    status: ClockStatus;
  }> = [];

  if (user.role === "ADMIN") {
    const allUsers = await prisma.user.findMany({
      where: { isActive: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });

    allUsersStatus = await Promise.all(
      allUsers.map(async (u) => ({
        user: { id: u.id, firstName: u.firstName, lastName: u.lastName },
        status: await getClockStatus(u.id),
      }))
    );
  }

  return { user, clockStatus, recentEvents, allUsersStatus };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const eventType = formData.get("eventType") as ClockEventType;

  const validTypes: ClockEventType[] = [
    "CLOCK_IN",
    "CLOCK_OUT",
    "BREAK_START",
    "BREAK_END",
  ];

  if (!validTypes.includes(eventType)) {
    return { error: "Invalid event type" };
  }

  // Validate the transition
  const currentStatus = await getClockStatus(user.id);

  if (eventType === "CLOCK_IN" && (currentStatus.isClockedIn || currentStatus.isOnBreak)) {
    return { error: "You are already clocked in" };
  }

  if (eventType === "CLOCK_OUT") {
    if (!currentStatus.isClockedIn) {
      return { error: "You are not clocked in" };
    }
    // For workers, redirect to confirmation page instead of directly clocking out
    if (user.role === "WORKER") {
      return redirect("/worker-clock-out-confirm");
    }
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

  // Check for late clock-in if this is a CLOCK_IN event
  if (eventType === "CLOCK_IN" && user.role === "WORKER") {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const todayDate = new Date(now);
    todayDate.setHours(12, 0, 0, 0); // Noon to avoid timezone issues

    // Get worker's schedule for today - check for date-specific first, then recurring
    let schedule = await prisma.workerSchedule.findFirst({
      where: {
        userId: user.id,
        scheduleType: "SPECIFIC_DATE",
        scheduleDate: todayDate,
        isActive: true,
      },
    });

    // If no date-specific schedule, check for recurring schedule
    if (!schedule) {
      schedule = await prisma.workerSchedule.findFirst({
        where: {
          userId: user.id,
          scheduleType: "RECURRING",
          dayOfWeek,
          isActive: true,
        },
      });
    }

    if (schedule) {
      // Parse scheduled start time
      const [schedHour, schedMin] = schedule.startTime.split(":").map(Number);
      const scheduledStart = new Date(now);
      scheduledStart.setHours(schedHour, schedMin, 0, 0);

      // Calculate minutes late
      const minutesLate = Math.floor((now.getTime() - scheduledStart.getTime()) / 1000 / 60);

      // If more than 10 minutes late, create notification
      if (minutesLate > 10) {
        await prisma.notification.create({
          data: {
            type: "LATE_CLOCK_IN",
            userId: user.id,
            message: `${user.firstName} ${user.lastName} clocked in ${minutesLate} minutes late (scheduled: ${schedule.startTime}, actual: ${currentTime})`,
            metadata: JSON.stringify({
              scheduledTime: schedule.startTime,
              actualTime: currentTime,
              minutesLate,
              clockEventId: event.id,
            }),
          },
        });
      }
    }
  }

  const messages: Record<ClockEventType, string> = {
    CLOCK_IN: "Clocked in successfully",
    CLOCK_OUT: "Clocked out successfully",
    BREAK_START: "Break started",
    BREAK_END: "Break ended",
  };

  // For workers: redirect to task view after clock-in
  if (user.role === "WORKER" && eventType === "CLOCK_IN") {
    return redirect("/worker-task-view?clockIn=true");
  }

  return { success: true, message: messages[eventType] };
};

export default function TimeClock() {
  const { user, clockStatus, recentEvents, allUsersStatus } =
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

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString();
  };

  const formatHours = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${m}m`;
  };

  const getEventLabel = (type: string) => {
    switch (type) {
      case "CLOCK_IN":
        return "Clocked In";
      case "CLOCK_OUT":
        return "Clocked Out";
      case "BREAK_START":
        return "Break Started";
      case "BREAK_END":
        return "Break Ended";
      default:
        return type;
    }
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case "CLOCK_IN":
        return "text-green-600 bg-green-100";
      case "CLOCK_OUT":
        return "text-red-600 bg-red-100";
      case "BREAK_START":
        return "text-yellow-600 bg-yellow-100";
      case "BREAK_END":
        return "text-blue-600 bg-blue-100";
      default:
        return "text-gray-600 bg-gray-100";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Time Clock</h1>
        <p className="page-subtitle">Track your work hours</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Current Status */}
      <div className="card mb-6">
        <div className="card-body">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            {/* Status Display */}
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
                  Last action: {getEventLabel(clockStatus.lastEvent.type)} at{" "}
                  {formatTime(clockStatus.lastEvent.timestamp)}
                </p>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap justify-center gap-3">
              {!clockStatus.isClockedIn && !clockStatus.isOnBreak && (
                <Form method="post">
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
                  {user.role === "WORKER" && (
                    <Link to="/worker-submit-task" className="btn btn-success btn-lg">
                      Submit Task
                    </Link>
                  )}
                  <Form method="post">
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

            {/* Hours Summary */}
            <div className="flex gap-6 justify-center">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {formatHours(clockStatus.todayHours)}
                </div>
                <div className="text-sm text-gray-500">Today</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {formatHours(clockStatus.weekHours)}
                </div>
                <div className="text-sm text-gray-500">This Week</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Admin View - All Users Status */}
      {allUsersStatus.length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Team Status</h2>
            <Link to="/admin-manual-time-entry" className="btn btn-sm btn-secondary">
              Add Manual Time Entry
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Status</th>
                <th>Last Action</th>
                <th>Today</th>
                <th>This Week</th>
              </tr>
            </thead>
            <tbody>
              {allUsersStatus.map(({ user: u, status }) => (
                <tr key={u.id}>
                  <td className="font-medium">
                    {u.firstName} {u.lastName}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        status.isOnBreak
                          ? "bg-yellow-100 text-yellow-800"
                          : status.isClockedIn
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {status.isOnBreak
                        ? "On Break"
                        : status.isClockedIn
                        ? "Clocked In"
                        : "Clocked Out"}
                    </span>
                  </td>
                  <td>
                    {status.lastEvent ? (
                      <span className="text-sm">
                        {getEventLabel(status.lastEvent.type)} at{" "}
                        {formatTime(status.lastEvent.timestamp)}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td>{formatHours(status.todayHours)}</td>
                  <td>{formatHours(status.weekHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Events */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Your Recent Activity</h2>
        </div>
        {recentEvents.length === 0 ? (
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
                  d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <h3 className="empty-state-title">No clock events yet</h3>
              <p className="empty-state-description">
                Clock in to start tracking your time.
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.timestamp)}</td>
                  <td>{formatTime(event.timestamp)}</td>
                  <td>
                    <span
                      className={`inline-block px-2 py-1 rounded text-sm font-medium ${getEventColor(
                        event.type
                      )}`}
                    >
                      {getEventLabel(event.type)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
