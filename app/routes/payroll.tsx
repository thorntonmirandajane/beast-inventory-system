import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  const url = new URL(request.url);
  const startDateStr = url.searchParams.get("startDate");
  const endDateStr = url.searchParams.get("endDate");

  // Default to current month if no dates provided
  const now = new Date();
  const startDate = startDateStr
    ? new Date(startDateStr)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = endDateStr
    ? new Date(endDateStr + "T23:59:59")
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // Get all active workers
  const workers = await prisma.user.findMany({
    where: {
      isActive: true,
      role: "WORKER",
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Get all clock events for workers in the date range
  const clockEvents = await prisma.clockEvent.findMany({
    where: {
      userId: { in: workers.map((w) => w.id) },
      timestamp: {
        gte: startDate,
        lte: endDate,
      },
    },
    orderBy: { timestamp: "asc" },
  });

  // Calculate hours for each worker
  const payrollData = workers.map((worker) => {
    const workerEvents = clockEvents.filter((e) => e.userId === worker.id);

    let totalMs = 0;
    let clockInTime: Date | null = null;
    let breakStartTime: Date | null = null;

    for (const event of workerEvents) {
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
          clockInTime = null;
          break;
        case "BREAK_END":
          clockInTime = event.timestamp;
          breakStartTime = null;
          break;
      }
    }

    const hours = totalMs / (1000 * 60 * 60);
    const pay = worker.payRate ? hours * worker.payRate : 0;

    return {
      id: worker.id,
      firstName: worker.firstName,
      lastName: worker.lastName,
      email: worker.email,
      payRate: worker.payRate || 0,
      hours: parseFloat(hours.toFixed(2)),
      pay: parseFloat(pay.toFixed(2)),
    };
  });

  const totalHours = payrollData.reduce((sum, w) => sum + w.hours, 0);
  const totalPay = payrollData.reduce((sum, w) => sum + w.pay, 0);

  return {
    user,
    payrollData,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    totalHours: parseFloat(totalHours.toFixed(2)),
    totalPay: parseFloat(totalPay.toFixed(2)),
  };
};

export default function Payroll() {
  const { user, payrollData, startDate, endDate, totalHours, totalPay } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Payroll Report</h1>
        <p className="page-subtitle">View worker hours and pay for a date range</p>
      </div>

      {/* Date Range Selector */}
      <div className="card mb-6">
        <div className="card-body">
          <Form method="get" className="flex items-end gap-4">
            <div className="flex-1">
              <label htmlFor="startDate" className="form-label">
                Start Date
              </label>
              <input
                type="date"
                id="startDate"
                name="startDate"
                className="form-input"
                defaultValue={startDate}
                required
              />
            </div>
            <div className="flex-1">
              <label htmlFor="endDate" className="form-label">
                End Date
              </label>
              <input
                type="date"
                id="endDate"
                name="endDate"
                className="form-input"
                defaultValue={endDate}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading}
            >
              {isLoading ? "Loading..." : "Generate Report"}
            </button>
          </Form>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{payrollData.length}</div>
          <div className="stat-label">Active Workers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalHours.toFixed(2)}</div>
          <div className="stat-label">Total Hours</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${totalPay.toFixed(2)}</div>
          <div className="stat-label">Total Owed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            ${totalHours > 0 ? (totalPay / totalHours).toFixed(2) : "0.00"}
          </div>
          <div className="stat-label">Avg Rate/Hour</div>
        </div>
      </div>

      {/* Payroll Table */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Worker Breakdown</h2>
        </div>
        {payrollData.length === 0 ? (
          <div className="card-body">
            <div className="text-center text-gray-500 py-8">
              No workers found for this date range
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Email</th>
                <th className="text-right">Pay Rate</th>
                <th className="text-right">Hours Worked</th>
                <th className="text-right">Amount Owed</th>
              </tr>
            </thead>
            <tbody>
              {payrollData.map((worker) => (
                <tr key={worker.id}>
                  <td className="font-medium">
                    {worker.firstName} {worker.lastName}
                  </td>
                  <td className="text-sm text-gray-600">{worker.email}</td>
                  <td className="text-right">
                    {worker.payRate > 0 ? (
                      <span className="font-medium">${worker.payRate.toFixed(2)}/hr</span>
                    ) : (
                      <span className="text-red-600 font-medium">Not Set</span>
                    )}
                  </td>
                  <td className="text-right font-semibold">
                    {worker.hours.toFixed(2)}
                  </td>
                  <td className="text-right font-semibold text-green-600">
                    ${worker.pay.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td colSpan={3} className="text-right">
                  TOTALS:
                </td>
                <td className="text-right">{totalHours.toFixed(2)} hrs</td>
                <td className="text-right text-green-600">
                  ${totalPay.toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </Layout>
  );
}
