import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Get all rejected time entries for this worker (full entry rejections)
  const rejectedEntries = await prisma.workerTimeEntry.findMany({
    where: {
      userId: user.id,
      status: "REJECTED",
    },
    include: {
      lines: {
        include: {
          sku: {
            select: { sku: true, name: true },
          },
        },
      },
      approvedBy: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: { approvedAt: "desc" },
  });

  // Get individual rejected tasks (task-level rejections from quality control)
  const rejectedTasks = await prisma.timeEntryLine.findMany({
    where: {
      timeEntry: { userId: user.id },
      isRejected: true,
    },
    include: {
      sku: {
        select: { sku: true, name: true },
      },
      timeEntry: {
        select: {
          clockInTime: true,
          clockOutTime: true,
          actualMinutes: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Get process configs for display names
  const processConfigs = await prisma.processConfig.findMany({
    where: { isActive: true },
    select: { processName: true, displayName: true },
  });

  return { user, rejectedEntries, rejectedTasks, processConfigs };
};

export default function MyRejectedTasks() {
  const { user, rejectedEntries, rejectedTasks, processConfigs } = useLoaderData<typeof loader>();

  const getProcessDisplay = (processName: string) => {
    return (
      processConfigs.find((p) => p.processName === processName)?.displayName ||
      processName.replace(/_/g, " ")
    );
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

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">My Rejected Tasks</h1>
        <p className="page-subtitle">View tasks that were rejected by management</p>
      </div>

      {/* Individual Rejected Tasks (from Quality Control) */}
      {rejectedTasks.length > 0 && (
        <div className="card mb-6">
          <div className="card-header bg-yellow-50">
            <h2 className="card-title text-yellow-900">Rejected Individual Tasks</h2>
            <p className="text-sm text-yellow-700 mt-1">
              These specific tasks were rejected during quality control review
            </p>
          </div>
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Process</th>
                    <th>SKU</th>
                    <th className="text-right">Rejected Qty</th>
                    <th>Reason</th>
                    <th>Photo</th>
                  </tr>
                </thead>
                <tbody>
                  {rejectedTasks.map((task) => {
                    // Extract photo URL from adminNotes if it contains [Photo: url]
                    const photoMatch = task.adminNotes?.match(/\[Photo: (https?:\/\/[^\]]+)\]/);
                    const photoUrl = photoMatch ? photoMatch[1] : null;

                    return (
                      <tr key={task.id} className="hover:bg-red-50">
                        <td className="text-sm">
                          {formatDate(task.timeEntry.clockInTime)}
                        </td>
                        <td className="font-medium">
                          {getProcessDisplay(task.processName)}
                        </td>
                        <td>
                          {task.sku ? (
                            <div>
                              <span className="font-mono text-sm">{task.sku.sku}</span>
                              <span className="text-xs text-gray-500 block">
                                {task.sku.name}
                              </span>
                            </div>
                          ) : (
                            <span className="text-gray-400">Miscellaneous</span>
                          )}
                        </td>
                        <td className="text-right">
                          <span className="font-semibold text-red-600">
                            {task.rejectionQuantity}
                          </span>
                          <span className="text-xs text-gray-500 ml-1">
                            / {task.quantityCompleted}
                          </span>
                        </td>
                        <td>
                          <div className="max-w-xs">
                            <p className="text-sm text-red-800">{task.rejectionReason}</p>
                            {task.adminNotes && (
                              <p className="text-xs text-gray-500 mt-1">
                                {task.adminNotes.replace(/\[Photo:.*?\]/, '').trim()}
                              </p>
                            )}
                          </div>
                        </td>
                        <td>
                          {photoUrl ? (
                            <a
                              href={photoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block"
                            >
                              <img
                                src={photoUrl}
                                alt="Quality issue"
                                className="h-16 w-16 object-cover rounded border border-gray-300 hover:border-blue-500 cursor-pointer"
                              />
                            </a>
                          ) : (
                            <span className="text-xs text-gray-400">No photo</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Full Entry Rejections (legacy system) */}
      {rejectedEntries.length === 0 && rejectedTasks.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div className="text-center text-gray-500 py-8">
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <h3 className="text-lg font-medium mb-2">No Rejected Tasks</h3>
              <p>You don't have any rejected time entries.</p>
            </div>
          </div>
        </div>
      ) : rejectedEntries.length > 0 ? (
        <div className="space-y-6">
          <h2 className="text-lg font-semibold text-gray-900">Full Time Entry Rejections</h2>
          {rejectedEntries.map((entry) => (
            <div key={entry.id} className="card border-l-4 border-red-500">
              <div className="card-body">
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="badge bg-red-100 text-red-800 font-semibold">
                        REJECTED
                      </span>
                      <span className="text-sm text-gray-500">
                        {formatDate(entry.clockInTime)}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600">
                      {formatTime(entry.clockInTime)} -{" "}
                      {entry.clockOutTime ? formatTime(entry.clockOutTime) : "?"}
                      {entry.actualMinutes && (
                        <span className="ml-2">
                          ({formatMinutes(entry.actualMinutes)} worked)
                        </span>
                      )}
                    </div>
                  </div>
                  {entry.approvedBy && (
                    <div className="text-sm text-gray-500">
                      Rejected by {entry.approvedBy.firstName} {entry.approvedBy.lastName}
                    </div>
                  )}
                </div>

                {/* Rejection Reason */}
                <div className="bg-red-50 border border-red-200 rounded p-4 mb-4">
                  <h4 className="font-semibold text-red-900 mb-2">Rejection Reason:</h4>
                  <p className="text-red-800">{entry.rejectionReason}</p>

                  {/* Photo if attached */}
                  {entry.rejectionPhoto && (
                    <div className="mt-3">
                      <img
                        src={entry.rejectionPhoto}
                        alt="Rejection evidence"
                        className="max-w-md rounded border border-red-300"
                      />
                    </div>
                  )}
                </div>

                {/* Tasks Submitted */}
                <div>
                  <h4 className="font-semibold mb-2">Tasks You Submitted:</h4>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Process</th>
                          <th>SKU</th>
                          <th className="text-right">Quantity</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.lines.map((line) => (
                          <tr key={line.id}>
                            <td className="font-medium">
                              {getProcessDisplay(line.processName)}
                            </td>
                            <td>
                              {line.sku ? (
                                <div>
                                  <span className="font-mono text-sm">
                                    {line.sku.sku}
                                  </span>
                                  <span className="text-xs text-gray-500 block">
                                    {line.sku.name}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-gray-400">General</span>
                              )}
                            </td>
                            <td className="text-right font-semibold">
                              {line.quantityCompleted.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Action Note */}
                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm">
                  <p className="text-blue-800">
                    <strong>Note:</strong> Please review the rejection reason and correct any
                    issues for future time entries. If you have questions, please speak with
                    your supervisor.
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Layout>
  );
}
