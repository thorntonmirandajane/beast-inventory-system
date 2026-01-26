import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, redirect } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { getAllBuildEligibility } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Redirect workers to time clock instead of inventory dashboard
  if (user.role === "WORKER") {
    throw redirect("/time-clock");
  }

  // Get counts
  const [
    totalSkus,
    rawSkus,
    assemblySkus,
    completedSkus,
    pendingReceiving,
    recentTransfers,
  ] = await Promise.all([
    prisma.sku.count({ where: { isActive: true } }),
    prisma.sku.count({ where: { isActive: true, type: "RAW" } }),
    prisma.sku.count({ where: { isActive: true, type: "ASSEMBLY" } }),
    prisma.sku.count({ where: { isActive: true, type: "COMPLETED" } }),
    prisma.receivingRecord.count({ where: { status: "PENDING" } }),
    prisma.transfer.count({
      where: {
        shippedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  // Get inventory totals by state
  const inventoryByState = await prisma.inventoryItem.groupBy({
    by: ["state"],
    _sum: { quantity: true },
  });

  const inventoryStats = {
    received: inventoryByState.find((i) => i.state === "RECEIVED")?._sum.quantity || 0,
    raw: inventoryByState.find((i) => i.state === "RAW")?._sum.quantity || 0,
    assembled: inventoryByState.find((i) => i.state === "ASSEMBLED")?._sum.quantity || 0,
    completed: inventoryByState.find((i) => i.state === "COMPLETED")?._sum.quantity || 0,
  };

  // Get top buildable items
  const buildEligibility = await getAllBuildEligibility();
  const topBuildable = buildEligibility
    .filter((b) => b.maxBuildable > 0)
    .slice(0, 5);

  // Get recent activity
  const recentReceiving = await prisma.receivingRecord.findMany({
    where: { status: "PENDING" },
    include: { sku: true, createdBy: true },
    orderBy: { receivedAt: "desc" },
    take: 5,
  });

  // Get forecast progress data
  const forecasts = await prisma.forecast.findMany({
    orderBy: { updatedAt: "desc" },
  });

  // Get current inventory for forecasted SKUs
  const forecastProgress = await Promise.all(
    forecasts.map(async (forecast) => {
      const sku = await prisma.sku.findUnique({
        where: { id: forecast.skuId },
        select: { id: true, sku: true, name: true },
      });

      if (!sku) return null;

      const current = forecast.currentInGallatin;
      const target = forecast.quantity;
      const percentage = target > 0 ? Math.round((current / target) * 100) : 0;

      return {
        sku,
        current,
        target,
        percentage: Math.min(percentage, 100),
        remaining: Math.max(target - current, 0),
      };
    })
  ).then((results) => results.filter((r) => r !== null));

  return {
    user,
    stats: {
      totalSkus,
      rawSkus,
      assemblySkus,
      completedSkus,
      pendingReceiving,
      recentTransfers,
    },
    inventoryStats,
    topBuildable,
    recentReceiving,
    forecastProgress,
  };
};

export default function Dashboard() {
  const { user, stats, inventoryStats, topBuildable, recentReceiving, forecastProgress } =
    useLoaderData<typeof loader>();

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          Welcome back, {user.firstName}. Here's your inventory overview.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total SKUs</div>
          <div className="stat-value">{stats.totalSkus}</div>
          <div className="text-sm text-gray-500 mt-2">
            {stats.rawSkus} raw · {stats.assemblySkus} assembly · {stats.completedSkus} completed
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Pending Receiving</div>
          <div className="stat-value">{stats.pendingReceiving}</div>
          <div className="text-sm text-gray-500 mt-2">Awaiting sign-off</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Recent Transfers</div>
          <div className="stat-value">{stats.recentTransfers}</div>
          <div className="text-sm text-gray-500 mt-2">Last 7 days</div>
        </div>
      </div>

      {/* Forecast Goals */}
      {forecastProgress.length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Forecast Goals</h2>
            <Link to="/forecasting" className="btn btn-sm btn-secondary">
              Manage Forecasts
            </Link>
          </div>
          <div className="card-body">
            <div className="space-y-6">
              {forecastProgress.map((forecast) => (
                <div key={forecast.sku.id}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm text-gray-500">{forecast.sku.sku}</span>
                        <span className="text-gray-900 font-medium">{forecast.sku.name}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-bold text-gray-900">
                        {forecast.current.toLocaleString()}
                      </span>
                      <span className="text-gray-500"> / {forecast.target.toLocaleString()}</span>
                      {forecast.remaining > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          {forecast.remaining.toLocaleString()} remaining
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="relative">
                    <div className="w-full h-8 bg-gray-200 rounded-lg overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 flex items-center justify-center text-sm font-semibold ${
                          forecast.percentage >= 100
                            ? "bg-green-500 text-white"
                            : forecast.percentage >= 75
                            ? "bg-blue-500 text-white"
                            : forecast.percentage >= 50
                            ? "bg-yellow-500 text-white"
                            : "bg-orange-500 text-white"
                        }`}
                        style={{ width: `${forecast.percentage}%` }}
                      >
                        {forecast.percentage > 10 && `${forecast.percentage}%`}
                      </div>
                    </div>
                    {forecast.percentage <= 10 && forecast.percentage > 0 && (
                      <div className="absolute left-2 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-700">
                        {forecast.percentage}%
                      </div>
                    )}
                  </div>
                  {forecast.percentage >= 100 && (
                    <div className="mt-2 text-sm text-green-600 font-medium">
                      ✓ Goal achieved!
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Inventory Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Inventory by State</h2>
            <Link to="/inventory" className="btn btn-sm btn-secondary">
              View All
            </Link>
          </div>
          <div className="card-body">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
                  <span className="text-gray-700">Received (Pending)</span>
                </div>
                <span className="font-semibold">{inventoryStats.received.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                  <span className="text-gray-700">Raw Materials</span>
                </div>
                <span className="font-semibold">{inventoryStats.raw.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                  <span className="text-gray-700">Assembled</span>
                </div>
                <span className="font-semibold">{inventoryStats.assembled.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  <span className="text-gray-700">Completed</span>
                </div>
                <span className="font-semibold">{inventoryStats.completed.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Top Buildable Items</h2>
            <Link to="/build" className="btn btn-sm btn-secondary">
              View All
            </Link>
          </div>
          <div className="card-body">
            {topBuildable.length === 0 ? (
              <div className="empty-state py-8">
                <p className="text-gray-500">No items can be built with current inventory</p>
              </div>
            ) : (
              <div className="space-y-3">
                {topBuildable.map((item) => (
                  <div key={item.skuId} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                    <div>
                      <p className="font-mono text-sm text-gray-500">{item.sku}</p>
                      <p className="text-gray-900 font-medium truncate max-w-xs">{item.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-beast-600">{item.maxBuildable}</p>
                      <p className="text-xs text-gray-500">buildable</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pending Receiving */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Pending Receiving</h2>
          <Link to="/receiving" className="btn btn-sm btn-primary">
            New Receipt
          </Link>
        </div>
        {recentReceiving.length === 0 ? (
          <div className="card-body">
            <div className="empty-state py-8">
              <p className="text-gray-500">No pending receipts to sign off</p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Quantity</th>
                <th>Received</th>
                <th>Created By</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentReceiving.map((record) => (
                <tr key={record.id}>
                  <td>
                    <span className="font-mono text-sm">{record.sku.sku}</span>
                  </td>
                  <td>{record.sku.name}</td>
                  <td className="font-semibold">{record.quantity}</td>
                  <td>{new Date(record.receivedAt).toLocaleDateString()}</td>
                  <td>{record.createdBy.firstName} {record.createdBy.lastName}</td>
                  <td>
                    <Link to={`/receiving/${record.id}`} className="btn btn-sm btn-secondary">
                      Review
                    </Link>
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
