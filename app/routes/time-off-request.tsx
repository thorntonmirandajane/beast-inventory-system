import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Workers can view their own requests, admins can view all
  const timeOffRequests = await prisma.timeOffRequest.findMany({
    where: user.role === "WORKER" ? { userId: user.id } : {},
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
      approvedBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return { user, timeOffRequests };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "submit-request") {
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const reason = formData.get("reason") as string;

    if (!startDate || !endDate || !reason) {
      return { error: "All fields are required" };
    }

    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);

    // Validate dates
    if (startDateObj > endDateObj) {
      return { error: "Start date must be before end date" };
    }

    if (startDateObj < new Date()) {
      return { error: "Start date cannot be in the past" };
    }

    // Create time off request
    await prisma.timeOffRequest.create({
      data: {
        userId: user.id,
        startDate: startDateObj,
        endDate: endDateObj,
        reason,
        status: "PENDING",
      },
    });

    // TODO: Send notification to admin
    // For now, we'll just rely on the admin checking the time-clock page

    return redirect("/time-off-request?success=true");
  }

  if (intent === "approve" && user.role === "ADMIN") {
    const requestId = formData.get("requestId") as string;

    await prisma.timeOffRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });

    return { success: true, message: "Time off request approved" };
  }

  if (intent === "reject" && user.role === "ADMIN") {
    const requestId = formData.get("requestId") as string;
    const rejectionReason = formData.get("rejectionReason") as string;

    if (!rejectionReason) {
      return { error: "Rejection reason is required" };
    }

    await prisma.timeOffRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        rejectionReason,
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });

    return { success: true, message: "Time off request rejected" };
  }

  return { error: "Invalid action" };
};

export default function TimeOffRequest() {
  const { user, timeOffRequests } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const pendingRequests = timeOffRequests.filter((r) => r.status === "PENDING");
  const approvedRequests = timeOffRequests.filter((r) => r.status === "APPROVED");
  const rejectedRequests = timeOffRequests.filter((r) => r.status === "REJECTED");

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING":
        return "badge bg-yellow-100 text-yellow-800";
      case "APPROVED":
        return "badge bg-green-100 text-green-800";
      case "REJECTED":
        return "badge bg-red-100 text-red-800";
      default:
        return "badge";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Time Off Requests</h1>
        <p className="page-subtitle">
          {user.role === "WORKER"
            ? "Submit and track your time off requests"
            : "Review and approve worker time off requests"}
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success mb-6">{actionData.message}</div>
      )}

      {/* Submit Request Form - Workers Only */}
      {user.role === "WORKER" && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Submit New Request</h2>
          </div>
          <div className="card-body">
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="submit-request" />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="form-group">
                  <label className="form-label">Start Date *</label>
                  <input
                    type="date"
                    name="startDate"
                    required
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">End Date *</label>
                  <input
                    type="date"
                    name="endDate"
                    required
                    className="form-input"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Reason *</label>
                <textarea
                  name="reason"
                  required
                  rows={3}
                  className="form-textarea"
                  placeholder="Vacation, medical, personal, etc."
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Submitting..." : "Submit Request"}
              </button>
            </Form>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value text-yellow-600">{pendingRequests.length}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-green-600">{approvedRequests.length}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-red-600">{rejectedRequests.length}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>

      {/* Pending Requests */}
      {pendingRequests.length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Pending Requests</h2>
          </div>
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  {user.role === "ADMIN" && <th>Worker</th>}
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Days</th>
                  <th>Reason</th>
                  <th>Submitted</th>
                  {user.role === "ADMIN" && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {pendingRequests.map((request) => {
                  const days = Math.ceil(
                    (new Date(request.endDate).getTime() -
                      new Date(request.startDate).getTime()) /
                      (1000 * 60 * 60 * 24)
                  ) + 1;

                  return (
                    <tr key={request.id}>
                      {user.role === "ADMIN" && (
                        <td>
                          {request.user.firstName} {request.user.lastName}
                        </td>
                      )}
                      <td>
                        {new Date(request.startDate).toLocaleDateString()}
                      </td>
                      <td>
                        {new Date(request.endDate).toLocaleDateString()}
                      </td>
                      <td>{days} day{days > 1 ? "s" : ""}</td>
                      <td className="max-w-xs truncate">{request.reason}</td>
                      <td>
                        {new Date(request.createdAt).toLocaleDateString()}
                      </td>
                      {user.role === "ADMIN" && (
                        <td>
                          <div className="flex gap-2">
                            <Form method="post" className="inline">
                              <input type="hidden" name="intent" value="approve" />
                              <input type="hidden" name="requestId" value={request.id} />
                              <button
                                type="submit"
                                className="btn btn-sm btn-success"
                                disabled={isSubmitting}
                              >
                                Approve
                              </button>
                            </Form>
                            <Form
                              method="post"
                              className="inline"
                              onSubmit={(e) => {
                                const reason = prompt("Rejection reason:");
                                if (!reason) {
                                  e.preventDefault();
                                  return;
                                }
                                const input = document.createElement("input");
                                input.type = "hidden";
                                input.name = "rejectionReason";
                                input.value = reason;
                                e.currentTarget.appendChild(input);
                              }}
                            >
                              <input type="hidden" name="intent" value="reject" />
                              <input type="hidden" name="requestId" value={request.id} />
                              <button
                                type="submit"
                                className="btn btn-sm btn-error"
                                disabled={isSubmitting}
                              >
                                Reject
                              </button>
                            </Form>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Approved Requests */}
      {approvedRequests.length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="card-title">Approved Requests</h2>
          </div>
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  {user.role === "ADMIN" && <th>Worker</th>}
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Days</th>
                  <th>Reason</th>
                  {user.role === "ADMIN" && <th>Approved By</th>}
                  <th>Approved On</th>
                </tr>
              </thead>
              <tbody>
                {approvedRequests.map((request) => {
                  const days = Math.ceil(
                    (new Date(request.endDate).getTime() -
                      new Date(request.startDate).getTime()) /
                      (1000 * 60 * 60 * 24)
                  ) + 1;

                  return (
                    <tr key={request.id}>
                      {user.role === "ADMIN" && (
                        <td>
                          {request.user.firstName} {request.user.lastName}
                        </td>
                      )}
                      <td>
                        {new Date(request.startDate).toLocaleDateString()}
                      </td>
                      <td>
                        {new Date(request.endDate).toLocaleDateString()}
                      </td>
                      <td>{days} day{days > 1 ? "s" : ""}</td>
                      <td className="max-w-xs truncate">{request.reason}</td>
                      {user.role === "ADMIN" && (
                        <td>
                          {request.approvedBy?.firstName}{" "}
                          {request.approvedBy?.lastName}
                        </td>
                      )}
                      <td>
                        {request.approvedAt
                          ? new Date(request.approvedAt).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Rejected Requests */}
      {rejectedRequests.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Rejected Requests</h2>
          </div>
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  {user.role === "ADMIN" && <th>Worker</th>}
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Reason</th>
                  <th>Rejection Reason</th>
                  <th>Rejected On</th>
                </tr>
              </thead>
              <tbody>
                {rejectedRequests.map((request) => (
                  <tr key={request.id}>
                    {user.role === "ADMIN" && (
                      <td>
                        {request.user.firstName} {request.user.lastName}
                      </td>
                    )}
                    <td>
                      {new Date(request.startDate).toLocaleDateString()}
                    </td>
                    <td>
                      {new Date(request.endDate).toLocaleDateString()}
                    </td>
                    <td className="max-w-xs truncate">{request.reason}</td>
                    <td className="max-w-xs truncate text-red-600">
                      {request.rejectionReason}
                    </td>
                    <td>
                      {request.approvedAt
                        ? new Date(request.approvedAt).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {timeOffRequests.length === 0 && (
        <div className="card">
          <div className="card-body text-center py-12 text-gray-500">
            {user.role === "WORKER"
              ? "You haven't submitted any time off requests yet"
              : "No time off requests to review"}
          </div>
        </div>
      )}
    </Layout>
  );
}
