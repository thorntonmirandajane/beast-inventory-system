import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { calculateWeeklyHours, calculateOvertimePay } from "../utils/overtime.server";

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

  // Calculate hours for each worker with overtime
  const payrollData = workers.map((worker) => {
    const workerEvents = clockEvents.filter((e) => e.userId === worker.id);

    // Calculate weekly hours
    const weeklyHours = calculateWeeklyHours(workerEvents);

    // Calculate overtime pay
    const overtimeCalc = calculateOvertimePay(weeklyHours, worker.payRate || 0);

    return {
      id: worker.id,
      firstName: worker.firstName,
      lastName: worker.lastName,
      email: worker.email,
      payRate: worker.payRate || 0,
      regularHours: parseFloat(overtimeCalc.regularHours.toFixed(2)),
      overtimeHours: parseFloat(overtimeCalc.overtimeHours.toFixed(2)),
      totalHours: parseFloat((overtimeCalc.regularHours + overtimeCalc.overtimeHours).toFixed(2)),
      regularPay: parseFloat(overtimeCalc.regularPay.toFixed(2)),
      overtimePay: parseFloat(overtimeCalc.overtimePay.toFixed(2)),
      totalPay: parseFloat(overtimeCalc.totalPay.toFixed(2)),
      weeklyBreakdown: weeklyHours,
    };
  });

  const totalRegularHours = payrollData.reduce((sum, w) => sum + w.regularHours, 0);
  const totalOvertimeHours = payrollData.reduce((sum, w) => sum + w.overtimeHours, 0);
  const totalHours = payrollData.reduce((sum, w) => sum + w.totalHours, 0);
  const totalRegularPay = payrollData.reduce((sum, w) => sum + w.regularPay, 0);
  const totalOvertimePay = payrollData.reduce((sum, w) => sum + w.overtimePay, 0);
  const totalPay = payrollData.reduce((sum, w) => sum + w.totalPay, 0);

  return {
    user,
    payrollData,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    totalRegularHours: parseFloat(totalRegularHours.toFixed(2)),
    totalOvertimeHours: parseFloat(totalOvertimeHours.toFixed(2)),
    totalHours: parseFloat(totalHours.toFixed(2)),
    totalRegularPay: parseFloat(totalRegularPay.toFixed(2)),
    totalOvertimePay: parseFloat(totalOvertimePay.toFixed(2)),
    totalPay: parseFloat(totalPay.toFixed(2)),
    workerCount: payrollData.length,
  };
};

export default function Payroll() {
  const {
    user,
    payrollData,
    startDate,
    endDate,
    totalRegularHours,
    totalOvertimeHours,
    totalHours,
    totalRegularPay,
    totalOvertimePay,
    totalPay,
    workerCount,
  } = useLoaderData<typeof loader>();
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
          <div className="stat-value">{workerCount}</div>
          <div className="stat-label">Total Workers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalRegularHours.toFixed(1)}h</div>
          <div className="stat-label">Regular Hours</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-orange-600">{totalOvertimeHours.toFixed(1)}h</div>
          <div className="stat-label">Overtime Hours</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-green-600">${totalPay.toFixed(2)}</div>
          <div className="stat-label">Total Pay</div>
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
                <th className="text-right">Pay Rate</th>
                <th className="text-right">Regular Hours</th>
                <th className="text-right">Overtime Hours</th>
                <th className="text-right">Regular Pay</th>
                <th className="text-right">Overtime Pay</th>
                <th className="text-right">Total Pay</th>
              </tr>
            </thead>
            <tbody>
              {payrollData.map((worker) => (
                <tr key={worker.id}>
                  <td className="font-medium">
                    {worker.firstName} {worker.lastName}
                  </td>
                  <td className="text-right">
                    {worker.payRate > 0 ? (
                      <span>${worker.payRate.toFixed(2)}/hr</span>
                    ) : (
                      <span className="text-yellow-600">Not Set</span>
                    )}
                  </td>
                  <td className="text-right">{worker.regularHours.toFixed(1)}h</td>
                  <td className={`text-right ${worker.overtimeHours > 0 ? "text-orange-600 font-bold" : ""}`}>
                    {worker.overtimeHours > 0 ? `${worker.overtimeHours.toFixed(1)}h` : "—"}
                  </td>
                  <td className="text-right">${worker.regularPay.toFixed(2)}</td>
                  <td className={`text-right ${worker.overtimePay > 0 ? "text-orange-600 font-bold" : ""}`}>
                    {worker.overtimePay > 0 ? `$${worker.overtimePay.toFixed(2)}` : "—"}
                  </td>
                  <td className="text-right font-bold">${worker.totalPay.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-bold">
                <td colSpan={2} className="text-right">TOTAL</td>
                <td className="text-right">{totalRegularHours.toFixed(1)}h</td>
                <td className="text-right text-orange-600">{totalOvertimeHours.toFixed(1)}h</td>
                <td className="text-right">${totalRegularPay.toFixed(2)}</td>
                <td className="text-right text-orange-600">${totalOvertimePay.toFixed(2)}</td>
                <td className="text-right text-green-600">${totalPay.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </Layout>
  );
}
