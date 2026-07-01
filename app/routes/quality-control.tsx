import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link, useFetcher, redirect } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { ImageUpload } from "../components/ImageUpload";
import prisma from "../db.server";
import { approveTimeEntry, trackableEfficiency } from "../utils/productivity.server";
import { matchesProcess } from "../utils/process";
import { useState, useEffect } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") || "pending";
  const entryId = url.searchParams.get("entryId");

  if (entryId) {
    // Detail view - single time entry
    const timeEntry = await prisma.workerTimeEntry.findUnique({
      where: { id: entryId },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        lines: {
          include: { sku: true, workerTask: true },
          orderBy: { createdAt: "asc" },
        },
        clockInEvent: true,
        clockOutEvent: true,
      },
    });

    // Get process configs (display names + seconds/unit) and assignable SKUs
    // for the in-review "Add Task" form.
    const processConfigs = await prisma.processConfig.findMany({
      where: { isActive: true },
      select: { processName: true, displayName: true, secondsPerUnit: true },
      orderBy: { displayName: "asc" },
    });
    const assignableSkus = await prisma.sku.findMany({
      where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } },
      select: { id: true, sku: true, name: true, material: true },
      orderBy: [{ type: "asc" }, { sku: "asc" }],
    });

    // Preview of what inventory WILL change on approval: each accepted line
    // produces its output SKU and consumes its immediate BOM children. Wrapped
    // so a preview hiccup can never break the review page.
    let movementPreview: {
      output: { sku: string; name: string; qty: number };
      consumes: { sku: string; name: string; qty: number }[];
    }[] = [];
    try {
      if (timeEntry) {
        const lineSkuIds = [
          ...new Set(
            timeEntry.lines.filter((l) => !l.isMisc && l.skuId).map((l) => l.skuId as string)
          ),
        ];
        const boms = await prisma.bomComponent.findMany({
          where: { parentSkuId: { in: lineSkuIds } },
          include: { componentSku: { select: { sku: true, name: true } } },
        });
        const bomByParent = new Map<string, typeof boms>();
        for (const b of boms) {
          const arr = bomByParent.get(b.parentSkuId) ?? [];
          arr.push(b);
          bomByParent.set(b.parentSkuId, arr);
        }
        for (const line of timeEntry.lines) {
          if (line.isMisc || !line.skuId || !line.sku) continue;
          const base = line.adminAdjustedQuantity ?? line.quantityCompleted;
          const rejected = line.isRejected ? base : line.rejectionQuantity ?? 0;
          const accepted = base - rejected;
          if (accepted <= 0) continue;
          const children = bomByParent.get(line.skuId) ?? [];
          movementPreview.push({
            output: { sku: line.sku.sku, name: line.sku.name, qty: accepted },
            consumes: children.map((c) => ({
              sku: c.componentSku.sku,
              name: c.componentSku.name,
              qty: c.quantity * accepted,
            })),
          });
        }
      }
    } catch (e) {
      console.error("[QC] movement preview failed:", e);
      movementPreview = [];
    }

    return { user, timeEntry, tab, entryId, timeEntries: null, processConfigs, assignableSkus, justApproved: false, movementPreview };
  }

  // List view
  let timeEntries;

  if (tab === "pending") {
    timeEntries = await prisma.workerTimeEntry.findMany({
      where: { status: "PENDING" },
      include: {
        user: { select: { firstName: true, lastName: true } },
        lines: { include: { sku: true } },
      },
      orderBy: { clockOutTime: "desc" },
    });
  } else if (tab === "approved") {
    // Last 30 days of approved entries
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    timeEntries = await prisma.workerTimeEntry.findMany({
      where: {
        status: "APPROVED",
        clockOutTime: { gte: thirtyDaysAgo },
      },
      include: {
        user: { select: { firstName: true, lastName: true } },
        lines: { include: { sku: true } },
      },
      orderBy: { clockOutTime: "desc" },
    });
  } else if (tab === "rejected") {
    // Entries with rejected lines
    timeEntries = await prisma.workerTimeEntry.findMany({
      where: {
        lines: {
          some: { isRejected: true },
        },
      },
      include: {
        user: { select: { firstName: true, lastName: true } },
        lines: { include: { sku: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }

  // Get process configs for display names
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { processName: true, displayName: true, secondsPerUnit: true },
    orderBy: { displayName: "asc" },
  });

  // Check if we just approved an entry
  const justApproved = url.searchParams.get("approved") === "true";

  return { user, timeEntries, tab, entryId: null, timeEntry: null, processConfigs, assignableSkus: [], justApproved, movementPreview: [] };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "reject-task") {
    const lineId = formData.get("lineId") as string;
    const rejectionReason = formData.get("rejectionReason") as string;
    const rejectionQuantityStr = formData.get("rejectionQuantity") as string;
    const rejectionQuantity = parseInt(rejectionQuantityStr, 10);
    const photoUrl = formData.get("photoUrl") as string;

    if (!lineId || !rejectionReason || isNaN(rejectionQuantity)) {
      return { error: "Missing required fields" };
    }

    // Update the specific TimeEntryLine
    await prisma.timeEntryLine.update({
      where: { id: lineId },
      data: {
        isRejected: true,
        rejectionReason,
        rejectionQuantity,
        adminNotes: `Rejected ${rejectionQuantity} units. Reason: ${rejectionReason}${photoUrl ? ` [Photo: ${photoUrl}]` : ""}`,
      },
    });

    await createAuditLog(user.id, "REJECT_TASK", "TimeEntryLine", lineId, {
      rejectionReason,
      rejectionQuantity,
      photoUrl: photoUrl || null,
    });

    return { success: true, message: "Task rejected" };
  }

  if (intent === "adjust-quantity") {
    const lineId = formData.get("lineId") as string;
    const newQuantityStr = formData.get("quantity") as string;
    const newQuantity = parseInt(newQuantityStr, 10);
    const adminNotes = formData.get("adminNotes") as string;

    if (!lineId || isNaN(newQuantity)) {
      return { error: "Invalid data" };
    }

    await prisma.timeEntryLine.update({
      where: { id: lineId },
      data: {
        adminAdjustedQuantity: newQuantity,
        adminNotes,
      },
    });

    await createAuditLog(user.id, "ADJUST_QUANTITY", "TimeEntryLine", lineId, {
      newQuantity,
      adminNotes,
    });

    return { success: true, message: "Quantity adjusted" };
  }

  if (intent === "approve-entry") {
    const entryId = formData.get("entryId") as string;

    const result = await approveTimeEntry(entryId, user.id);

    if (!result.success) {
      return { error: result.error };
    }

    // Return (don't redirect) so the engine's stock warnings reach the user.
    // React Router revalidates the loader, so the approved entry leaves the
    // pending list on its own.
    const warnings = result.warnings ?? [];
    return {
      success: true,
      message:
        warnings.length > 0
          ? `Approved — inventory updated, with ${warnings.length} stock warning${warnings.length === 1 ? "" : "s"} (see below).`
          : "Approved — inventory updated.",
      warnings,
    };
  }

  if (intent === "add-line") {
    const entryId = formData.get("entryId") as string;
    const processName = formData.get("processName") as string;
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    const secondsPerUnit = parseInt(formData.get("secondsPerUnit") as string, 10) || 0;

    if (!entryId || !processName || !skuId || !quantity || quantity <= 0) {
      return { error: "Pick a process and SKU and enter a quantity greater than 0." };
    }

    await prisma.timeEntryLine.create({
      data: {
        timeEntryId: entryId,
        processName,
        skuId,
        quantityCompleted: quantity,
        secondsPerUnit,
        expectedSeconds: quantity * secondsPerUnit,
      },
    });

    // Recompute expected/efficiency, and re-open the entry to PENDING so the new
    // task gets QC-approved (which is what moves its inventory).
    const entry = await prisma.workerTimeEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (entry) {
      const expectedMinutes = entry.lines.reduce((s, l) => s + l.expectedSeconds, 0) / 60;
      const efficiency = trackableEfficiency(expectedMinutes, entry.actualMinutes, entry.miscMinutes);
      await prisma.workerTimeEntry.update({
        where: { id: entryId },
        data: { expectedMinutes, efficiency, status: "PENDING", approvedById: null, approvedAt: null },
      });
    }

    await createAuditLog(user.id, "QC_ADD_LINE", "WorkerTimeEntry", entryId, { processName, skuId, quantity });
    return { success: true, message: "Task added — entry is pending approval." };
  }

  if (intent === "delete-line") {
    const lineId = formData.get("lineId") as string;
    const entryId = formData.get("entryId") as string;
    const line = await prisma.timeEntryLine.findUnique({ where: { id: lineId } });
    if (!line) return { error: "Task line not found." };
    await prisma.timeEntryLine.delete({ where: { id: lineId } });

    // Recompute expected/efficiency from the remaining lines.
    const entry = await prisma.workerTimeEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (entry) {
      const expectedMinutes = entry.lines.reduce((s, l) => s + l.expectedSeconds, 0) / 60;
      const efficiency = trackableEfficiency(expectedMinutes, entry.actualMinutes, entry.miscMinutes);
      await prisma.workerTimeEntry.update({ where: { id: entryId }, data: { expectedMinutes, efficiency } });
    }
    await createAuditLog(user.id, "QC_DELETE_LINE", "WorkerTimeEntry", entryId, { lineId, processName: line.processName });
    return { success: true, message: "Task removed from this entry." };
  }

  if (intent === "edit-times") {
    const entryId = formData.get("entryId") as string;
    const dateStr = formData.get("date") as string;
    const inStr = formData.get("clockInTime") as string;
    const outStr = formData.get("clockOutTime") as string;
    const breakMinutes = parseInt(formData.get("breakMinutes") as string, 10) || 0;
    if (!entryId || !dateStr || !inStr || !outStr) return { error: "Date, clock-in and clock-out are required." };
    const clockIn = new Date(`${dateStr}T${inStr}`);
    const clockOut = new Date(`${dateStr}T${outStr}`);
    if (clockOut <= clockIn) return { error: "Clock-out must be after clock-in." };
    if (breakMinutes < 0) return { error: "Break minutes must be 0 or more." };
    const actualMinutes = Math.floor((clockOut.getTime() - clockIn.getTime()) / 60000) - breakMinutes;
    if (actualMinutes <= 0) return { error: "Working time must be positive (check the break)." };

    const entry = await prisma.workerTimeEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (!entry) return { error: "Entry not found." };
    const expectedMinutes = entry.expectedMinutes ?? entry.lines.reduce((s, l) => s + l.expectedSeconds, 0) / 60;
    const efficiency = trackableEfficiency(expectedMinutes, actualMinutes, entry.miscMinutes);
    await prisma.workerTimeEntry.update({
      where: { id: entryId },
      data: { clockInTime: clockIn, clockOutTime: clockOut, breakMinutes, actualMinutes, efficiency },
    });
    // Keep the linked clock events in sync.
    if (entry.clockInEventId) await prisma.clockEvent.update({ where: { id: entry.clockInEventId }, data: { timestamp: clockIn } }).catch(() => {});
    if (entry.clockOutEventId) await prisma.clockEvent.update({ where: { id: entry.clockOutEventId }, data: { timestamp: clockOut } }).catch(() => {});
    await createAuditLog(user.id, "EDIT_TIME_ENTRY_TIMES", "WorkerTimeEntry", entryId, { clockIn, clockOut, breakMinutes, actualMinutes });
    return { success: true, message: "Shift times updated." };
  }

  if (intent === "set-misc") {
    const entryId = formData.get("entryId") as string;
    const miscMinutes = parseInt(formData.get("miscMinutes") as string, 10);
    if (!entryId || isNaN(miscMinutes) || miscMinutes < 0) {
      return { error: "Enter misc minutes of 0 or more." };
    }
    const entry = await prisma.workerTimeEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!entry) return { error: "Entry not found." };

    const expectedMinutes = entry.lines.reduce((s, l) => s + l.expectedSeconds, 0) / 60;
    const efficiency = trackableEfficiency(expectedMinutes, entry.actualMinutes, miscMinutes);
    await prisma.workerTimeEntry.update({
      where: { id: entryId },
      data: { miscMinutes, efficiency },
    });
    await createAuditLog(user.id, "SET_MISC_TIME", "WorkerTimeEntry", entryId, { miscMinutes });
    return { success: true, message: `Misc time set to ${miscMinutes} min.` };
  }

  if (intent === "reopen-pending") {
    const entryId = formData.get("entryId") as string;
    const entry = await prisma.workerTimeEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!entry) return { error: "Entry not found." };
    if (entry.lines.length > 0) {
      return { error: "This entry already has tasks — reopening could double-move inventory. Reject it instead if needed." };
    }
    await prisma.workerTimeEntry.update({
      where: { id: entryId },
      data: { status: "PENDING", approvedById: null, approvedAt: null },
    });
    await createAuditLog(user.id, "REOPEN_TIME_ENTRY", "WorkerTimeEntry", entryId, {});
    return { success: true, message: "Re-opened to pending — add tasks and misc time, then approve." };
  }

  if (intent === "delete-entry") {
    const entryId = formData.get("entryId") as string;
    const entry = await prisma.workerTimeEntry.findUnique({
      where: { id: entryId },
      select: { clockInEventId: true, clockOutEventId: true },
    });
    if (!entry) return { error: "Entry not found." };

    await prisma.$transaction(async (tx) => {
      await tx.workerTimeEntry.delete({ where: { id: entryId } }); // cascades its lines
      if (entry.clockOutEventId) await tx.clockEvent.delete({ where: { id: entry.clockOutEventId } });
      await tx.clockEvent.delete({ where: { id: entry.clockInEventId } });
    });

    await createAuditLog(user.id, "DELETE_TIME_ENTRY", "WorkerTimeEntry", entryId, {});
    throw redirect(`/quality-control?tab=${formData.get("tab") || "pending"}`);
  }

  return { error: "Unknown intent" };
};

function EditableQuantityCell({
  lineId,
  initialQuantity,
  adjustedQuantity,
}: {
  lineId: string;
  initialQuantity: number;
  adjustedQuantity: number | null;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(adjustedQuantity || initialQuantity);
  const [notes, setNotes] = useState("");
  const fetcher = useFetcher();

  const handleSave = () => {
    fetcher.submit(
      {
        intent: "adjust-quantity",
        lineId,
        quantity: value.toString(),
        adminNotes: notes,
      },
      { method: "post" }
    );
    // Don't close here — wait for the server to confirm (see effect below),
    // so a failed save stays open with its error instead of silently vanishing.
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setIsEditing(false);
    }
  }, [fetcher.state, fetcher.data]);

  const saving = fetcher.state !== "idle";

  if (isEditing) {
    return (
      <div className="space-y-2">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(parseInt(e.target.value, 10))}
          className="form-input w-20"
          autoFocus
        />
        <textarea
          placeholder="Reason for adjustment..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="form-input w-full text-sm"
          rows={2}
        />
        {fetcher.data?.error && (
          <div className="text-sm text-red-600">{fetcher.data.error}</div>
        )}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving} className="btn btn-primary btn-sm">
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setIsEditing(false)} disabled={saving} className="btn btn-ghost btn-sm">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => setIsEditing(true)}
      className="cursor-pointer hover:bg-gray-100 p-2 rounded inline-block"
      title="Click to edit"
    >
      <span className={adjustedQuantity ? "font-bold text-yellow-600" : ""}>
        {adjustedQuantity || initialQuantity}
      </span>
      {adjustedQuantity && (
        <span className="text-xs text-gray-500 ml-2">(was {initialQuantity})</span>
      )}
    </div>
  );
}

function RejectTaskModal({
  line,
  onClose,
  processDisplayName,
}: {
  line: any;
  onClose: () => void;
  processDisplayName: string;
}) {
  const fetcher = useFetcher();
  const [rejectionQuantity, setRejectionQuantity] = useState(line.quantityCompleted);
  const [reason, setReason] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(
      {
        intent: "reject-task",
        lineId: line.id,
        rejectionQuantity: rejectionQuantity.toString(),
        rejectionReason: reason,
        photoUrl,
      },
      { method: "post" }
    );
    // Close only after the server confirms (effect below), so a failed reject
    // doesn't disappear silently.
  };

  const rejecting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <h3 className="text-lg font-bold mb-4">Reject Task</h3>
        <div className="mb-4 text-sm">
          <p>
            <strong>Process:</strong> {processDisplayName}
          </p>
          {line.sku && (
            <p>
              <strong>SKU:</strong> {line.sku.sku} - {line.sku.name}
            </p>
          )}
          <p>
            <strong>Submitted Quantity:</strong> {line.quantityCompleted}
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group mb-4">
            <label className="form-label">Rejection Quantity</label>
            <input
              type="number"
              min="1"
              max={line.quantityCompleted}
              value={rejectionQuantity}
              onChange={(e) => setRejectionQuantity(parseInt(e.target.value, 10))}
              className="form-input"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Enter how many units to reject (max: {line.quantityCompleted})
            </p>
          </div>

          <div className="form-group mb-4">
            <label className="form-label">Rejection Reason *</label>
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this task is being rejected..."
              className="form-input"
              rows={4}
            />
          </div>

          <div className="form-group mb-4">
            <ImageUpload
              currentImageUrl={photoUrl}
              onImageUploaded={(url) => setPhotoUrl(url)}
              folder="quality-control"
              label="Quality Issue Photo (Optional)"
              helpText="Upload a photo showing the quality issue"
            />
          </div>

          {fetcher.data?.error && (
            <div className="alert alert-error mb-4">{fetcher.data.error}</div>
          )}
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={!reason.trim() || rejecting}
              className="btn btn-error flex-1"
            >
              {rejecting ? "Rejecting…" : "Reject Task"}
            </button>
            <button type="button" onClick={onClose} disabled={rejecting} className="btn btn-ghost flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditTimesForm({
  timeEntry,
}: {
  timeEntry: { id: string; clockInTime: string | Date; clockOutTime: string | Date | null; breakMinutes: number };
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  const pad = (n: number) => String(n).padStart(2, "0");
  const ci = new Date(timeEntry.clockInTime);
  const co = timeEntry.clockOutTime ? new Date(timeEntry.clockOutTime) : null;
  const dateVal = `${ci.getFullYear()}-${pad(ci.getMonth() + 1)}-${pad(ci.getDate())}`;
  const inVal = `${pad(ci.getHours())}:${pad(ci.getMinutes())}`;
  const outVal = co ? `${pad(co.getHours())}:${pad(co.getMinutes())}` : "";

  return (
    <details className="mt-4 border-t pt-3">
      <summary className="text-sm text-blue-600 cursor-pointer">Adjust shift times</summary>
      {fetcher.data?.error && <div className="alert alert-error my-2 text-sm">{fetcher.data.error}</div>}
      <fetcher.Form method="post" className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end mt-3">
        <input type="hidden" name="intent" value="edit-times" />
        <input type="hidden" name="entryId" value={timeEntry.id} />
        <div className="form-group mb-0">
          <label className="form-label text-sm">Date</label>
          <input type="date" name="date" defaultValue={dateVal} className="form-input" required />
        </div>
        <div className="form-group mb-0">
          <label className="form-label text-sm">Clock In</label>
          <input type="time" name="clockInTime" defaultValue={inVal} className="form-input" required />
        </div>
        <div className="form-group mb-0">
          <label className="form-label text-sm">Clock Out</label>
          <input type="time" name="clockOutTime" defaultValue={outVal} className="form-input" required />
        </div>
        <div className="form-group mb-0">
          <label className="form-label text-sm">Break (min)</label>
          <input type="number" name="breakMinutes" min="0" defaultValue={timeEntry.breakMinutes ?? 0} className="form-input" />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={busy}>{busy ? "Saving…" : "Save times"}</button>
      </fetcher.Form>
    </details>
  );
}

function AddTaskForm({
  entryId,
  processConfigs,
  skus,
}: {
  entryId: string;
  processConfigs: { processName: string; displayName: string; secondsPerUnit: number }[];
  skus: { id: string; sku: string; name: string; material: string | null }[];
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [proc, setProc] = useState("");
  const [skuId, setSkuId] = useState("");
  const [qty, setQty] = useState("");
  const cfg = processConfigs.find((p) => p.processName === proc);
  const filtered = cfg ? skus.filter((s) => matchesProcess(s.material, cfg.displayName)) : [];
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setSkuId("");
      setQty("");
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="card mt-6">
      <div className="card-header">
        <h3 className="card-title">Add a Task</h3>
        <p className="text-sm text-gray-500">
          Adds production to this entry and sends it back to pending so approving it moves inventory.
        </p>
      </div>
      <div className="card-body">
        {fetcher.data?.error && <div className="alert alert-error mb-4">{fetcher.data.error}</div>}
        <fetcher.Form method="post" className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <input type="hidden" name="intent" value="add-line" />
          <input type="hidden" name="entryId" value={entryId} />
          <input type="hidden" name="secondsPerUnit" value={cfg?.secondsPerUnit ?? 0} />
          <div className="form-group mb-0">
            <label className="form-label text-sm">Process</label>
            <select
              name="processName"
              value={proc}
              onChange={(e) => { setProc(e.target.value); setSkuId(""); }}
              className="form-input"
              required
            >
              <option value="">Select…</option>
              {processConfigs.map((p) => (
                <option key={p.processName} value={p.processName}>{p.displayName}</option>
              ))}
            </select>
          </div>
          <div className="form-group mb-0 md:col-span-2">
            <label className="form-label text-sm">SKU completed</label>
            <select
              name="skuId"
              value={skuId}
              onChange={(e) => setSkuId(e.target.value)}
              className="form-input"
              required
              disabled={!proc}
            >
              <option value="">{proc ? "Select…" : "Pick a process first"}</option>
              {filtered.map((s) => (
                <option key={s.id} value={s.id}>{s.sku} — {s.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group mb-0">
            <label className="form-label text-sm">Quantity</label>
            <input
              type="number"
              name="quantity"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              min="1"
              className="form-input text-center"
              required
            />
          </div>
          <div className="md:col-span-4">
            <button type="submit" className="btn btn-secondary" disabled={busy || !proc || !skuId || !qty}>
              {busy ? "Adding…" : "+ Add Task"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

function MiscTimeForm({ entryId, miscMinutes }: { entryId: string; miscMinutes: number }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post" className="flex items-center gap-2 mt-1">
      <input type="hidden" name="intent" value="set-misc" />
      <input type="hidden" name="entryId" value={entryId} />
      <input
        type="number"
        name="miscMinutes"
        step="1"
        min="0"
        defaultValue={miscMinutes}
        className="form-input w-20 py-1 text-sm"
      />
      <button type="submit" className="btn btn-sm btn-secondary" disabled={busy}>
        {busy ? "…" : "Save"}
      </button>
    </fetcher.Form>
  );
}

export default function QualityControl() {
  const { user, timeEntries, timeEntry, tab, entryId, processConfigs, assignableSkus, justApproved, movementPreview } = useLoaderData<typeof loader>();
  const overallEff =
    timeEntry && timeEntry.expectedMinutes != null && timeEntry.actualMinutes
      ? (timeEntry.expectedMinutes / timeEntry.actualMinutes) * 100
      : null;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [rejectModalLine, setRejectModalLine] = useState<any>(null);

  const getProcessDisplay = (processName: string) => {
    if (!processConfigs) return processName.replace(/_/g, " ");
    return (
      processConfigs.find((p) => p.processName === processName)?.displayName ||
      processName.replace(/_/g, " ")
    );
  };

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDateTime = (date: Date | string) => {
    return new Date(date).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getEfficiencyBadge = (efficiency: number) => {
    if (efficiency >= 90) return "badge-success";
    if (efficiency >= 70) return "badge-warning";
    return "badge-error";
  };

  return (
    <Layout user={user}>
      {entryId && timeEntry ? (
        // Detail View
        <div>
          <div className="page-header">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="page-title">Review Time Entry</h1>
                <p className="page-subtitle">
                  {timeEntry.user.firstName} {timeEntry.user.lastName} •{" "}
                  {formatDate(timeEntry.clockInTime)}
                </p>
              </div>
              <Link to={`/quality-control?tab=${tab}`} className="btn btn-ghost">
                ← Back to List
              </Link>
            </div>
          </div>

          {actionData?.error && (
            <div className="alert alert-error mb-6">{actionData.error}</div>
          )}
          {actionData?.success && (
            <div className="alert alert-success mb-6">{actionData.message}</div>
          )}
          {actionData?.warnings && actionData.warnings.length > 0 && (
            <div className="alert alert-warning mb-6">
              <strong>Stock warnings</strong> — these components went negative (counts may be
              off or not loaded yet):
              <ul className="mt-1 list-disc list-inside text-sm">
                {actionData.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {timeEntry.status !== "PENDING" && timeEntry.lines.length === 0 && (
            <div className="alert alert-warning mb-6 flex items-center justify-between gap-4">
              <span>
                Imported time with no tasks yet (status: <strong>{timeEntry.status}</strong>). Re-open it to add
                the worker's tasks and misc time, then approve.
              </span>
              <Form method="post">
                <input type="hidden" name="intent" value="reopen-pending" />
                <input type="hidden" name="entryId" value={timeEntry.id} />
                <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>Reopen to Pending</button>
              </Form>
            </div>
          )}

          {/* Shift Summary */}
          <div className="card mb-6">
            <div className="card-header">
              <h3 className="card-title">Shift Summary</h3>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-600">Worker</label>
                  <p className="font-medium">{timeEntry.user.firstName} {timeEntry.user.lastName}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Clock In</label>
                  <p className="font-medium">{formatDateTime(timeEntry.clockInTime)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Clock Out</label>
                  <p className="font-medium">{timeEntry.clockOutTime ? formatDateTime(timeEntry.clockOutTime) : "—"}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Total Hours</label>
                  <p className="font-medium">{timeEntry.actualMinutes != null ? `${(timeEntry.actualMinutes / 60).toFixed(2)}h` : "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 items-end">
                <div>
                  <label className="text-sm font-medium text-gray-600">Misc Time (min)</label>
                  <p className="text-xs text-gray-500">Pulled off — excluded from efficiency. Only approved misc time is accepted.</p>
                  <MiscTimeForm entryId={timeEntry.id} miscMinutes={timeEntry.miscMinutes} />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Trackable Hours</label>
                  <p className="font-medium">
                    {timeEntry.actualMinutes != null
                      ? `${((timeEntry.actualMinutes - timeEntry.miscMinutes) / 60).toFixed(2)}h`
                      : "—"}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Expected Hours</label>
                  <p className="font-medium">
                    {timeEntry.expectedMinutes != null ? `${(timeEntry.expectedMinutes / 60).toFixed(2)}h` : "—"}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Efficiency</label>
                  <p className="font-medium">
                    {timeEntry.efficiency != null ? (
                      <span
                        className={
                          timeEntry.efficiency >= 90
                            ? "text-green-600"
                            : timeEntry.efficiency >= 70
                            ? "text-yellow-600"
                            : "text-red-600"
                        }
                      >
                        {timeEntry.efficiency.toFixed(0)}% trackable
                      </span>
                    ) : (
                      "—"
                    )}
                  </p>
                  {overallEff != null && (
                    <p className="text-sm text-gray-500">{overallEff.toFixed(0)}% overall</p>
                  )}
                </div>
              </div>

              <EditTimesForm timeEntry={timeEntry} />
            </div>
          </div>

          {/* Task Details Table */}
          <div className="card mb-6">
            <div className="card-header">
              <h3 className="card-title">Tasks Submitted</h3>
            </div>
            <div className="card-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Process</th>
                    <th>SKU</th>
                    <th>Submitted Qty</th>
                    <th>Adjusted Qty</th>
                    <th>Expected Time</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {timeEntry.lines.map((line) => (
                    <tr key={line.id} className={line.isRejected ? "bg-red-50" : ""}>
                      <td className="font-medium">
                        {getProcessDisplay(line.processName)}
                      </td>
                      <td>
                        {line.isMisc ? (
                          <div>
                            <span className="text-gray-500">Miscellaneous</span>
                            {line.miscDescription && (
                              <p className="text-xs text-gray-500">{line.miscDescription}</p>
                            )}
                          </div>
                        ) : line.sku ? (
                          <div>
                            <Link to={`/skus/${line.skuId}`} className="text-blue-600 hover:underline">
                              {line.sku.sku}
                            </Link>
                            <p className="text-xs text-gray-500">{line.sku.name}</p>
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right">{line.quantityCompleted}</td>
                      <td className="text-right">
                        {timeEntry.status === "PENDING" && !line.isRejected ? (
                          <EditableQuantityCell
                            lineId={line.id}
                            initialQuantity={line.quantityCompleted}
                            adjustedQuantity={line.adminAdjustedQuantity}
                          />
                        ) : line.adminAdjustedQuantity ? (
                          <span className="text-yellow-600 font-medium">
                            {line.adminAdjustedQuantity}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="text-right">{(line.expectedSeconds / 60).toFixed(1)} min</td>
                      <td>
                        {line.isRejected ? (
                          <span className="badge badge-error">
                            Rejected ({line.rejectionQuantity} units)
                          </span>
                        ) : line.adminAdjustedQuantity ? (
                          <span className="badge badge-warning">Adjusted</span>
                        ) : (
                          <span className="badge badge-success">OK</span>
                        )}
                      </td>
                      <td>
                        {timeEntry.status === "PENDING" && (
                          <div className="flex gap-2">
                            {!line.isRejected && (
                              <button
                                onClick={() => setRejectModalLine(line)}
                                className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
                              >
                                Reject
                              </button>
                            )}
                            <Form
                              method="post"
                              onSubmit={(e) => {
                                if (!confirm("Delete this task line? Use this if the wrong item was selected.")) e.preventDefault();
                              }}
                            >
                              <input type="hidden" name="intent" value="delete-line" />
                              <input type="hidden" name="lineId" value={line.id} />
                              <input type="hidden" name="entryId" value={timeEntry.id} />
                              <button type="submit" className="btn btn-sm btn-secondary">Delete</button>
                            </Form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Admin Notes */}
              {timeEntry.lines.some((line) => line.adminNotes) && (
                <div className="mt-6">
                  <h4 className="font-medium mb-2">Admin Notes:</h4>
                  {timeEntry.lines.map(
                    (line) =>
                      line.adminNotes && (
                        <div key={line.id} className="p-3 bg-yellow-50 border border-yellow-200 rounded mb-2">
                          <strong>
                            {getProcessDisplay(line.processName)} - {line.sku?.sku || "MISC"}:
                          </strong>
                          <p className="text-sm mt-1">{line.adminNotes}</p>
                        </div>
                      )
                  )}
                </div>
              )}

              <AddTaskForm entryId={timeEntry.id} processConfigs={processConfigs} skus={assignableSkus} />

              {timeEntry.status === "PENDING" && movementPreview.length > 0 && (
                <div className="card mt-6">
                  <div className="card-header">
                    <h3 className="card-title">On approval, inventory will change</h3>
                  </div>
                  <div className="card-body space-y-3 text-sm">
                    {movementPreview.map((m, i) => (
                      <div key={i} className="border-b last:border-0 pb-2">
                        <div className="font-medium text-green-700">
                          + {m.output.qty.toLocaleString()} × {m.output.sku}{" "}
                          <span className="text-gray-500 font-normal">({m.output.name})</span>
                        </div>
                        {m.consumes.length > 0 ? (
                          <ul className="mt-1 ml-4 list-disc text-gray-600">
                            {m.consumes.map((c, j) => (
                              <li key={j}>
                                − {c.qty.toLocaleString()} × {c.sku}{" "}
                                <span className="text-gray-400">({c.name})</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="ml-4 text-xs text-gray-400">No BOM components configured</div>
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-gray-500">
                      Components are consumed from stock. If any go negative, you'll see a warning
                      after approving.
                    </p>
                  </div>
                </div>
              )}

              {timeEntry.status === "PENDING" && (
                <div className="mt-6">
                  <Form method="post">
                    <input type="hidden" name="intent" value="approve-entry" />
                    <input type="hidden" name="entryId" value={timeEntry.id} />

                    <div className="flex gap-4">
                      <button type="submit" className="btn btn-success" disabled={isSubmitting}>
                        {isSubmitting ? "Approving..." : "✓ Approve Entry"}
                      </button>
                      <Link to={`/quality-control?tab=${tab}`} className="btn btn-ghost">
                        Cancel
                      </Link>
                    </div>
                  </Form>
                </div>
              )}

              <div className="mt-6 border-t pt-4">
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm("Delete this entire time entry (its tasks and clock events)? Inventory already moved by a prior approval is NOT reversed.")) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="delete-entry" />
                  <input type="hidden" name="entryId" value={timeEntry.id} />
                  <input type="hidden" name="tab" value={tab} />
                  <button type="submit" className="btn btn-error">Delete Entry</button>
                </Form>
              </div>
            </div>
          </div>

          {rejectModalLine && (
            <RejectTaskModal
              line={rejectModalLine}
              onClose={() => setRejectModalLine(null)}
              processDisplayName={getProcessDisplay(rejectModalLine.processName)}
            />
          )}
        </div>
      ) : (
        // List View
        <div>
          <div className="page-header flex items-start justify-between flex-wrap gap-3">
            <div>
              <h1 className="page-title">Quality Control</h1>
              <p className="page-subtitle">Review and manage worker task submissions</p>
            </div>
            <form method="get" action="/reports/approved-production" className="flex items-end gap-2">
              <div className="form-group mb-0">
                <label className="form-label text-xs">From</label>
                <input type="date" name="from" className="form-input py-1 text-sm" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label text-xs">To</label>
                <input type="date" name="to" className="form-input py-1 text-sm" />
              </div>
              <button type="submit" className="btn btn-secondary btn-sm">Export approved (CSV)</button>
            </form>
          </div>

          {actionData?.error && (
            <div className="alert alert-error mb-6">{actionData.error}</div>
          )}
          {actionData?.success && (
            <div className="alert alert-success mb-6">{actionData.message}</div>
          )}
          {actionData?.warnings && actionData.warnings.length > 0 && (
            <div className="alert alert-warning mb-6">
              <strong>Stock warnings</strong> — these components went negative (counts may be
              off or not loaded yet):
              <ul className="mt-1 list-disc list-inside text-sm">
                {actionData.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {justApproved && (
            <div className="alert alert-success mb-6">
              Time entry approved successfully! Inventory has been updated.
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-2 mb-6 border-b border-gray-200">
            <Link
              to="/quality-control?tab=pending"
              className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                tab === "pending"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Pending Review
              {timeEntries && tab === "pending" && ` (${timeEntries.length})`}
            </Link>
            <Link
              to="/quality-control?tab=approved"
              className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                tab === "approved"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Recently Approved
            </Link>
            <Link
              to="/quality-control?tab=rejected"
              className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                tab === "rejected"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Rejected Items
            </Link>
          </div>

          {/* Time Entries List */}
          <div className="card">
            {!timeEntries || timeEntries.length === 0 ? (
              <div className="card-body">
                <div className="text-center py-8 text-gray-500">
                  No entries found for this tab
                </div>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Date</th>
                    <th>Shift Time</th>
                    <th>Tasks</th>
                    <th>Efficiency</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {timeEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="font-medium">
                        {entry.user.firstName} {entry.user.lastName}
                      </td>
                      <td>{formatDate(entry.clockInTime)}</td>
                      <td>
                        {formatTime(entry.clockInTime)} - {entry.clockOutTime ? formatTime(entry.clockOutTime) : "—"}
                        {entry.actualMinutes != null && (
                          <span className="text-gray-500 text-sm ml-2">
                            ({(entry.actualMinutes / 60).toFixed(1)}h)
                          </span>
                        )}
                      </td>
                      <td>
                        {entry.lines.length} task{entry.lines.length !== 1 ? "s" : ""}
                        {entry.lines.some((l) => l.isRejected) && (
                          <span className="ml-2 text-xs text-red-600">
                            ({entry.lines.filter((l) => l.isRejected).length} rejected)
                          </span>
                        )}
                      </td>
                      <td>
                        {entry.efficiency !== null ? (
                          <span className={`badge ${getEfficiencyBadge(entry.efficiency)}`}>
                            {Math.round(entry.efficiency)}%
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td>
                        <Link
                          to={`/quality-control?entryId=${entry.id}&tab=${tab}`}
                          className="btn btn-secondary btn-sm"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
