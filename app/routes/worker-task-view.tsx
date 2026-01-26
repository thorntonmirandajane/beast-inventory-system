import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, redirect } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (user.role !== "WORKER") {
    throw redirect("/");
  }

  const url = new URL(request.url);
  const justClockedIn = url.searchParams.get("clockIn") === "true";

  // Get today's assigned tasks
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todaysTasks = await prisma.workerTask.findMany({
    where: {
      userId: user.id,
      assignmentType: "DAILY",
      dueDate: {
        gte: today,
        lt: tomorrow,
      },
      status: "PENDING",
    },
    include: {
      sku: true,
      assignedBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });

  return { user, justClockedIn, todaysTasks };
};

export default function WorkerTaskView() {
  const { user, justClockedIn, todaysTasks } = useLoaderData<typeof loader>();

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Today's Assigned Tasks</h1>
        {justClockedIn && (
          <div className="alert alert-success mb-4">
            <strong>✓ You've clocked in for today!</strong>
            <p className="text-sm mt-1">Review your assigned tasks below.</p>
          </div>
        )}
      </div>

      {todaysTasks.length === 0 ? (
        <div className="card">
          <div className="empty-state py-12">
            <p className="text-lg text-gray-600 mb-2">No tasks assigned for today</p>
            <p className="text-sm text-gray-500">
              You can start working on other tasks or check with your supervisor.
            </p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Process</th>
                  <th>SKU</th>
                  <th>Target Quantity</th>
                  <th>Assigned By</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {todaysTasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      {task.priority > 0 ? (
                        <span className="badge badge-error">High</span>
                      ) : (
                        <span className="badge badge-secondary">Normal</span>
                      )}
                    </td>
                    <td className="font-medium">{task.processName}</td>
                    <td>
                      {task.sku ? (
                        <Link
                          to={`/tutorials?sku=${task.sku.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          <div className="font-mono text-sm">{task.sku.sku}</div>
                          <div className="text-xs text-gray-500">{task.sku.name}</div>
                          <div className="text-xs text-blue-500 mt-1">
                            📚 View Tutorial
                          </div>
                        </Link>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="font-semibold">
                      {task.targetQuantity || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="text-sm text-gray-600">
                      {task.assignedBy.firstName} {task.assignedBy.lastName}
                    </td>
                    <td className="text-sm text-gray-600">
                      {task.notes || <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-6 flex gap-4">
        <Link to="/worker-dashboard" className="btn btn-primary">
          Start Working
        </Link>
        <Link to="/time-clock" className="btn btn-secondary">
          Back to Time Clock
        </Link>
      </div>
    </Layout>
  );
}
