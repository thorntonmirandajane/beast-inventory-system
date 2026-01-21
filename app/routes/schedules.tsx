import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

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

  if (user.role !== "ADMIN") {
    throw new Response("UNAUTHORIZED", { status: 403 });
  }

  // Get all workers with their schedules
  const workers = await prisma.user.findMany({
    where: { isActive: true },
    include: {
      schedules: {
        orderBy: { dayOfWeek: "asc" },
      },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Calculate total scheduled hours per week for each worker
  const workersWithHours = workers.map((worker) => {
    const weeklyHours = worker.schedules.reduce((total, schedule) => {
      if (!schedule.isActive) return total;
      const start = parseTime(schedule.startTime);
      const end = parseTime(schedule.endTime);
      return total + (end - start);
    }, 0);

    return {
      ...worker,
      weeklyHours,
    };
  });

  return { user, workers: workersWithHours };
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
          userId_dayOfWeek: {
            userId: workerId,
            dayOfWeek: day,
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
          startTime: startTime || "08:00",
          endTime: endTime || "17:00",
          isActive,
        },
      });
    }

    await createAuditLog(user.id, "UPDATE_SCHEDULE", "WorkerSchedule", workerId, {});

    return { success: true, message: "SCHEDULE UPDATED SUCCESSFULLY" };
  }

  return { error: "INVALID ACTION" };
};

export default function Schedules() {
  const { user, workers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Build schedule map for each worker
  const getScheduleForDay = (
    schedules: any[],
    dayOfWeek: number
  ): { startTime: string; endTime: string; isActive: boolean } => {
    const schedule = schedules.find((s) => s.dayOfWeek === dayOfWeek);
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
        <h1 className="page-title">Worker Schedules</h1>
        <p className="page-subtitle">Manage worker weekly schedules</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

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
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
}
