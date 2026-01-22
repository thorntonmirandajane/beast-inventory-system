import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  // Only admins can view notifications
  if (user.role !== "ADMIN") {
    throw new Response("Unauthorized", { status: 403 });
  }

  const notifications = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const unreadCount = await prisma.notification.count({
    where: { isRead: false },
  });

  return { user, notifications, unreadCount };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "ADMIN") {
    return { error: "Unauthorized" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "mark-read") {
    const notificationId = formData.get("notificationId") as string;

    await prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    return { success: true };
  }

  if (intent === "mark-all-read") {
    await prisma.notification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });

    return { success: true, message: "All notifications marked as read" };
  }

  return { error: "Invalid action" };
};

export default function Notifications() {
  const { user, notifications, unreadCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const formatTime = (date: Date | string) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 1000 / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString();
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "LATE_CLOCK_IN":
        return (
          <svg className="w-5 h-5 text-yellow-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case "MISSED_CLOCK_IN":
        return (
          <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        );
      case "MISSED_CLOCK_OUT":
        return (
          <svg className="w-5 h-5 text-orange-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        );
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Notifications</h1>
        <p className="page-subtitle">
          Time clock alerts and system notifications
        </p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && actionData.message && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <div>
            <h2 className="card-title">Recent Notifications</h2>
            {unreadCount > 0 && (
              <p className="text-sm text-gray-500">{unreadCount} unread</p>
            )}
          </div>
          {unreadCount > 0 && (
            <Form method="post">
              <input type="hidden" name="intent" value="mark-all-read" />
              <button
                type="submit"
                className="btn btn-sm btn-secondary"
                disabled={isSubmitting}
              >
                Mark All Read
              </button>
            </Form>
          )}
        </div>
        <div className="divide-y">
          {notifications.length === 0 ? (
            <div className="card-body">
              <div className="text-center text-gray-500 py-8">
                No notifications yet
              </div>
            </div>
          ) : (
            notifications.map((notification) => {
              const metadata = notification.metadata
                ? JSON.parse(notification.metadata)
                : null;

              return (
                <div
                  key={notification.id}
                  className={`p-4 flex items-start gap-4 ${
                    !notification.isRead ? "bg-blue-50" : "bg-white"
                  }`}
                >
                  <div className="flex-shrink-0 mt-1">
                    {getNotificationIcon(notification.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {notification.message}
                    </p>
                    {metadata && (
                      <div className="mt-1 text-xs text-gray-500">
                        {metadata.scheduledTime && (
                          <span className="mr-3">
                            Scheduled: {metadata.scheduledTime}
                          </span>
                        )}
                        {metadata.actualTime && (
                          <span className="mr-3">
                            Actual: {metadata.actualTime}
                          </span>
                        )}
                        {metadata.minutesLate && (
                          <span className="font-semibold text-yellow-600">
                            {metadata.minutesLate} min late
                          </span>
                        )}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-gray-500">
                      {formatTime(notification.createdAt)}
                    </p>
                  </div>
                  {!notification.isRead && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="mark-read" />
                      <input
                        type="hidden"
                        name="notificationId"
                        value={notification.id}
                      />
                      <button
                        type="submit"
                        className="text-sm text-blue-600 hover:text-blue-800"
                        disabled={isSubmitting}
                      >
                        Mark Read
                      </button>
                    </Form>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </Layout>
  );
}
