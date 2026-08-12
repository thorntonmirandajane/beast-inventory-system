import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation, useFetcher } from "react-router";
import { useState } from "react";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { buildShifts, weeklyHoursFromShifts, calculateOvertimePay } from "../utils/overtime.server";

const MT = "America/Denver";
// Format a Date to a Mountain-time datetime-local string (YYYY-MM-DDTHH:mm).
// The server runs in America/Denver, so new Date(str) parses it back as MT.
function toMtInput(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MT, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
function mtDayLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: MT, weekday: "short", month: "short", day: "numeric" }).format(d);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);

  const url = new URL(request.url);
  const startDateStr = url.searchParams.get("startDate");
  const endDateStr = url.searchParams.get("endDate");

  const now = new Date();
  const startDate = startDateStr
    ? new Date(startDateStr)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = endDateStr
    ? new Date(endDateStr + "T23:59:59")
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // Everyone who logs time: workers plus admins/managers with canLogTime (e.g. Carson).
  const workers = await prisma.user.findMany({
    where: { isActive: true, OR: [{ role: "WORKER" }, { canLogTime: true }] },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const clockEvents = await prisma.clockEvent.findMany({
    where: {
      userId: { in: workers.map((w) => w.id) },
      timestamp: { gte: startDate, lte: endDate },
    },
    orderBy: { timestamp: "asc" },
  });

  const payrollData = workers.map((worker) => {
    const workerEvents = clockEvents.filter((e) => e.userId === worker.id);
    const shifts = buildShifts(workerEvents);
    const weeklyHours = weeklyHoursFromShifts(shifts);
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
      hasOpen: shifts.some((s) => s.open),
      shifts: shifts.map((s) => ({
        clockInId: s.clockInId,
        clockOutId: s.clockOutId,
        dayLabel: mtDayLabel(s.clockIn),
        clockInInput: toMtInput(s.clockIn),
        clockOutInput: s.clockOut ? toMtInput(s.clockOut) : "",
        hours: parseFloat(s.hours.toFixed(2)),
        open: s.open,
      })),
    };
  });

  const sum = (f: (w: (typeof payrollData)[number]) => number) => payrollData.reduce((s, w) => s + f(w), 0);

  return {
    user,
    payrollData,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    totalRegularHours: parseFloat(sum((w) => w.regularHours).toFixed(2)),
    totalOvertimeHours: parseFloat(sum((w) => w.overtimeHours).toFixed(2)),
    totalHours: parseFloat(sum((w) => w.totalHours).toFixed(2)),
    totalRegularPay: parseFloat(sum((w) => w.regularPay).toFixed(2)),
    totalOvertimePay: parseFloat(sum((w) => w.overtimePay).toFixed(2)),
    totalPay: parseFloat(sum((w) => w.totalPay).toFixed(2)),
    workerCount: payrollData.length,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "edit-shift") {
    const clockInId = String(form.get("clockInId") || "");
    const clockOutId = String(form.get("clockOutId") || "");
    const workerId = String(form.get("workerId") || "");
    const clockInStr = String(form.get("clockIn") || "");
    const clockOutStr = String(form.get("clockOut") || "");

    if (!clockInId || !clockInStr) return { error: "Missing clock-in time." };
    const clockIn = new Date(clockInStr);
    if (isNaN(clockIn.getTime())) return { error: "Invalid clock-in time." };

    let clockOut: Date | null = null;
    if (clockOutStr) {
      clockOut = new Date(clockOutStr);
      if (isNaN(clockOut.getTime())) return { error: "Invalid clock-out time." };
      if (clockOut <= clockIn) return { error: "Clock-out must be after clock-in." };
    }

    await prisma.$transaction(async (tx) => {
      await tx.clockEvent.update({ where: { id: clockInId }, data: { timestamp: clockIn } });
      if (clockOutId) {
        if (clockOut) await tx.clockEvent.update({ where: { id: clockOutId }, data: { timestamp: clockOut } });
      } else if (clockOut && workerId) {
        await tx.clockEvent.create({
          data: { userId: workerId, type: "CLOCK_OUT", timestamp: clockOut, notes: "Added via payroll edit" },
        });
      }
    });

    await createAuditLog(user.id, "EDIT_CLOCK_SHIFT", "ClockEvent", clockInId, {
      clockIn: clockInStr, clockOut: clockOutStr || null, addedClockOut: !clockOutId && !!clockOut,
    });
    return { success: clockOutId ? "Shift updated." : clockOut ? "Clock-out added." : "Clock-in updated." };
  }

  return { error: "Unknown action" };
};

export default function Payroll() {
  const {
    user, payrollData, startDate, endDate,
    totalRegularHours, totalOvertimeHours, totalRegularPay, totalOvertimePay, totalPay, workerCount,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const edit = useFetcher<{ success?: string; error?: string }>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Payroll Report</h1>
        <p className="page-subtitle">
          Worker hours and pay for a date range. Click a worker to see and edit each day's shift.
        </p>
      </div>

      {/* Date Range Selector */}
      <div className="card mb-6">
        <div className="card-body">
          <Form method="get" className="flex items-end gap-4">
            <div className="flex-1">
              <label htmlFor="startDate" className="form-label">Start Date</label>
              <input type="date" id="startDate" name="startDate" className="form-input" defaultValue={startDate} required />
            </div>
            <div className="flex-1">
              <label htmlFor="endDate" className="form-label">End Date</label>
              <input type="date" id="endDate" name="endDate" className="form-input" defaultValue={endDate} required />
            </div>
            <button type="submit" className="btn btn-primary" disabled={isLoading}>
              {isLoading ? "Loading..." : "Generate Report"}
            </button>
          </Form>
        </div>
      </div>

      {(edit.data?.success || edit.data?.error) && (
        <div className={`alert mb-6 ${edit.data.error ? "alert-error" : "alert-success"}`}>
          {edit.data.error || edit.data.success}
        </div>
      )}

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
            <div className="text-center text-gray-500 py-8">No workers found for this date range</div>
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
                <FragmentRow
                  key={worker.id}
                  worker={worker}
                  open={expanded.has(worker.id)}
                  onToggle={() => toggle(worker.id)}
                  edit={edit}
                />
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

type Worker = Awaited<ReturnType<typeof loader>>["payrollData"][number];

function FragmentRow({
  worker, open, onToggle, edit,
}: {
  worker: Worker;
  open: boolean;
  onToggle: () => void;
  edit: ReturnType<typeof useFetcher<{ success?: string; error?: string }>>;
}) {
  return (
    <>
      <tr className={open ? "bg-blue-50" : ""}>
        <td className="font-medium">
          <button type="button" onClick={onToggle} className="flex items-center gap-2 text-left hover:text-blue-600">
            <span className="text-gray-400">{open ? "▼" : "▶"}</span>
            {worker.firstName} {worker.lastName}
            {worker.hasOpen && (
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">still clocked in</span>
            )}
          </button>
        </td>
        <td className="text-right">
          {worker.payRate > 0 ? <span>${worker.payRate.toFixed(2)}/hr</span> : <span className="text-yellow-600">Not Set</span>}
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
      {open && (
        <tr>
          <td colSpan={7} className="bg-gray-50 p-0">
            <div className="p-4">
              {worker.shifts.length === 0 ? (
                <p className="text-sm text-gray-500">No shifts in this range.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-2 pr-4">Day</th>
                      <th className="py-2 pr-4">Clock in</th>
                      <th className="py-2 pr-4">Clock out</th>
                      <th className="py-2 pr-4 text-right">Hours</th>
                      <th className="py-2 pr-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {worker.shifts.map((s) => (
                      <tr key={s.clockInId} className={`border-b last:border-0 ${s.open ? "bg-red-50" : ""}`}>
                        <td className="py-2 pr-4 whitespace-nowrap">{s.dayLabel}</td>
                        <td colSpan={4} className="py-2">
                          <edit.Form method="post" className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="intent" value="edit-shift" />
                            <input type="hidden" name="clockInId" value={s.clockInId} />
                            <input type="hidden" name="clockOutId" value={s.clockOutId ?? ""} />
                            <input type="hidden" name="workerId" value={worker.id} />
                            <input type="datetime-local" name="clockIn" defaultValue={s.clockInInput} className="form-input" required />
                            <span className="text-gray-400">→</span>
                            <input
                              type="datetime-local"
                              name="clockOut"
                              defaultValue={s.clockOutInput}
                              className="form-input"
                              placeholder="not clocked out"
                            />
                            <span className="w-16 text-right font-medium">
                              {s.open ? <span className="text-red-600">open</span> : `${s.hours.toFixed(1)}h`}
                            </span>
                            <button type="submit" className="btn btn-secondary btn-sm" disabled={edit.state !== "idle"}>
                              {s.open ? "Add clock-out" : "Save"}
                            </button>
                          </edit.Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-gray-500 mt-2">
                Times are Mountain. Editing here adjusts the payroll clock; leave clock-out blank to keep a shift open.
              </p>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
