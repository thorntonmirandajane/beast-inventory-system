import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get all workers
  const workers = await prisma.user.findMany({
    where: { role: "WORKER", isActive: true },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return { user, workers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add-manual-entry") {
    const workerId = formData.get("workerId") as string;
    const clockInDate = formData.get("clockInDate") as string;
    const clockInTime = formData.get("clockInTime") as string;
    const clockOutTime = formData.get("clockOutTime") as string;
    const breakMinutes = parseInt(formData.get("breakMinutes") as string, 10) || 0;
    const notes = formData.get("notes") as string;

    if (!workerId || !clockInDate || !clockInTime || !clockOutTime) {
      return { error: "All fields except break minutes and notes are required" };
    }

    // Parse timestamps
    const clockInTimestamp = new Date(`${clockInDate}T${clockInTime}`);
    const clockOutTimestamp = new Date(`${clockInDate}T${clockOutTime}`);

    // Validate times
    if (clockOutTimestamp <= clockInTimestamp) {
      return { error: "Clock out time must be after clock in time" };
    }

    if (isNaN(breakMinutes) || breakMinutes < 0) {
      return { error: "Break minutes must be a valid non-negative number" };
    }

    // Calculate total minutes
    const totalMinutes = Math.floor((clockOutTimestamp.getTime() - clockInTimestamp.getTime()) / (1000 * 60));
    const actualMinutes = totalMinutes - breakMinutes;

    if (actualMinutes <= 0) {
      return { error: "Actual working time must be positive (check break minutes)" };
    }

    // Create clock in event
    const clockInEvent = await prisma.clockEvent.create({
      data: {
        userId: workerId,
        type: "CLOCK_IN",
        timestamp: clockInTimestamp,
        notes: `Manual entry by admin: ${notes || "No notes"}`,
      },
    });

    // Create clock out event
    const clockOutEvent = await prisma.clockEvent.create({
      data: {
        userId: workerId,
        type: "CLOCK_OUT",
        timestamp: clockOutTimestamp,
        notes: `Manual entry by admin: ${notes || "No notes"}`,
      },
    });

    // Create time entry (in DRAFT status, admin can approve later)
    const timeEntry = await prisma.workerTimeEntry.create({
      data: {
        userId: workerId,
        clockInEventId: clockInEvent.id,
        clockOutEventId: clockOutEvent.id,
        clockInTime: clockInTimestamp,
        clockOutTime: clockOutTimestamp,
        breakMinutes,
        actualMinutes,
        status: "DRAFT",
      },
    });

    await createAuditLog(
      user.id,
      "CREATE_MANUAL_TIME_ENTRY",
      "WorkerTimeEntry",
      timeEntry.id,
      {
        workerId,
        clockInTime: clockInTimestamp,
        clockOutTime: clockOutTimestamp,
        breakMinutes,
        actualMinutes,
        notes,
      }
    );

    return redirect(`/time-entry-approvals?success=Manual+time+entry+created+for+worker`);
  }

  return { error: "Invalid action" };
};

export default function AdminManualTimeEntry() {
  const { user, workers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Get today's date in YYYY-MM-DD format for default
  const today = new Date().toISOString().split('T')[0];

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Add Manual Time Entry</h1>
        <p className="page-subtitle">
          Enter time for workers who forgot to clock in/out
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}

      <div className="card max-w-2xl">
        <div className="card-body">
          <Form method="post" className="space-y-6">
            <input type="hidden" name="intent" value="add-manual-entry" />

            {/* Worker Selection */}
            <div className="form-group">
              <label htmlFor="workerId" className="form-label required">
                Worker
              </label>
              <select
                id="workerId"
                name="workerId"
                className="form-input"
                required
              >
                <option value="">Select a worker...</option>
                {workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.firstName} {worker.lastName} ({worker.email})
                  </option>
                ))}
              </select>
            </div>

            {/* Date */}
            <div className="form-group">
              <label htmlFor="clockInDate" className="form-label required">
                Date
              </label>
              <input
                type="date"
                id="clockInDate"
                name="clockInDate"
                className="form-input"
                defaultValue={today}
                max={today}
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Cannot enter future dates
              </p>
            </div>

            {/* Clock In and Out Times */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label htmlFor="clockInTime" className="form-label required">
                  Clock In Time
                </label>
                <input
                  type="time"
                  id="clockInTime"
                  name="clockInTime"
                  className="form-input"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="clockOutTime" className="form-label required">
                  Clock Out Time
                </label>
                <input
                  type="time"
                  id="clockOutTime"
                  name="clockOutTime"
                  className="form-input"
                  required
                />
              </div>
            </div>

            {/* Break Minutes */}
            <div className="form-group">
              <label htmlFor="breakMinutes" className="form-label">
                Break Time (minutes)
              </label>
              <input
                type="number"
                id="breakMinutes"
                name="breakMinutes"
                className="form-input"
                min="0"
                step="1"
                defaultValue="0"
                placeholder="0"
              />
              <p className="text-xs text-gray-500 mt-1">
                Enter total break time in minutes (default: 0)
              </p>
            </div>

            {/* Notes */}
            <div className="form-group">
              <label htmlFor="notes" className="form-label">
                Notes (optional)
              </label>
              <textarea
                id="notes"
                name="notes"
                className="form-textarea"
                rows={3}
                placeholder="Why is this being entered manually? (e.g., Worker forgot to clock in)"
              />
            </div>

            {/* Info Box */}
            <div className="alert alert-info">
              <p className="text-sm">
                <strong>Note:</strong> This will create clock in/out events and a time entry in DRAFT status.
                The worker will still need to submit their completed tasks, and you will need to approve
                the entry in Time Entry Approvals.
              </p>
            </div>

            {/* Submit Button */}
            <div className="flex gap-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating Entry..." : "Create Manual Entry"}
              </button>
              <a href="/time-clock" className="btn btn-secondary">
                Cancel
              </a>
            </div>
          </Form>
        </div>
      </div>
    </Layout>
  );
}
