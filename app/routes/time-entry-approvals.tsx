import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import {
  approveTimeEntry,
  rejectTimeEntry,
  getAllProcessConfigs,
  PROCESS_TRANSITIONS,
} from "../utils/productivity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Only admins/managers can access
  if (user.role === "WORKER") {
    throw new Response("Unauthorized", { status: 403 });
  }

  // Get pending time entries
  const pendingEntries = await prisma.workerTimeEntry.findMany({
    where: { status: "PENDING" },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true },
      },
      lines: {
        include: {
          sku: {
            select: { sku: true, name: true },
          },
        },
      },
      clockInEvent: true,
      clockOutEvent: true,
    },
    orderBy: { clockInTime: "asc" },
  });

  // Get recently processed entries (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentEntries = await prisma.workerTimeEntry.findMany({
    where: {
      status: { in: ["APPROVED", "REJECTED"] },
      approvedAt: { gte: sevenDaysAgo },
    },
    include: {
      user: {
        select: { firstName: true, lastName: true },
      },
      approvedBy: {
        select: { firstName: true, lastName: true },
      },
      lines: true,
    },
    orderBy: { approvedAt: "desc" },
    take: 20,
  });

  const processConfigs = await getAllProcessConfigs();

  return { user, pendingEntries, recentEntries, processConfigs, processTransitions: PROCESS_TRANSITIONS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role === "WORKER") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const timeEntryId = formData.get("timeEntryId") as string;

  if (intent === "approve") {
    try {
      await approveTimeEntry(timeEntryId, user.id);
      return { success: true, message: "Time entry approved and inventory updated" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to approve" };
    }
  }

  if (intent === "reject") {
    const reason = formData.get("reason") as string;
    const photo = formData.get("photo") as string;

    if (!reason) {
      return { error: "Please provide a rejection reason" };
    }

    try {
      await rejectTimeEntry(timeEntryId, user.id, reason, photo || null);
      return { success: true, message: "Time entry rejected and worker notified" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Failed to reject" };
    }
  }

  if (intent === "edit-line") {
    const lineId = formData.get("lineId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);

    if (isNaN(quantity) || quantity <= 0) {
      return { error: "Please provide a valid quantity" };
    }

    // Update the time entry line
    const line = await prisma.timeEntryLine.findUnique({
      where: { id: lineId },
      include: { timeEntry: true },
    });

    if (!line) {
      return { error: "Line not found" };
    }

    // Verify entry is still pending
    if (line.timeEntry.status !== "PENDING") {
      return { error: "Can only edit pending entries" };
    }

    // Update quantity and recalculate expected time
    await prisma.timeEntryLine.update({
      where: { id: lineId },
      data: {
        quantityCompleted: quantity,
        expectedSeconds: quantity * line.secondsPerUnit,
      },
    });

    // Recalculate time entry expected minutes and efficiency
    const allLines = await prisma.timeEntryLine.findMany({
      where: { timeEntryId: line.timeEntryId },
    });

    const totalExpectedSeconds = allLines.reduce((sum, l) =>
      sum + (l.id === lineId ? quantity * line.secondsPerUnit : l.expectedSeconds), 0
    );
    const expectedMinutes = totalExpectedSeconds / 60;
    const efficiency = line.timeEntry.actualMinutes
      ? (expectedMinutes / line.timeEntry.actualMinutes) * 100
      : 0;

    await prisma.workerTimeEntry.update({
      where: { id: line.timeEntryId },
      data: {
        expectedMinutes,
        efficiency,
      },
    });

    return { success: true, message: "Quantity updated" };
  }

  if (intent === "delete-line") {
    const lineId = formData.get("lineId") as string;

    const line = await prisma.timeEntryLine.findUnique({
      where: { id: lineId },
      include: { timeEntry: true },
    });

    if (!line) {
      return { error: "Line not found" };
    }

    // Verify entry is still pending
    if (line.timeEntry.status !== "PENDING") {
      return { error: "Can only edit pending entries" };
    }

    // Delete the line
    await prisma.timeEntryLine.delete({
      where: { id: lineId },
    });

    // Recalculate time entry expected minutes and efficiency
    const allLines = await prisma.timeEntryLine.findMany({
      where: { timeEntryId: line.timeEntryId },
    });

    const totalExpectedSeconds = allLines.reduce((sum, l) => sum + l.expectedSeconds, 0);
    const expectedMinutes = totalExpectedSeconds / 60;
    const efficiency = line.timeEntry.actualMinutes
      ? (expectedMinutes / line.timeEntry.actualMinutes) * 100
      : 0;

    await prisma.workerTimeEntry.update({
      where: { id: line.timeEntryId },
      data: {
        expectedMinutes,
        efficiency,
      },
    });

    return { success: true, message: "Task removed" };
  }

  return { error: "Invalid action" };
};

export default function TimeEntryApprovals() {
  const { user, pendingEntries, recentEntries, processConfigs, processTransitions } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const [rejectingEntry, setRejectingEntry] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectPhoto, setRejectPhoto] = useState<string>("");
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState<number>(0);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Convert to base64
      const reader = new FileReader();
      reader.onloadend = () => {
        setRejectPhoto(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString();
  };

  const formatMinutes = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${m}m`;
  };

  const getEfficiencyColor = (efficiency: number | null) => {
    if (!efficiency) return "text-gray-600 bg-gray-100";
    if (efficiency >= 100) return "text-green-600 bg-green-100";
    if (efficiency >= 80) return "text-yellow-600 bg-yellow-100";
    return "text-red-600 bg-red-100";
  };

  const getProcessDisplay = (processName: string) => {
    return (
      processConfigs.find((p) => p.processName === processName)?.displayName ||
      processName
    );
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Time Entry Approvals</h1>
        <p className="page-subtitle">
          Review and approve worker productivity entries
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{pendingEntries.length}</div>
          <div className="stat-label">Pending Approval</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {recentEntries.filter((e) => e.status === "APPROVED").length}
          </div>
          <div className="stat-label">Approved (7 days)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {recentEntries.filter((e) => e.status === "REJECTED").length}
          </div>
          <div className="stat-label">Rejected (7 days)</div>
        </div>
      </div>

      {/* Pending Entries */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Pending Entries</h2>
        </div>
        {pendingEntries.length === 0 ? (
          <div className="card-body">
            <div className="text-center text-gray-500 py-8">
              No entries pending approval
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {pendingEntries.map((entry) => (
              <div key={entry.id} className="p-4">
                {/* Entry Header */}
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-lg">
                        {entry.user.firstName} {entry.user.lastName}
                      </span>
                      <span
                        className={`badge font-semibold ${getEfficiencyColor(
                          entry.efficiency
                        )}`}
                      >
                        {entry.efficiency?.toFixed(0) || 0}% Efficiency
                      </span>
                    </div>
                    <div className="text-sm text-gray-500">
                      {formatDate(entry.clockInTime)} &bull;{" "}
                      {formatTime(entry.clockInTime)} -{" "}
                      {entry.clockOutTime ? formatTime(entry.clockOutTime) : "?"}
                      {entry.actualMinutes && (
                        <span className="ml-2">
                          ({formatMinutes(entry.actualMinutes)} worked)
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-500">
                      {entry.lines.length} process
                      {entry.lines.length !== 1 ? "es" : ""} recorded
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedEntry(
                          expandedEntry === entry.id ? null : entry.id
                        )
                      }
                      className="btn btn-sm btn-secondary"
                    >
                      {expandedEntry === entry.id ? "Hide Details" : "View Details"}
                    </button>
                    <Form method="post">
                      <input type="hidden" name="intent" value="approve" />
                      <input type="hidden" name="timeEntryId" value={entry.id} />
                      <button
                        type="submit"
                        className="btn btn-sm btn-primary"
                        disabled={isSubmitting}
                      >
                        Approve
                      </button>
                    </Form>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingEntry(entry.id);
                        setRejectReason("");
                      }}
                      className="btn btn-sm btn-danger"
                    >
                      Reject
                    </button>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedEntry === entry.id && (
                  <div className="mt-4 p-4 bg-gray-50 rounded border">
                    <h4 className="font-semibold mb-3">Work Completed</h4>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Process</th>
                          <th>SKU</th>
                          <th>Quantity</th>
                          <th>Expected Time</th>
                          <th>Inventory Effect</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.lines.map((line) => {
                          const transition = processTransitions[line.processName];
                          const isEditing = editingLine === line.id;
                          return (
                            <tr key={line.id}>
                              <td className="font-medium">
                                {getProcessDisplay(line.processName)}
                              </td>
                              <td>
                                {line.sku ? (
                                  <span className="font-mono text-sm">
                                    {line.sku.sku}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">General</span>
                                )}
                              </td>
                              <td>
                                {isEditing ? (
                                  <Form method="post" className="inline">
                                    <input type="hidden" name="intent" value="edit-line" />
                                    <input type="hidden" name="lineId" value={line.id} />
                                    <input
                                      type="number"
                                      name="quantity"
                                      className="form-input w-24 text-sm py-1"
                                      min="1"
                                      value={editQuantity}
                                      onChange={(e) => setEditQuantity(parseInt(e.target.value, 10))}
                                      required
                                    />
                                    <button type="submit" className="btn btn-sm btn-primary ml-2" disabled={isSubmitting}>
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingLine(null)}
                                      className="btn btn-sm btn-secondary ml-1"
                                    >
                                      Cancel
                                    </button>
                                  </Form>
                                ) : (
                                  line.quantityCompleted.toLocaleString()
                                )}
                              </td>
                              <td>{formatMinutes(line.expectedSeconds / 60)}</td>
                              <td className="text-sm">
                                {transition ? (
                                  transition.consumes && transition.produces ? (
                                    <span>
                                      {transition.consumes} → {transition.produces}
                                    </span>
                                  ) : transition.produces ? (
                                    <span>+ {transition.produces}</span>
                                  ) : (
                                    <span className="text-gray-400">
                                      No change
                                    </span>
                                  )
                                ) : (
                                  <span className="text-gray-400">N/A</span>
                                )}
                              </td>
                              <td>
                                {!isEditing && (
                                  <div className="flex gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingLine(line.id);
                                        setEditQuantity(line.quantityCompleted);
                                      }}
                                      className="btn btn-sm btn-secondary"
                                    >
                                      Edit
                                    </button>
                                    <Form method="post" className="inline">
                                      <input type="hidden" name="intent" value="delete-line" />
                                      <input type="hidden" name="lineId" value={line.id} />
                                      <button
                                        type="submit"
                                        className="btn btn-sm btn-danger"
                                        disabled={isSubmitting}
                                        onClick={(e) => {
                                          if (!confirm('Remove this task?')) {
                                            e.preventDefault();
                                          }
                                        }}
                                      >
                                        Delete
                                      </button>
                                    </Form>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-gray-500">Total Expected:</span>{" "}
                        <span className="font-semibold">
                          {formatMinutes(entry.expectedMinutes || 0)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Actual Worked:</span>{" "}
                        <span className="font-semibold">
                          {formatMinutes(entry.actualMinutes || 0)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Break Time:</span>{" "}
                        <span className="font-semibold">
                          {entry.breakMinutes}m
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Rejection Modal */}
                {rejectingEntry === entry.id && (
                  <div className="mt-4 p-4 bg-red-50 rounded border border-red-200">
                    <Form method="post">
                      <input type="hidden" name="intent" value="reject" />
                      <input type="hidden" name="timeEntryId" value={entry.id} />
                      {rejectPhoto && (
                        <input type="hidden" name="photo" value={rejectPhoto} />
                      )}
                      <div className="form-group">
                        <label className="form-label">Rejection Reason *</label>
                        <textarea
                          name="reason"
                          className="form-textarea"
                          rows={2}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Explain why this entry is being rejected..."
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Attach Photo (Optional)</label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handlePhotoChange}
                          className="form-input"
                        />
                        {rejectPhoto && (
                          <div className="mt-2">
                            <img
                              src={rejectPhoto}
                              alt="Preview"
                              className="max-w-xs rounded border"
                            />
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="btn btn-sm btn-danger"
                          disabled={isSubmitting || !rejectReason.trim()}
                        >
                          Confirm Rejection
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingEntry(null);
                            setRejectPhoto("");
                          }}
                          className="btn btn-sm btn-secondary"
                        >
                          Cancel
                        </button>
                      </div>
                    </Form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Activity</h2>
          <p className="text-sm text-gray-500">Last 7 days</p>
        </div>
        {recentEntries.length === 0 ? (
          <div className="card-body">
            <div className="text-center text-gray-500 py-4">
              No recent activity
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Date</th>
                <th>Hours</th>
                <th>Efficiency</th>
                <th>Status</th>
                <th>Processed By</th>
              </tr>
            </thead>
            <tbody>
              {recentEntries.map((entry) => (
                <tr key={entry.id}>
                  <td className="font-medium">
                    {entry.user.firstName} {entry.user.lastName}
                  </td>
                  <td>{formatDate(entry.clockInTime)}</td>
                  <td>{formatMinutes(entry.actualMinutes || 0)}</td>
                  <td>
                    <span
                      className={`badge ${getEfficiencyColor(entry.efficiency)}`}
                    >
                      {entry.efficiency?.toFixed(0) || 0}%
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        entry.status === "APPROVED"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="text-sm text-gray-500">
                    {entry.approvedBy
                      ? `${entry.approvedBy.firstName} ${entry.approvedBy.lastName}`
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
