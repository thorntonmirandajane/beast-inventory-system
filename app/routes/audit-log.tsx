import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, Link } from "react-router";
import { requireRole } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "SUPERVISOR"]);

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const resourceType = url.searchParams.get("resourceType");
  const userId = url.searchParams.get("userId");
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");

  const whereClause: any = {};

  if (action) {
    whereClause.action = action;
  }

  if (resourceType) {
    whereClause.resourceType = resourceType;
  }

  if (userId) {
    whereClause.userId = userId;
  }

  if (dateFrom || dateTo) {
    whereClause.createdAt = {};
    if (dateFrom) {
      whereClause.createdAt.gte = new Date(dateFrom);
    }
    if (dateTo) {
      const endDate = new Date(dateTo);
      endDate.setDate(endDate.getDate() + 1);
      whereClause.createdAt.lt = endDate;
    }
  }

  const logs = await prisma.auditLog.findMany({
    where: whereClause,
    include: {
      user: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Get distinct values for filters
  const actions = await prisma.auditLog.findMany({
    select: { action: true },
    distinct: ["action"],
    orderBy: { action: "asc" },
  });

  const resourceTypes = await prisma.auditLog.findMany({
    select: { resourceType: true },
    distinct: ["resourceType"],
    orderBy: { resourceType: "asc" },
  });

  const users = await prisma.user.findMany({
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return {
    user,
    logs,
    filters: {
      actions: actions.map((a) => a.action),
      resourceTypes: resourceTypes.map((r) => r.resourceType),
      users,
    },
    currentFilters: { action, resourceType, userId, dateFrom, dateTo },
  };
};

export default function AuditLog() {
  const { user, logs, filters, currentFilters } = useLoaderData<typeof loader>();

  const getActionColor = (action: string) => {
    if (action.includes("CREATE") || action.includes("APPROVE") || action.includes("CLOCK_IN")) {
      return "bg-green-100 text-green-800";
    }
    if (action.includes("DELETE") || action.includes("REJECT") || action.includes("CANCEL") || action.includes("CLOCK_OUT")) {
      return "bg-red-100 text-red-800";
    }
    if (action.includes("UPDATE") || action.includes("RESET") || action.includes("BREAK")) {
      return "bg-yellow-100 text-yellow-800";
    }
    if (action.includes("BUILD") || action.includes("EXECUTE")) {
      return "bg-blue-100 text-blue-800";
    }
    return "bg-gray-100 text-gray-800";
  };

  const formatDetails = (details: any) => {
    if (!details || Object.keys(details).length === 0) {
      return "—";
    }
    return Object.entries(details)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
  };

  const hasFilters =
    currentFilters.action ||
    currentFilters.resourceType ||
    currentFilters.userId ||
    currentFilters.dateFrom ||
    currentFilters.dateTo;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Audit Log</h1>
        <p className="page-subtitle">Track all system activities and changes</p>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Filters</h2>
        </div>
        <div className="card-body">
          <Form method="get">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">Action</label>
                <select
                  name="action"
                  className="form-select"
                  defaultValue={currentFilters.action || ""}
                >
                  <option value="">All Actions</option>
                  {filters.actions.map((action) => (
                    <option key={action} value={action}>
                      {action.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Resource Type</label>
                <select
                  name="resourceType"
                  className="form-select"
                  defaultValue={currentFilters.resourceType || ""}
                >
                  <option value="">All Types</option>
                  {filters.resourceTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">User</label>
                <select
                  name="userId"
                  className="form-select"
                  defaultValue={currentFilters.userId || ""}
                >
                  <option value="">All Users</option>
                  {filters.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.firstName} {u.lastName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date From</label>
                <input
                  type="date"
                  name="dateFrom"
                  className="form-input"
                  defaultValue={currentFilters.dateFrom || ""}
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Date To</label>
                <input
                  type="date"
                  name="dateTo"
                  className="form-input"
                  defaultValue={currentFilters.dateTo || ""}
                />
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="submit" className="btn btn-primary">
                Apply Filters
              </button>
              {hasFilters && (
                <Link to="/audit-log" className="btn btn-secondary">
                  Clear Filters
                </Link>
              )}
            </div>
          </Form>
        </div>
      </div>

      {/* Logs Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            Activity Log ({logs.length}
            {logs.length === 200 ? "+" : ""})
          </h2>
        </div>
        {logs.length === 0 ? (
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
                  d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                />
              </svg>
              <h3 className="empty-state-title">No audit logs found</h3>
              <p className="empty-state-description">
                {hasFilters
                  ? "Try adjusting your filters."
                  : "System activity will appear here."}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Resource ID</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap">
                      <div className="text-sm">
                        {new Date(log.createdAt).toLocaleDateString()}
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(log.createdAt).toLocaleTimeString()}
                      </div>
                    </td>
                    <td>
                      {log.user ? (
                        <span className="font-medium">
                          {log.user.firstName} {log.user.lastName}
                        </span>
                      ) : (
                        <span className="text-gray-400">System</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${getActionColor(log.action)}`}
                      >
                        {log.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>{log.resourceType}</td>
                    <td>
                      <span className="font-mono text-xs">
                        {log.resourceId.slice(0, 8)}
                      </span>
                    </td>
                    <td className="max-w-xs truncate text-sm text-gray-600">
                      {formatDetails(log.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
