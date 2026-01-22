import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
  redirect,
  Link,
} from "react-router";
import { useState } from "react";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  getAllProcessConfigs,
  submitTimeEntry,
  PROCESS_TRANSITIONS,
} from "../utils/productivity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const clockOutId = url.searchParams.get("clockOut");

  if (!clockOutId) {
    throw new Response("Clock out event not found", { status: 400 });
  }

  // Get the clock out event
  const clockOutEvent = await prisma.clockEvent.findUnique({
    where: { id: clockOutId },
  });

  if (!clockOutEvent || clockOutEvent.userId !== user.id) {
    throw new Response("Invalid clock out event", { status: 400 });
  }

  // Find the corresponding clock in event (last CLOCK_IN before this CLOCK_OUT)
  const clockInEvent = await prisma.clockEvent.findFirst({
    where: {
      userId: user.id,
      type: "CLOCK_IN",
      timestamp: { lt: clockOutEvent.timestamp },
    },
    orderBy: { timestamp: "desc" },
  });

  if (!clockInEvent) {
    throw new Response("Could not find clock in event", { status: 400 });
  }

  // Calculate break minutes for this shift
  const breakEvents = await prisma.clockEvent.findMany({
    where: {
      userId: user.id,
      timestamp: {
        gte: clockInEvent.timestamp,
        lte: clockOutEvent.timestamp,
      },
      type: { in: ["BREAK_START", "BREAK_END"] },
    },
    orderBy: { timestamp: "asc" },
  });

  let breakMinutes = 0;
  let breakStart: Date | null = null;
  for (const event of breakEvents) {
    if (event.type === "BREAK_START") {
      breakStart = event.timestamp;
    } else if (event.type === "BREAK_END" && breakStart) {
      breakMinutes += Math.round(
        (event.timestamp.getTime() - breakStart.getTime()) / 1000 / 60
      );
      breakStart = null;
    }
  }

  // Get or find the draft time entry
  let timeEntry = await prisma.workerTimeEntry.findUnique({
    where: { clockInEventId: clockInEvent.id },
    include: { lines: true },
  });

  if (!timeEntry) {
    // Create one if it doesn't exist
    timeEntry = await prisma.workerTimeEntry.create({
      data: {
        userId: user.id,
        clockInEventId: clockInEvent.id,
        clockInTime: clockInEvent.timestamp,
        status: "DRAFT",
      },
      include: { lines: true },
    });
  }

  // Get worker's pending tasks during this shift
  const activeTasks = await prisma.workerTask.findMany({
    where: {
      userId: user.id,
      status: "PENDING",
    },
    include: {
      sku: true,
    },
    orderBy: [{ status: "asc" }, { priority: "desc" }],
  });

  // Get process configs
  const processConfigs = await getAllProcessConfigs();

  // Calculate total hours worked
  const totalMinutes = Math.round(
    (clockOutEvent.timestamp.getTime() - clockInEvent.timestamp.getTime()) /
      1000 /
      60
  );
  const workedMinutes = totalMinutes - breakMinutes;

  return {
    user,
    timeEntry,
    clockInEvent,
    clockOutEvent,
    activeTasks,
    processConfigs,
    breakMinutes,
    totalMinutes,
    workedMinutes,
    processTransitions: PROCESS_TRANSITIONS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();

  const timeEntryId = formData.get("timeEntryId") as string;
  const clockOutEventId = formData.get("clockOutEventId") as string;
  const clockOutTime = new Date(formData.get("clockOutTime") as string);
  const breakMinutes = parseInt(formData.get("breakMinutes") as string, 10);

  // Parse the lines from form data
  const linesJson = formData.get("linesJson") as string;
  const lines: Array<{
    processName: string;
    skuId?: string | null;
    quantityCompleted: number;
    secondsPerUnit: number;
    workerTaskId?: string | null;
    notes?: string | null;
  }> = JSON.parse(linesJson);

  // Filter out lines with 0 quantity
  const validLines = lines.filter((l) => l.quantityCompleted > 0);

  if (validLines.length === 0) {
    return { error: "Please enter at least one completed item" };
  }

  try {
    await submitTimeEntry(
      timeEntryId,
      clockOutEventId,
      clockOutTime,
      breakMinutes,
      validLines
    );

    return redirect("/worker-dashboard?submitted=true");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to submit" };
  }
};

interface LineEntry {
  processName: string;
  skuId: string | null;
  quantityCompleted: number;
  secondsPerUnit: number;
  workerTaskId: string | null;
  notes: string | null;
}

export default function ClockOutEntry() {
  const {
    user,
    timeEntry,
    clockInEvent,
    clockOutEvent,
    activeTasks,
    processConfigs,
    breakMinutes,
    totalMinutes,
    workedMinutes,
    processTransitions,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Initialize lines with one entry per process config
  const initialLines: LineEntry[] = processConfigs.map((config) => ({
    processName: config.processName,
    skuId: null,
    quantityCompleted: 0,
    secondsPerUnit: config.secondsPerUnit,
    workerTaskId: null,
    notes: null,
  }));

  const [lines, setLines] = useState<LineEntry[]>(initialLines);

  const updateLine = (index: number, field: keyof LineEntry, value: any) => {
    const newLines = [...lines];
    newLines[index] = { ...newLines[index], [field]: value };
    setLines(newLines);
  };

  // Calculate expected time
  const totalExpectedSeconds = lines.reduce(
    (sum, line) => sum + line.quantityCompleted * line.secondsPerUnit,
    0
  );
  const expectedMinutes = totalExpectedSeconds / 60;
  const efficiency =
    workedMinutes > 0 ? (expectedMinutes / workedMinutes) * 100 : 0;

  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatMinutes = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${m}m`;
  };

  const getEfficiencyColor = () => {
    if (efficiency >= 100) return "text-green-600 bg-green-50";
    if (efficiency >= 80) return "text-yellow-600 bg-yellow-50";
    return "text-red-600 bg-red-50";
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Clock Out - Enter Work Completed</h1>
        <p className="page-subtitle">
          Record what you accomplished during this shift
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}

      {/* Shift Summary */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Shift Summary</h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-gray-500">Clock In</div>
              <div className="text-xl font-semibold">
                {formatTime(clockInEvent.timestamp)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Clock Out</div>
              <div className="text-xl font-semibold">
                {formatTime(clockOutEvent.timestamp)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Break Time</div>
              <div className="text-xl font-semibold">
                {formatMinutes(breakMinutes)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Work Time</div>
              <div className="text-xl font-semibold">
                {formatMinutes(workedMinutes)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Form method="post">
        <input type="hidden" name="timeEntryId" value={timeEntry.id} />
        <input type="hidden" name="clockOutEventId" value={clockOutEvent.id} />
        <input
          type="hidden"
          name="clockOutTime"
          value={clockOutEvent.timestamp.toString()}
        />
        <input type="hidden" name="breakMinutes" value={breakMinutes} />
        <input type="hidden" name="linesJson" value={JSON.stringify(lines)} />

        {/* Work Entry */}
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Work Completed</h2>
            <p className="text-sm text-gray-500">
              Enter quantities for each process you worked on
            </p>
          </div>
          <div className="card-body">
            <div className="space-y-4">
              {lines.map((line, index) => {
                const config = processConfigs.find(
                  (c) => c.processName === line.processName
                );
                const transition = processTransitions[line.processName];

                return (
                  <div
                    key={line.processName}
                    className="p-4 rounded border bg-gray-50"
                  >
                    <div className="flex flex-col md:flex-row md:items-center gap-4">
                      <div className="flex-1">
                        <div className="font-semibold text-lg">
                          {config?.displayName || line.processName}
                        </div>
                        <div className="text-sm text-gray-500">
                          {config?.secondsPerUnit} seconds per unit
                          {transition && (
                            <span className="ml-2 text-xs">
                              ({transition.description})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="form-group mb-0">
                          <label className="form-label text-sm">Quantity</label>
                          <input
                            type="number"
                            value={line.quantityCompleted}
                            onChange={(e) =>
                              updateLine(
                                index,
                                "quantityCompleted",
                                parseInt(e.target.value, 10) || 0
                              )
                            }
                            className="form-input w-32 text-center text-lg"
                            min="0"
                            step="1"
                          />
                        </div>
                        {line.quantityCompleted > 0 && (
                          <div className="text-right">
                            <div className="text-sm text-gray-500">
                              Expected Time
                            </div>
                            <div className="font-medium">
                              {formatMinutes(
                                (line.quantityCompleted * line.secondsPerUnit) / 60
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Active Tasks Reference */}
        {activeTasks.length > 0 && (
          <div className="card mb-6">
            <div className="card-header">
              <h2 className="card-title">Your Assigned Tasks</h2>
              <p className="text-sm text-gray-500">Reference for what you were working on</p>
            </div>
            <div className="card-body">
              <div className="space-y-2">
                {activeTasks.map((task) => (
                  <div
                    key={task.id}
                    className="p-2 rounded border bg-gray-50 border-gray-200"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {processConfigs.find(
                          (p) => p.processName === task.processName
                        )?.displayName || task.processName}
                      </span>
                      {task.sku && (
                        <span className="text-sm text-gray-500 font-mono">
                          ({task.sku.sku})
                        </span>
                      )}
                      {task.targetQuantity && (
                        <span className="text-sm text-gray-500">
                          Target: {task.targetQuantity}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Efficiency Preview */}
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Efficiency Preview</h2>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-gray-500">Expected Time</div>
                <div className="text-xl font-semibold">
                  {formatMinutes(expectedMinutes)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500">Actual Time</div>
                <div className="text-xl font-semibold">
                  {formatMinutes(workedMinutes)}
                </div>
              </div>
              <div className="md:col-span-2">
                <div className="text-sm text-gray-500">Efficiency</div>
                <div
                  className={`text-3xl font-bold px-4 py-2 rounded inline-block ${getEfficiencyColor()}`}
                >
                  {efficiency.toFixed(0)}%
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  100% = completed work matches expected time
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="flex gap-3">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={isSubmitting || totalExpectedSeconds === 0}
          >
            {isSubmitting ? "Submitting..." : "Submit for Approval"}
          </button>
          <Link to="/worker-dashboard" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>

        <p className="text-sm text-gray-500 mt-3">
          Your entry will be reviewed by a manager before inventory is updated.
        </p>
      </Form>
    </Layout>
  );
}
