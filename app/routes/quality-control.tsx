import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link, useFetcher } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { ImageUpload } from "../components/ImageUpload";
import prisma from "../db.server";
import { approveTimeEntry } from "../utils/productivity.server";
import { useState } from "react";

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

    return { user, timeEntry, tab, entryId };
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

  return { user, timeEntries, tab, entryId: null, timeEntry: null };
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

    console.log("[Quality Control] Approving time entry:", entryId);
    const result = await approveTimeEntry(entryId, user.id);

    if (!result.success) {
      console.error("[Quality Control] Approval failed:", result.error);
      return { error: result.error };
    }

    console.log("[Quality Control] Approval successful, creating audit log");
    await createAuditLog(user.id, "APPROVE_TIME_ENTRY", "WorkerTimeEntry", entryId, {});

    return { success: true, message: "Time entry approved successfully" };
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
    setIsEditing(false);
  };

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
        <div className="flex gap-2">
          <button onClick={handleSave} className="btn btn-primary btn-sm">
            Save
          </button>
          <button onClick={() => setIsEditing(false)} className="btn btn-ghost btn-sm">
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
}: {
  line: any;
  onClose: () => void;
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
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <h3 className="text-lg font-bold mb-4">Reject Task</h3>
        <div className="mb-4 text-sm">
          <p>
            <strong>Process:</strong> {line.processName}
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

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={!reason.trim()}
              className="btn btn-error flex-1"
            >
              Reject Task
            </button>
            <button type="button" onClick={onClose} className="btn btn-ghost flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function QualityControl() {
  const { user, timeEntries, timeEntry, tab, entryId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [rejectModalLine, setRejectModalLine] = useState<any>(null);

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
                  {formatDate(timeEntry.clockOutTime!)}
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

          {/* Shift Summary */}
          <div className="card mb-6">
            <div className="card-header">
              <h3 className="card-title">Shift Summary</h3>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-600">Worker</label>
                  <p className="font-medium">
                    {timeEntry.user.firstName} {timeEntry.user.lastName}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Clock In</label>
                  <p className="font-medium">{formatDateTime(timeEntry.clockInTime)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Clock Out</label>
                  <p className="font-medium">{formatDateTime(timeEntry.clockOutTime!)}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-600">Hours Worked</label>
                  <p className="font-medium">{(timeEntry.actualMinutes / 60).toFixed(2)}h</p>
                </div>
              </div>
              {timeEntry.efficiency !== null && (
                <div className="mt-4">
                  <label className="text-sm font-medium text-gray-600">Efficiency</label>
                  <div className="flex items-center gap-4 mt-2">
                    <div className="flex-1 bg-gray-200 rounded-full h-6 relative overflow-hidden">
                      <div
                        className={`h-full ${
                          timeEntry.efficiency >= 90
                            ? "bg-green-500"
                            : timeEntry.efficiency >= 70
                            ? "bg-yellow-500"
                            : "bg-red-500"
                        }`}
                        style={{ width: `${Math.min(timeEntry.efficiency, 100)}%` }}
                      ></div>
                      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold">
                        {timeEntry.efficiency}%
                      </span>
                    </div>
                  </div>
                </div>
              )}
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
                        {line.processName.replace(/_/g, " ")}
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
                        {timeEntry.status === "PENDING" && !line.isRejected && (
                          <button
                            onClick={() => setRejectModalLine(line)}
                            className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
                          >
                            Reject
                          </button>
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
                            {line.processName} - {line.sku?.sku || "MISC"}:
                          </strong>
                          <p className="text-sm mt-1">{line.adminNotes}</p>
                        </div>
                      )
                  )}
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
            </div>
          </div>

          {rejectModalLine && (
            <RejectTaskModal line={rejectModalLine} onClose={() => setRejectModalLine(null)} />
          )}
        </div>
      ) : (
        // List View
        <div>
          <div className="page-header">
            <h1 className="page-title">Quality Control</h1>
            <p className="page-subtitle">Review and manage worker task submissions</p>
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
                      <td>{formatDate(entry.clockOutTime!)}</td>
                      <td>
                        {formatTime(entry.clockInTime)} - {formatTime(entry.clockOutTime!)}
                        <span className="text-gray-500 text-sm ml-2">
                          ({(entry.actualMinutes / 60).toFixed(1)}h)
                        </span>
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
                            {entry.efficiency}%
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
