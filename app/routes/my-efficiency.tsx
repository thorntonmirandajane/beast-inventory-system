import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  getWorkerEfficiencyStats,
  getAllProcessConfigs,
} from "../utils/productivity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get efficiency stats for different periods
  const stats30Days = await getWorkerEfficiencyStats(user.id, 30);
  const stats7Days = await getWorkerEfficiencyStats(user.id, 7);

  // Get all time entries for this user (approved)
  const allEntries = await prisma.workerTimeEntry.findMany({
    where: {
      userId: user.id,
      status: "APPROVED",
    },
    include: {
      lines: {
        include: {
          sku: {
            select: { sku: true, name: true },
          },
        },
      },
    },
    orderBy: { clockInTime: "desc" },
    take: 50,
  });

  // Get any rejected or pending entries
  const pendingEntries = await prisma.workerTimeEntry.findMany({
    where: {
      userId: user.id,
      status: { in: ["PENDING", "REJECTED"] },
    },
    include: {
      lines: true,
    },
    orderBy: { clockInTime: "desc" },
  });

  const processConfigs = await getAllProcessConfigs();

  return {
    user,
    stats30Days,
    stats7Days,
    allEntries,
    pendingEntries,
    processConfigs,
  };
};

export default function MyEfficiency() {
  const {
    user,
    stats30Days,
    stats7Days,
    allEntries,
    pendingEntries,
    processConfigs,
  } = useLoaderData<typeof loader>();

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString();
  };

  const formatMinutes = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${m}m`;
  };

  const getEfficiencyColor = (efficiency: number) => {
    if (efficiency >= 100) return "text-green-600";
    if (efficiency >= 80) return "text-yellow-600";
    return "text-red-600";
  };

  const getEfficiencyBg = (efficiency: number) => {
    if (efficiency >= 100) return "bg-green-100 text-green-700";
    if (efficiency >= 80) return "bg-yellow-100 text-yellow-700";
    return "bg-red-100 text-red-700";
  };

  const getProcessDisplay = (processName: string) => {
    return (
      processConfigs.find((p) => p.processName === processName)?.displayName ||
      processName
    );
  };

  return (
    <Layout user={user}>
      <div className="mb-6">
        <Link
          to="/worker-dashboard"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back to Dashboard
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title">My Efficiency</h1>
        <p className="page-subtitle">Track your productivity over time</p>
      </div>

      {/* Pending/Rejected Warning */}
      {pendingEntries.length > 0 && (
        <div className="alert alert-info mb-6">
          You have {pendingEntries.filter((e) => e.status === "PENDING").length}{" "}
          entry(ies) pending approval
          {pendingEntries.filter((e) => e.status === "REJECTED").length > 0 && (
            <span>
              {" "}
              and{" "}
              {pendingEntries.filter((e) => e.status === "REJECTED").length}{" "}
              rejected entry(ies)
            </span>
          )}
          .
        </div>
      )}

      {/* Overall Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="stat-card">
          <div
            className={`stat-value ${getEfficiencyColor(
              stats7Days.overallEfficiency
            )}`}
          >
            {stats7Days.overallEfficiency.toFixed(0)}%
          </div>
          <div className="stat-label">7-Day Efficiency</div>
        </div>
        <div className="stat-card">
          <div
            className={`stat-value ${getEfficiencyColor(
              stats30Days.overallEfficiency
            )}`}
          >
            {stats30Days.overallEfficiency.toFixed(0)}%
          </div>
          <div className="stat-label">30-Day Efficiency</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats30Days.totalEntries}</div>
          <div className="stat-label">Shifts (30 days)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {formatMinutes(stats30Days.totalActualMinutes)}
          </div>
          <div className="stat-label">Hours Worked (30 days)</div>
        </div>
      </div>

      {/* Efficiency by Process */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Efficiency by Process (30 Days)</h2>
        </div>
        <div className="card-body">
          {Object.keys(stats30Days.byProcess).length === 0 ? (
            <div className="text-center text-gray-500 py-4">
              No process data available yet
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(stats30Days.byProcess).map(([processName, data]) => (
                <div key={processName} className="p-4 bg-gray-50 rounded border">
                  <div className="font-semibold">
                    {getProcessDisplay(processName)}
                  </div>
                  <div className="text-2xl font-bold text-beast-600 mt-1">
                    {data.totalQuantity.toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-500">units completed</div>
                  <div className="text-sm text-gray-500 mt-1">
                    {formatMinutes(data.totalExpectedMinutes)} expected
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rejected Entries */}
      {pendingEntries.filter((e) => e.status === "REJECTED").length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title text-red-600">Rejected Entries</h2>
          </div>
          <div className="card-body">
            <div className="space-y-3">
              {pendingEntries
                .filter((e) => e.status === "REJECTED")
                .map((entry) => (
                  <div
                    key={entry.id}
                    className="p-3 bg-red-50 rounded border border-red-200"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-medium">
                          {formatDate(entry.clockInTime)}
                        </div>
                        <div className="text-sm text-gray-600">
                          {formatMinutes(entry.actualMinutes || 0)} worked
                        </div>
                      </div>
                      <span className="badge bg-red-200 text-red-700">
                        REJECTED
                      </span>
                    </div>
                    {entry.rejectionReason && (
                      <div className="mt-2 text-sm text-red-700 bg-red-100 p-2 rounded">
                        <strong>Reason:</strong> {entry.rejectionReason}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Recent Entries */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Approved Entries</h2>
        </div>
        {allEntries.length === 0 ? (
          <div className="card-body">
            <div className="text-center text-gray-500 py-8">
              No approved entries yet. Complete a shift and get it approved to
              see your efficiency here.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Hours Worked</th>
                  <th>Expected Time</th>
                  <th>Efficiency</th>
                  <th>Processes</th>
                </tr>
              </thead>
              <tbody>
                {allEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.clockInTime)}</td>
                    <td>{formatMinutes(entry.actualMinutes || 0)}</td>
                    <td>{formatMinutes(entry.expectedMinutes || 0)}</td>
                    <td>
                      <span
                        className={`badge ${getEfficiencyBg(
                          entry.efficiency || 0
                        )}`}
                      >
                        {entry.efficiency?.toFixed(0) || 0}%
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {entry.lines.map((line) => (
                          <span
                            key={line.id}
                            className="badge bg-gray-100 text-gray-700 text-xs"
                            title={`${line.quantityCompleted} units`}
                          >
                            {getProcessDisplay(line.processName)}:{" "}
                            {line.quantityCompleted}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Efficiency Guide */}
      <div className="card mt-6">
        <div className="card-header">
          <h2 className="card-title">Understanding Efficiency</h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="p-3 bg-green-50 rounded border border-green-200">
              <div className="font-semibold text-green-700">100%+ Efficiency</div>
              <p className="text-green-600 mt-1">
                You completed more work than expected for the time spent. Great
                job!
              </p>
            </div>
            <div className="p-3 bg-yellow-50 rounded border border-yellow-200">
              <div className="font-semibold text-yellow-700">80-99% Efficiency</div>
              <p className="text-yellow-600 mt-1">
                You're close to the target pace. Room for improvement but solid
                work.
              </p>
            </div>
            <div className="p-3 bg-red-50 rounded border border-red-200">
              <div className="font-semibold text-red-700">&lt;80% Efficiency</div>
              <p className="text-red-600 mt-1">
                Below target pace. Consider if there were obstacles or if
                training could help.
              </p>
            </div>
          </div>
          <p className="text-gray-500 mt-4 text-sm">
            Efficiency = (Expected Time / Actual Time) × 100%. Expected time is
            calculated from the standard process times multiplied by the
            quantity you completed.
          </p>
        </div>
      </div>
    </Layout>
  );
}
