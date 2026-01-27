import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  const url = new URL(request.url);
  const startDateParam = url.searchParams.get("startDate");
  const endDateParam = url.searchParams.get("endDate");

  // Default to last 30 days
  const endDate = endDateParam ? new Date(endDateParam) : new Date();
  endDate.setHours(23, 59, 59, 999);

  const startDate = startDateParam ? new Date(startDateParam) : new Date();
  if (!startDateParam) {
    startDate.setDate(startDate.getDate() - 30);
  }
  startDate.setHours(0, 0, 0, 0);

  // Get all workers
  const workers = await prisma.user.findMany({
    where: {
      role: "WORKER",
      isActive: true,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Get approved time entries in the date range
  const timeEntries = await prisma.workerTimeEntry.findMany({
    where: {
      status: "APPROVED",
      clockOutTime: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      lines: {
        include: {
          sku: {
            select: {
              sku: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: { clockOutTime: "desc" },
  });

  // Calculate efficiency stats per worker
  const workerStats = workers.map((worker) => {
    const workerEntries = timeEntries.filter((e) => e.userId === worker.id);

    let totalActualMinutes = 0;
    let totalExpectedMinutes = 0;
    let totalShifts = workerEntries.length;
    const efficiencyScores: number[] = [];

    const processCounts: Record<string, number> = {};
    const skuCounts: Record<string, { sku: string; name: string; count: number }> = {};

    for (const entry of workerEntries) {
      if (entry.actualMinutes) totalActualMinutes += entry.actualMinutes;
      if (entry.expectedMinutes) totalExpectedMinutes += entry.expectedMinutes;
      if (entry.efficiency && entry.efficiency > 0) {
        efficiencyScores.push(entry.efficiency);
      }

      // Count processes and SKUs
      for (const line of entry.lines) {
        // Count by process
        if (!processCounts[line.processName]) {
          processCounts[line.processName] = 0;
        }
        processCounts[line.processName] += line.quantityCompleted;

        // Count by SKU
        if (line.skuId && line.sku) {
          if (!skuCounts[line.skuId]) {
            skuCounts[line.skuId] = {
              sku: line.sku.sku,
              name: line.sku.name,
              count: 0,
            };
          }
          skuCounts[line.skuId].count += line.quantityCompleted;
        }
      }
    }

    const avgEfficiency =
      efficiencyScores.length > 0
        ? efficiencyScores.reduce((sum, e) => sum + e, 0) / efficiencyScores.length
        : 0;

    const totalHours = totalActualMinutes / 60;
    const expectedHours = totalExpectedMinutes / 60;

    // Get top 3 processes and SKUs
    const topProcesses = Object.entries(processCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([process, count]) => ({ process, count }));

    const topSkus = Object.values(skuCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      workerId: worker.id,
      workerName: `${worker.firstName} ${worker.lastName}`,
      workerEmail: worker.email,
      totalShifts,
      totalHours: Math.round(totalHours * 10) / 10,
      expectedHours: Math.round(expectedHours * 10) / 10,
      avgEfficiency: Math.round(avgEfficiency * 10) / 10,
      topProcesses,
      topSkus,
    };
  });

  // Sort by total hours descending
  workerStats.sort((a, b) => b.totalHours - a.totalHours);

  // Calculate summary stats
  const totalHours = workerStats.reduce((sum, w) => sum + w.totalHours, 0);
  const totalShifts = workerStats.reduce((sum, w) => sum + w.totalShifts, 0);
  const avgEfficiencyAll =
    workerStats.length > 0
      ? workerStats.reduce((sum, w) => sum + w.avgEfficiency, 0) / workerStats.length
      : 0;

  return {
    user,
    workerStats,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    summary: {
      totalWorkers: workerStats.filter((w) => w.totalShifts > 0).length,
      totalHours: Math.round(totalHours * 10) / 10,
      totalShifts,
      avgEfficiency: Math.round(avgEfficiencyAll * 10) / 10,
    },
  };
};

export default function WorkerEfficiency() {
  const { user, workerStats, startDate, endDate, summary } = useLoaderData<typeof loader>();

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Worker Efficiency</h1>
        <p className="page-subtitle">View worker productivity metrics by date range</p>
      </div>

      {/* Date Range Filter */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Date Range</h2>
        </div>
        <div className="card-body">
          <Form method="get" className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="form-group mb-0">
              <label className="form-label">Start Date</label>
              <input
                type="date"
                name="startDate"
                className="form-input"
                defaultValue={startDate}
              />
            </div>
            <div className="form-group mb-0">
              <label className="form-label">End Date</label>
              <input type="date" name="endDate" className="form-input" defaultValue={endDate} />
            </div>
            <button type="submit" className="btn btn-primary">
              Update Range
            </button>
          </Form>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{summary.totalWorkers}</div>
          <div className="stat-label">Active Workers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary.totalShifts}</div>
          <div className="stat-label">Total Shifts</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary.totalHours}h</div>
          <div className="stat-label">Total Hours Worked</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: getEfficiencyColor(summary.avgEfficiency) }}>
            {summary.avgEfficiency}%
          </div>
          <div className="stat-label">Average Efficiency</div>
        </div>
      </div>

      {/* Worker Efficiency Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Worker Details</h2>
          <p className="text-sm text-gray-500">Individual worker performance metrics</p>
        </div>
        <div className="card-body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th className="text-center">Shifts</th>
                <th className="text-right">Hours Worked</th>
                <th className="text-right">Expected Hours</th>
                <th className="text-center">Avg Efficiency</th>
                <th>Top Processes</th>
                <th>Top SKUs</th>
              </tr>
            </thead>
            <tbody>
              {workerStats.map((stat) => (
                <tr key={stat.workerId}>
                  <td>
                    <div className="font-semibold">{stat.workerName}</div>
                    <div className="text-sm text-gray-500">{stat.workerEmail}</div>
                  </td>
                  <td className="text-center">{stat.totalShifts}</td>
                  <td className="text-right font-semibold">{stat.totalHours}h</td>
                  <td className="text-right text-gray-600">{stat.expectedHours}h</td>
                  <td className="text-center">
                    {stat.avgEfficiency > 0 ? (
                      <span
                        className="font-bold text-lg"
                        style={{ color: getEfficiencyColor(stat.avgEfficiency) }}
                      >
                        {stat.avgEfficiency}%
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td>
                    {stat.topProcesses.length > 0 ? (
                      <div className="text-sm space-y-1">
                        {stat.topProcesses.map((p, idx) => (
                          <div key={idx}>
                            <span className="font-medium">{p.process}:</span>{" "}
                            <span className="text-gray-600">{p.count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td>
                    {stat.topSkus.length > 0 ? (
                      <div className="text-sm space-y-1">
                        {stat.topSkus.map((s, idx) => (
                          <div key={idx}>
                            <span className="font-mono text-xs">{s.sku}:</span>{" "}
                            <span className="text-gray-600">{s.count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {workerStats.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-500 py-8">
                    No worker data found for the selected date range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function getEfficiencyColor(efficiency: number): string {
  if (efficiency >= 100) return "#10b981"; // green
  if (efficiency >= 80) return "#f59e0b"; // orange
  return "#ef4444"; // red
}
