import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { useState } from "react";

const DAYS = [
  { id: 0, name: "SUNDAY", short: "SUN" },
  { id: 1, name: "MONDAY", short: "MON" },
  { id: 2, name: "TUESDAY", short: "TUE" },
  { id: 3, name: "WEDNESDAY", short: "WED" },
  { id: 4, name: "THURSDAY", short: "THU" },
  { id: 5, name: "FRIDAY", short: "FRI" },
  { id: 6, name: "SATURDAY", short: "SAT" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "recurring";

  // Get all workers for admin, or just current user for workers
  const workers = await prisma.user.findMany({
    where: user.role === "WORKER" ? { id: user.id } : { isActive: true },
    include: {
      schedules: {
        where: {
          isActive: true,
        },
        orderBy: [{ scheduleDate: "asc" }, { dayOfWeek: "asc" }],
      },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Separate recurring and date-specific schedules
  const workersWithHours = workers.map((worker) => {
    const recurringSchedules = worker.schedules.filter(s => s.scheduleType === "RECURRING");
    const dateSchedules = worker.schedules.filter(s => s.scheduleType === "SPECIFIC_DATE");

    const weeklyHours = recurringSchedules.reduce((total, schedule) => {
      const start = parseTime(schedule.startTime);
      const end = parseTime(schedule.endTime);
      return total + (end - start);
    }, 0);

    return {
      ...worker,
      weeklyHours,
      recurringSchedules,
      dateSchedules,
    };
  });

  // Get upcoming date-specific schedules (next 60 days) for calendar view
  const today = new Date();
  const sixtyDaysLater = new Date(today);
  sixtyDaysLater.setDate(today.getDate() + 60);

  const upcomingDateSchedules = await prisma.workerSchedule.findMany({
    where: {
      scheduleType: "SPECIFIC_DATE",
      scheduleDate: {
        gte: today,
        lte: sixtyDaysLater,
      },
      isActive: true,
      userId: user.role === "WORKER" ? user.id : undefined,
    },
    include: {
      user: { select: { firstName: true, lastName: true } },
    },
    orderBy: { scheduleDate: "asc" },
  });

  return {
    user,
    workers: workersWithHours,
    upcomingDateSchedules,
    view,
    isWorkerView: user.role === "WORKER",
  };
};

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours + minutes / 60;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("UNAUTHORIZED", { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update-schedule") {
    const workerId = formData.get("workerId") as string;

    // Parse schedule data for all days
    for (let day = 0; day <= 6; day++) {
      const isActive = formData.get(`day-${day}-active`) === "on";
      const startTime = formData.get(`day-${day}-start`) as string;
      const endTime = formData.get(`day-${day}-end`) as string;

      // Upsert schedule
      await prisma.workerSchedule.upsert({
        where: {
          userId_dayOfWeek_scheduleDate: {
            userId: workerId,
            dayOfWeek: day,
            scheduleDate: null,
          },
        },
        update: {
          startTime: startTime || "08:00",
          endTime: endTime || "17:00",
          isActive,
        },
        create: {
          userId: workerId,
          dayOfWeek: day,
          scheduleDate: null,
          scheduleType: "RECURRING",
          startTime: startTime || "08:00",
          endTime: endTime || "17:00",
          isActive,
        },
      });
    }

    await createAuditLog(user.id, "UPDATE_SCHEDULE", "WorkerSchedule", workerId, {});

    return { success: true, message: "SCHEDULE UPDATED SUCCESSFULLY" };
  }

  if (intent === "create-date-schedule") {
    const workerIds = formData.getAll("workerIds") as string[];
    const scheduleDateStr = formData.get("scheduleDate") as string;
    const startTime = formData.get("startTime") as string;
    const endTime = formData.get("endTime") as string;

    if (!scheduleDateStr || !startTime || !endTime || workerIds.length === 0) {
      return { error: "All fields required" };
    }

    const scheduleDate = new Date(scheduleDateStr);
    scheduleDate.setHours(12, 0, 0, 0); // Set to noon to avoid timezone issues

    // Check for duplicates
    for (const workerId of workerIds) {
      const existing = await prisma.workerSchedule.findFirst({
        where: {
          userId: workerId,
          scheduleDate: scheduleDate,
          isActive: true,
        },
      });

      if (existing) {
        const worker = await prisma.user.findUnique({ where: { id: workerId } });
        return { error: `${worker?.firstName} ${worker?.lastName} already has a schedule for this date` };
      }
    }

    // Create schedules
    await prisma.workerSchedule.createMany({
      data: workerIds.map((workerId) => ({
        userId: workerId,
        scheduleType: "SPECIFIC_DATE",
        scheduleDate: scheduleDate,
        dayOfWeek: null,
        startTime,
        endTime,
        isActive: true,
      })),
    });

    await createAuditLog(user.id, "CREATE_DATE_SCHEDULE", "WorkerSchedule", workerIds.join(","), {
      date: scheduleDateStr,
      startTime,
      endTime,
    });

    return { success: true, message: `Created schedules for ${workerIds.length} worker(s)` };
  }

  if (intent === "delete-date-schedule") {
    const scheduleId = formData.get("scheduleId") as string;

    await prisma.workerSchedule.update({
      where: { id: scheduleId },
      data: { isActive: false },
    });

    await createAuditLog(user.id, "DELETE_DATE_SCHEDULE", "WorkerSchedule", scheduleId, {});

    return { success: true, message: "Schedule deleted" };
  }

  return { error: "INVALID ACTION" };
};

// Calendar helper functions
function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

interface CalendarDay {
  date: Date | null;
  schedules: any[];
  recurringSchedules: any[];
}

function generateCalendarMonth(year: number, month: number, dateSchedules: any[], workers: any[]): CalendarDay[][] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDayOfWeek = firstDay.getDay();

  const weeks: CalendarDay[][] = [];
  let currentWeek: CalendarDay[] = [];

  // Padding for first week
  for (let i = 0; i < startDayOfWeek; i++) {
    currentWeek.push({ date: null, schedules: [], recurringSchedules: [] });
  }

  // Days of month
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay();

    // Find specific date schedules for this date
    const daySchedules = dateSchedules.filter((s) => {
      if (s.scheduleDate) {
        const scheduleDate = new Date(s.scheduleDate);
        return isSameDay(scheduleDate, date);
      }
      return false;
    });

    // Find recurring schedules for this day of week
    const recurringForDay: any[] = [];
    workers.forEach((worker) => {
      const recurring = worker.recurringSchedules?.filter((s: any) => s.dayOfWeek === dayOfWeek && s.isActive);
      if (recurring && recurring.length > 0) {
        recurring.forEach((s: any) => {
          recurringForDay.push({
            ...s,
            user: { firstName: worker.firstName, lastName: worker.lastName },
          });
        });
      }
    });

    currentWeek.push({ date, schedules: daySchedules, recurringSchedules: recurringForDay });

    // End of week
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  // Padding for last week
  while (currentWeek.length < 7 && currentWeek.length > 0) {
    currentWeek.push({ date: null, schedules: [], recurringSchedules: [] });
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  return weeks;
}

function CalendarView({ workers, upcomingDateSchedules, user }: { workers: any[]; upcomingDateSchedules: any[]; user: any }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const weeks = generateCalendarMonth(year, month, upcomingDateSchedules, workers);

  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(year, month - 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1));
  };

  return (
    <div className="card">
      <div className="card-header flex justify-between items-center">
        <button onClick={goToPreviousMonth} className="btn btn-ghost btn-sm">
          ← Previous
        </button>
        <h3 className="card-title">
          {currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </h3>
        <button onClick={goToNextMonth} className="btn btn-ghost btn-sm">
          Next →
        </button>
      </div>

      <div className="card-body">
        {/* Day headers */}
        <div className="grid grid-cols-7 gap-2 mb-2">
          {DAYS.map((day) => (
            <div key={day.id} className="text-center text-xs font-semibold text-gray-600 py-2">
              {day.short}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        {weeks.map((week, wIdx) => (
          <div key={wIdx} className="grid grid-cols-7 gap-2 mb-2">
            {week.map((day, dIdx) => (
              <div
                key={dIdx}
                className={`min-h-24 border rounded p-2 ${
                  day.date
                    ? day.schedules.length > 0
                      ? "bg-blue-50 border-blue-300"
                      : day.recurringSchedules.length > 0
                      ? "bg-green-50 border-green-200"
                      : "bg-white border-gray-200"
                    : "bg-gray-50"
                }`}
              >
                {day.date && (
                  <>
                    <div className="text-sm font-semibold mb-1">{day.date.getDate()}</div>
                    {day.schedules.map((schedule, sIdx) => (
                      <div key={sIdx} className="text-xs bg-blue-500 text-white px-1 py-0.5 rounded mb-1">
                        📅 {schedule.user.firstName} {schedule.startTime}-{schedule.endTime}
                      </div>
                    ))}
                    {day.recurringSchedules.length > 0 && day.schedules.length === 0 && (
                      <div className="text-xs text-gray-500">
                        {day.recurringSchedules.length} scheduled
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        ))}

        {/* Legend */}
        <div className="mt-4 flex gap-4 text-xs text-gray-600">
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 bg-blue-50 border border-blue-300 rounded"></span>
            Specific Date
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 bg-green-50 border border-green-200 rounded"></span>
            Recurring Only
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Schedules() {
  const { user, workers, upcomingDateSchedules, view, isWorkerView } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Build schedule map for each worker
  const getScheduleForDay = (
    schedules: any[],
    dayOfWeek: number
  ): { startTime: string; endTime: string; isActive: boolean } => {
    const schedule = schedules.find((s) => s.dayOfWeek === dayOfWeek && s.scheduleType === "RECURRING");
    return schedule
      ? {
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          isActive: schedule.isActive,
        }
      : { startTime: "08:00", endTime: "17:00", isActive: false };
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">{isWorkerView ? "My Schedule" : "Worker Schedules"}</h1>
        <p className="page-subtitle">{isWorkerView ? "View your schedule" : "Manage worker schedules"}</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success mb-6">{actionData.message}</div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <Link
          to="/schedules?view=recurring"
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            view === "recurring"
              ? "border-blue-500 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Recurring Schedules
        </Link>
        <Link
          to="/schedules?view=calendar"
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            view === "calendar"
              ? "border-blue-500 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Calendar View
        </Link>
        {!isWorkerView && (
          <Link
            to="/schedules?view=date-specific"
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              view === "date-specific"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Date-Specific Schedules
          </Link>
        )}
      </div>

      {/* Recurring Schedules View */}
      {view === "recurring" && (
        <>
          {/* Summary Stats */}
          <div className="stats-grid mb-6">
            <div className="stat-card">
              <div className="stat-value">{workers.length}</div>
              <div className="stat-label">TOTAL WORKERS</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">
                {workers.reduce((sum, w) => sum + w.weeklyHours, 0).toFixed(1)}
              </div>
              <div className="stat-label">TOTAL WEEKLY HOURS</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">
                {workers.filter((w) => w.weeklyHours > 0).length}
              </div>
              <div className="stat-label">SCHEDULED WORKERS</div>
            </div>
          </div>

          {/* Worker Schedules */}
          <div className="space-y-4">
            {workers.map((worker) => (
              <div key={worker.id} className="card">
                <div className="card-header flex justify-between items-center">
                  <div>
                    <h2 className="card-title">
                      {worker.firstName.toUpperCase()} {worker.lastName.toUpperCase()}
                    </h2>
                    <p className="text-sm text-gray-500">
                      {worker.role} • {worker.weeklyHours.toFixed(1)} HRS/WEEK
                    </p>
                  </div>
                  <span
                    className={`badge ${
                      worker.weeklyHours > 0
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {worker.weeklyHours > 0 ? "SCHEDULED" : "NOT SCHEDULED"}
                  </span>
                </div>
                <div className="card-body">
                  {isWorkerView ? (
                    // Read-only view for workers
                    <div className="grid grid-cols-7 gap-2">
                      {DAYS.map((day) => {
                        const schedule = getScheduleForDay(worker.schedules, day.id);
                        return (
                          <div
                            key={day.id}
                            className={`p-2 rounded border text-center ${
                              schedule.isActive
                                ? "bg-blue-50 border-blue-200"
                                : "bg-gray-50 border-gray-200"
                            }`}
                          >
                            <div className="text-xs font-semibold mb-2">{day.short}</div>
                            {schedule.isActive ? (
                              <div className="text-xs">
                                <div>{schedule.startTime}</div>
                                <div>-</div>
                                <div>{schedule.endTime}</div>
                              </div>
                            ) : (
                              <div className="text-xs text-gray-400">OFF</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    // Editable view for admins
                    <Form method="post">
                      <input type="hidden" name="intent" value="update-schedule" />
                      <input type="hidden" name="workerId" value={worker.id} />

                      <div className="grid grid-cols-7 gap-2 mb-4">
                        {DAYS.map((day) => {
                          const schedule = getScheduleForDay(worker.schedules, day.id);
                          return (
                            <div
                              key={day.id}
                              className={`p-2 rounded border ${
                                schedule.isActive
                                  ? "bg-blue-50 border-blue-200"
                                  : "bg-gray-50 border-gray-200"
                              }`}
                            >
                              <div className="flex items-center gap-1 mb-2">
                                <input
                                  type="checkbox"
                                  name={`day-${day.id}-active`}
                                  defaultChecked={schedule.isActive}
                                  className="w-4 h-4"
                                />
                                <span className="text-xs font-semibold">{day.short}</span>
                              </div>
                              <div className="space-y-1">
                                <input
                                  type="time"
                                  name={`day-${day.id}-start`}
                                  defaultValue={schedule.startTime}
                                  className="form-input text-xs p-1 w-full"
                                />
                                <input
                                  type="time"
                                  name={`day-${day.id}-end`}
                                  defaultValue={schedule.endTime}
                                  className="form-input text-xs p-1 w-full"
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <button
                        type="submit"
                        className="btn btn-primary btn-sm"
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "SAVING..." : "SAVE SCHEDULE"}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Calendar View */}
      {view === "calendar" && (
        <CalendarView workers={workers} upcomingDateSchedules={upcomingDateSchedules} user={user} />
      )}

      {/* Date-Specific Schedules View (Admin only) */}
      {view === "date-specific" && !isWorkerView && (
        <>
          {/* Create Date Schedule Form */}
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">Create Date-Specific Schedule</h2>
            </div>
            <div className="card-body">
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value="create-date-schedule" />

                <div className="grid grid-cols-3 gap-4">
                  <div className="form-group">
                    <label className="form-label">Date</label>
                    <input
                      type="date"
                      name="scheduleDate"
                      required
                      className="form-input"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Start Time</label>
                    <input
                      type="time"
                      name="startTime"
                      required
                      defaultValue="08:00"
                      className="form-input"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">End Time</label>
                    <input
                      type="time"
                      name="endTime"
                      required
                      defaultValue="17:00"
                      className="form-input"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Workers</label>
                  <div className="grid grid-cols-3 gap-2 border border-gray-300 rounded p-3 max-h-48 overflow-y-auto">
                    {workers.map((worker) => (
                      <label key={worker.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          name="workerIds"
                          value={worker.id}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">
                          {worker.firstName} {worker.lastName}
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Select one or more workers</p>
                </div>

                <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? "Creating..." : "Create Schedule"}
                </button>
              </Form>
            </div>
          </div>

          {/* Upcoming Date Schedules List */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Upcoming Date-Specific Schedules</h2>
            </div>
            <div className="card-body">
              {upcomingDateSchedules.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No date-specific schedules found
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Worker</th>
                      <th>Time</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingDateSchedules.map((schedule) => (
                      <tr key={schedule.id}>
                        <td>
                          {new Date(schedule.scheduleDate!).toLocaleDateString("en-US", {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>
                        <td>
                          {schedule.user.firstName} {schedule.user.lastName}
                        </td>
                        <td>
                          {schedule.startTime} - {schedule.endTime}
                        </td>
                        <td>
                          <Form method="post" className="inline">
                            <input type="hidden" name="intent" value="delete-date-schedule" />
                            <input type="hidden" name="scheduleId" value={schedule.id} />
                            <button
                              type="submit"
                              className="btn btn-error btn-sm"
                              onClick={(e) => {
                                if (!confirm("Delete this schedule?")) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              Delete
                            </button>
                          </Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
