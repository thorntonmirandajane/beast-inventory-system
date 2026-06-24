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

  // Output SKUs a worker can report producing (assemblies + finished packs)
  const skus = await prisma.sku.findMany({
    where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
    select: { id: true, sku: true, name: true, type: true },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

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
    skus,
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
  const miscMinutesInput = parseInt(formData.get("miscMinutes") as string, 10);
  const miscMinutes = Number.isFinite(miscMinutesInput) && miscMinutesInput > 0 ? miscMinutesInput : 0;

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
      validLines,
      miscMinutes
    );

    return redirect("/worker-dashboard?submitted=true");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to submit" };
  }
};

interface StagedLine {
  id: string;
  processName: string;
  processDisplayName: string;
  skuId: string;
  skuLabel: string;
  quantityCompleted: number;
  secondsPerUnit: number;
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
    workedMinutes,
    skus,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Staged lines: one per (process + SKU + qty) the worker completed.
  const [staged, setStaged] = useState<StagedLine[]>([]);
  const [proc, setProc] = useState("");
  const [skuId, setSkuId] = useState("");
  const [qty, setQty] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const addLine = () => {
    if (!proc) return setFormError("Pick a process.");
    if (!skuId) return setFormError("Pick the SKU you completed.");
    const q = parseInt(qty, 10);
    if (!q || q <= 0) return setFormError("Enter a quantity greater than 0.");
    const config = processConfigs.find((c) => c.processName === proc);
    const sku = skus.find((s) => s.id === skuId);
    setStaged([
      ...staged,
      {
        id: crypto.randomUUID(),
        processName: proc,
        processDisplayName: config?.displayName || proc,
        skuId,
        skuLabel: sku ? `${sku.sku} — ${sku.name}` : skuId,
        quantityCompleted: q,
        secondsPerUnit: config?.secondsPerUnit || 60,
      },
    ]);
    setFormError(null);
    setSkuId("");
    setQty("");
  };

  const removeLine = (id: string) =>
    setStaged(staged.filter((s) => s.id !== id));

  const linesJson = JSON.stringify(
    staged.map((s) => ({
      processName: s.processName,
      skuId: s.skuId,
      quantityCompleted: s.quantityCompleted,
      secondsPerUnit: s.secondsPerUnit,
    }))
  );

  const totalExpectedSeconds = staged.reduce(
    (sum, l) => sum + l.quantityCompleted * l.secondsPerUnit,
    0
  );
  const expectedMinutes = totalExpectedSeconds / 60;
  const efficiency =
    workedMinutes > 0 ? (expectedMinutes / workedMinutes) * 100 : 0;

  const formatTime = (date: Date | string) =>
    new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
        <h1 className="page-title">Clock Out — Log What You Completed</h1>
        <p className="page-subtitle">
          Add each item you finished (process + SKU + quantity), then submit for QC.
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
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
              <div className="text-xl font-semibold">{formatTime(clockInEvent.timestamp)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Clock Out</div>
              <div className="text-xl font-semibold">{formatTime(clockOutEvent.timestamp)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Break Time</div>
              <div className="text-xl font-semibold">{formatMinutes(breakMinutes)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Work Time</div>
              <div className="text-xl font-semibold">{formatMinutes(workedMinutes)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Add a completed item */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Add Completed Work</h2>
        </div>
        <div className="card-body">
          {formError && <div className="alert alert-error mb-4">{formError}</div>}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div className="form-group mb-0">
              <label htmlFor="proc" className="form-label text-sm">Process</label>
              <select
                id="proc"
                value={proc}
                onChange={(e) => setProc(e.target.value)}
                className="form-input"
              >
                <option value="">Select…</option>
                {processConfigs.map((c) => (
                  <option key={c.processName} value={c.processName}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group mb-0 md:col-span-2">
              <label htmlFor="sku" className="form-label text-sm">SKU completed</label>
              <select
                id="sku"
                value={skuId}
                onChange={(e) => setSkuId(e.target.value)}
                className="form-input"
              >
                <option value="">Select…</option>
                {skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.sku} — {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group mb-0">
              <label htmlFor="qty" className="form-label text-sm">Quantity</label>
              <input
                id="qty"
                type="number"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="form-input text-center text-lg"
                min="1"
                step="1"
              />
            </div>
          </div>
          <button type="button" onClick={addLine} className="btn btn-secondary mt-4">
            + Add item
          </button>
        </div>
      </div>

      {/* Staged items */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Items to Submit ({staged.length})</h2>
        </div>
        <div className="card-body">
          {staged.length === 0 ? (
            <p className="text-sm text-gray-500">
              No items added yet. Add what you completed above.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Process</th>
                  <th className="py-2 pr-4">SKU</th>
                  <th className="py-2 pr-4 text-right">Qty</th>
                  <th className="py-2 pr-4 text-right">Expected</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {staged.map((l) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{l.processDisplayName}</td>
                    <td className="py-2 pr-4 font-mono">{l.skuLabel}</td>
                    <td className="py-2 pr-4 text-right">{l.quantityCompleted}</td>
                    <td className="py-2 pr-4 text-right">
                      {formatMinutes((l.quantityCompleted * l.secondsPerUnit) / 60)}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(l.id)}
                        className="btn btn-ghost btn-sm text-red-600"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
                <div key={task.id} className="p-2 rounded border bg-gray-50 border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {processConfigs.find((p) => p.processName === task.processName)?.displayName ||
                        task.processName}
                    </span>
                    {task.sku && (
                      <span className="text-sm text-gray-500 font-mono">({task.sku.sku})</span>
                    )}
                    {task.targetQuantity && (
                      <span className="text-sm text-gray-500">Target: {task.targetQuantity}</span>
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
              <div className="text-xl font-semibold">{formatMinutes(expectedMinutes)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Actual Time</div>
              <div className="text-xl font-semibold">{formatMinutes(workedMinutes)}</div>
            </div>
            <div className="md:col-span-2">
              <div className="text-sm text-gray-500">Efficiency</div>
              <div
                className={`text-3xl font-bold px-4 py-2 rounded inline-block ${getEfficiencyColor()}`}
              >
                {efficiency.toFixed(0)}%
              </div>
              <p className="text-xs text-gray-500 mt-1">Estimate — subject to QC review.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Submit */}
      <Form method="post">
        <input type="hidden" name="timeEntryId" value={timeEntry.id} />
        <input type="hidden" name="clockOutEventId" value={clockOutEvent.id} />
        <input type="hidden" name="clockOutTime" value={clockOutEvent.timestamp.toString()} />
        <input type="hidden" name="breakMinutes" value={breakMinutes} />
        <input type="hidden" name="linesJson" value={linesJson} />
        <div className="form-group mb-4 max-w-xs">
          <label htmlFor="miscMinutes" className="form-label">Misc time (minutes)</label>
          <input
            id="miscMinutes"
            type="number"
            name="miscMinutes"
            step="1"
            min="0"
            defaultValue="0"
            inputMode="numeric"
            className="form-input"
          />
          <p className="text-xs text-gray-500 mt-1">
            Minutes pulled off for other projects — doesn't count against your efficiency.
            Subject to manager approval; only approved misc time will be accepted.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={isSubmitting || staged.length === 0}
          >
            {isSubmitting ? "Submitting…" : "Submit for QC"}
          </button>
          <Link to="/worker-dashboard" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>
        <p className="text-sm text-gray-500 mt-3">
          Your entry will be reviewed by QC before inventory is updated.
        </p>
      </Form>
    </Layout>
  );
}
