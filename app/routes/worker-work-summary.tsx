import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, redirect } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    throw redirect("/");
  }

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");

  if (!entryId) {
    throw redirect("/worker-dashboard");
  }

  const timeEntry = await prisma.workerTimeEntry.findUnique({
    where: { id: entryId },
    include: {
      lines: {
        include: { sku: true },
      },
      clockInEvent: true,
      clockOutEvent: true,
    },
  });

  if (!timeEntry || timeEntry.userId !== user.id) {
    throw redirect("/worker-dashboard");
  }

  // Calculate break time
  const clockInTime = timeEntry.clockInEvent.timestamp;
  const clockOutTime = timeEntry.clockOutEvent?.timestamp || new Date();

  const breakEvents = await prisma.clockEvent.findMany({
    where: {
      userId: user.id,
      timestamp: {
        gte: clockInTime,
        lte: clockOutTime,
      },
      type: {
        in: ["BREAK_START", "BREAK_END"],
      },
    },
    orderBy: { timestamp: "asc" },
  });

  let breakMinutes = 0;
  let breakStartTime: Date | null = null;

  for (const event of breakEvents) {
    if (event.type === "BREAK_START") {
      breakStartTime = event.timestamp;
    } else if (event.type === "BREAK_END" && breakStartTime) {
      breakMinutes += (event.timestamp.getTime() - breakStartTime.getTime()) / (1000 * 60);
      breakStartTime = null;
    }
  }

  // Calculate total hours
  const totalMinutes = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60);
  const workMinutes = totalMinutes - breakMinutes;
  const hoursWorked = workMinutes / 60;

  // Calculate expected time from tasks
  const expectedSeconds = timeEntry.lines.reduce((sum, line) => sum + line.expectedSeconds, 0);
  const expectedHours = expectedSeconds / 3600;

  // Calculate efficiency
  const efficiency = expectedHours > 0 ? Math.round((expectedHours / hoursWorked) * 100) : 0;

  return {
    user,
    timeEntry,
    clockInTime,
    clockOutTime,
    breakMinutes: Math.round(breakMinutes),
    hoursWorked,
    expectedHours,
    efficiency,
  };
};

export default function WorkerWorkSummary() {
  const { user, timeEntry, clockInTime, clockOutTime, breakMinutes, hoursWorked, expectedHours, efficiency } =
    useLoaderData<typeof loader>();

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

  const getEfficiencyColor = (eff: number) => {
    if (eff >= 90) return "text-green-600";
    if (eff >= 70) return "text-blue-600";
    if (eff >= 50) return "text-yellow-600";
    return "text-red-600";
  };

  const getEfficiencyBadge = (eff: number) => {
    if (eff >= 90) return "badge-success";
    if (eff >= 70) return "badge-secondary";
    if (eff >= 50) return "badge-warning";
    return "badge-error";
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <div className="flex items-center gap-3">
          <span className="text-4xl">✅</span>
          <div>
            <h1 className="page-title">Shift Complete!</h1>
            <p className="page-subtitle">Thank you for your hard work today</p>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="card">
          <div className="card-body text-center">
            <div className="text-sm text-gray-500 mb-1">Clock In</div>
            <div className="text-2xl font-bold text-gray-900">
              {formatTime(clockInTime)}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body text-center">
            <div className="text-sm text-gray-500 mb-1">Clock Out</div>
            <div className="text-2xl font-bold text-gray-900">
              {formatTime(clockOutTime)}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body text-center">
            <div className="text-sm text-gray-500 mb-1">Hours Worked</div>
            <div className="text-2xl font-bold text-green-600">
              {formatHours(hoursWorked)}
            </div>
          </div>
        </div>
      </div>

      {/* Shift Details */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Shift Details</h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <div className="text-sm text-gray-500 mb-1">Break Time</div>
              <div className="text-lg font-semibold">{breakMinutes} min</div>
            </div>
            <div>
              <div className="text-sm text-gray-500 mb-1">Tasks Submitted</div>
              <div className="text-lg font-semibold">{timeEntry.lines.length}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500 mb-1">Expected Time</div>
              <div className="text-lg font-semibold">{formatHours(expectedHours)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500 mb-1">Efficiency</div>
              <div className={`text-lg font-semibold ${getEfficiencyColor(efficiency)}`}>
                {efficiency}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Efficiency Preview */}
      <div className="card mb-6">
        <div className="card-body">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Your Efficiency</h3>
            <span className={`badge ${getEfficiencyBadge(efficiency)}`}>
              {efficiency}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-4 mb-3">
            <div
              className={`h-4 rounded-full transition-all ${
                efficiency >= 90 ? "bg-green-500" :
                efficiency >= 70 ? "bg-blue-500" :
                efficiency >= 50 ? "bg-yellow-500" :
                "bg-red-500"
              }`}
              style={{ width: `${Math.min(efficiency, 100)}%` }}
            ></div>
          </div>
          <p className="text-sm text-gray-600">
            {efficiency >= 90 && "Excellent work! You exceeded expectations."}
            {efficiency >= 70 && efficiency < 90 && "Great job! You're performing well."}
            {efficiency >= 50 && efficiency < 70 && "Good effort. Keep working to improve your pace."}
            {efficiency < 50 && "Your pace is below target. Consider discussing with your supervisor."}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            Efficiency = (Expected Time ÷ Actual Time) × 100
          </p>
        </div>
      </div>

      {/* Tasks Submitted */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Tasks Submitted</h2>
        </div>
        <div className="card-body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Process</th>
                <th>SKU</th>
                <th>Quantity</th>
                <th>Expected Time</th>
              </tr>
            </thead>
            <tbody>
              {timeEntry.lines.map((line) => (
                <tr key={line.id}>
                  <td className="font-medium">
                    {line.processName.replace(/_/g, " ")}
                  </td>
                  <td>
                    {line.isMisc ? (
                      <div>
                        <span className="badge badge-secondary">MISC</span>
                        <p className="text-xs text-gray-600 mt-1">{line.miscDescription}</p>
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
                  <td className="font-semibold">{line.quantityCompleted}</td>
                  <td className="text-sm text-gray-600">
                    {formatHours(line.expectedSeconds / 3600)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Next Steps */}
      <div className="card bg-blue-50 border-blue-200">
        <div className="card-body">
          <div className="flex items-start gap-3">
            <span className="text-2xl">ℹ️</span>
            <div className="flex-1">
              <h3 className="font-semibold text-blue-900 mb-2">
                Your time entry has been submitted for approval
              </h3>
              <p className="text-sm text-blue-800">
                An administrator will review your submitted tasks and approve your time entry.
                You can check the status in your dashboard.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex gap-4">
        <Link to="/worker-dashboard" className="btn btn-primary">
          Return to Dashboard
        </Link>
        <Link to="/time-clock" className="btn btn-secondary">
          View Time Clock
        </Link>
      </div>
    </Layout>
  );
}
