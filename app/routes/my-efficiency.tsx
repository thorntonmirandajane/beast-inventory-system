import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, redirect } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { getWorkerEfficiencyStats } from "../utils/productivity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Only workers can access this page
  if (user.role !== "WORKER") {
    throw redirect("/");
  }

  // Get efficiency stats for last 30 days
  const efficiencyStats = await getWorkerEfficiencyStats(user.id, 30);

  // Get efficiency stats for last 7 days
  const weekStats = await getWorkerEfficiencyStats(user.id, 7);

  return { user, efficiencyStats, weekStats };
};

export default function MyEfficiency() {
  const { user, efficiencyStats, weekStats } = useLoaderData<typeof loader>();

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString();
  };

  const formatTime = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${hours}h ${mins}m`;
  };

  const getEfficiencyColor = (efficiency: number) => {
    if (efficiency >= 100) return "text-green-600";
    if (efficiency >= 80) return "text-yellow-600";
    return "text-red-600";
  };

  const getEfficiencyBadge = (efficiency: number) => {
    if (efficiency >= 100) return "bg-green-100 text-green-800";
    if (efficiency >= 80) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">My Efficiency</h1>
        <p className="page-subtitle">Track your productivity performance</p>
      </div>

      {/* Summary Cards */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-label">30-Day Efficiency</div>
          <div className={`stat-value ${getEfficiencyColor(efficiencyStats.overallEfficiency)}`}>
            {efficiencyStats.overallEfficiency > 0
              ? `${efficiencyStats.overallEfficiency.toFixed(0)}%`
              : "N/A"}
          </div>
          <div className="text-sm text-gray-500 mt-2">
            Based on {efficiencyStats.totalEntries} shifts
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">7-Day Efficiency</div>
          <div className={`stat-value ${getEfficiencyColor(weekStats.overallEfficiency)}`}>
            {weekStats.overallEfficiency > 0
              ? `${weekStats.overallEfficiency.toFixed(0)}%`
              : "N/A"}
          </div>
          <div className="text-sm text-gray-500 mt-2">
            Based on {weekStats.totalEntries} shifts
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Total Time Worked</div>
          <div className="stat-value text-blue-600">
            {formatTime(efficiencyStats.totalActualMinutes)}
          </div>
          <div className="text-sm text-gray-500 mt-2">Last 30 days</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Expected Time</div>
          <div className="stat-value text-purple-600">
            {formatTime(efficiencyStats.totalExpectedMinutes)}
          </div>
          <div className="text-sm text-gray-500 mt-2">Based on process times</div>
        </div>
      </div>

      {/* Efficiency by Process */}
      {Object.keys(efficiencyStats.byProcess).length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Efficiency by Process</h2>
            <p className="text-sm text-gray-500">Last 30 days</p>
          </div>
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Process</th>
                    <th className="text-right">Total Completed</th>
                    <th className="text-right">Expected Time</th>
                    <th className="text-right">Avg per Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(efficiencyStats.byProcess)
                    .sort(([, a], [, b]) => b.totalQuantity - a.totalQuantity)
                    .map(([processName, stats]) => {
                      const avgSecondsPerUnit =
                        stats.totalQuantity > 0
                          ? (stats.totalExpectedMinutes * 60) / stats.totalQuantity
                          : 0;
                      return (
                        <tr key={processName}>
                          <td className="font-medium">
                            {processName.replace(/_/g, " ")}
                          </td>
                          <td className="text-right font-semibold">
                            {stats.totalQuantity.toLocaleString()} units
                          </td>
                          <td className="text-right">
                            {formatTime(stats.totalExpectedMinutes)}
                          </td>
                          <td className="text-right text-sm text-gray-600">
                            {avgSecondsPerUnit.toFixed(0)}s/unit
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Recent Shifts */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Shifts</h2>
          <p className="text-sm text-gray-500">Last 30 days</p>
        </div>
        <div className="card-body">
          {efficiencyStats.entries.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              <p>No approved time entries yet</p>
              <p className="text-sm mt-2">Your efficiency will appear here once your shifts are approved</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th className="text-right">Hours Worked</th>
                    <th className="text-right">Expected Time</th>
                    <th className="text-right">Efficiency</th>
                    <th className="text-right">Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {efficiencyStats.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="text-sm">
                        {formatDate(entry.clockInTime)}
                      </td>
                      <td className="text-sm">
                        {new Date(entry.clockInTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="text-sm">
                        {entry.clockOutTime
                          ? new Date(entry.clockOutTime).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </td>
                      <td className="text-right font-medium">
                        {entry.actualMinutes ? formatTime(entry.actualMinutes) : "—"}
                      </td>
                      <td className="text-right">
                        {entry.expectedMinutes
                          ? formatTime(entry.expectedMinutes)
                          : "—"}
                      </td>
                      <td className="text-right">
                        <span
                          className={`badge ${getEfficiencyBadge(entry.efficiency || 0)}`}
                        >
                          {entry.efficiency ? `${entry.efficiency.toFixed(0)}%` : "—"}
                        </span>
                      </td>
                      <td className="text-right text-sm text-gray-600">
                        {entry.lines.length} tasks
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Understanding Efficiency */}
      <div className="card mt-6 bg-blue-50">
        <div className="card-header">
          <h2 className="card-title text-blue-900">Understanding Your Efficiency</h2>
        </div>
        <div className="card-body">
          <div className="space-y-3 text-sm text-blue-900">
            <p>
              <strong>How is efficiency calculated?</strong> Your efficiency is calculated by
              comparing the expected time for tasks (based on process times) with your actual
              time worked.
            </p>
            <p>
              <strong>Efficiency = (Expected Time / Actual Time) × 100</strong>
            </p>
            <ul className="list-disc list-inside space-y-1 ml-4">
              <li>
                <strong className="text-green-700">100% or above:</strong> Excellent! You're
                meeting or exceeding expectations
              </li>
              <li>
                <strong className="text-yellow-700">80-99%:</strong> Good performance, room for
                improvement
              </li>
              <li>
                <strong className="text-red-700">Below 80%:</strong> Consider ways to improve
                workflow
              </li>
            </ul>
            <p className="mt-3 text-xs text-blue-700">
              Note: Efficiency is only calculated after your time entries are approved by
              management.
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
