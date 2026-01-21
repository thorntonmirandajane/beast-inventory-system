import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { executeBuild, calculateBuildEligibility } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";

  const whereClause = status === "all" ? {} : { status: status.toUpperCase() as any };

  const workOrders = await prisma.workOrder.findMany({
    where: whereClause,
    include: {
      outputSku: true,
      createdBy: true,
      consumptions: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Get buildable SKUs for new work order form
  const buildableSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLY", "COMPLETED"] },
      bomComponents: { some: {} },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  const counts = {
    all: await prisma.workOrder.count(),
    pending: await prisma.workOrder.count({ where: { status: "PENDING" } }),
    inProgress: await prisma.workOrder.count({ where: { status: "IN_PROGRESS" } }),
    completed: await prisma.workOrder.count({ where: { status: "COMPLETED" } }),
  };

  return { user, workOrders, buildableSkus, counts, currentStatus: status };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Create new work order
  if (intent === "create") {
    const outputSkuId = formData.get("outputSkuId") as string;
    const quantityToBuild = parseInt(formData.get("quantityToBuild") as string, 10);
    const notes = formData.get("notes") as string;

    if (!outputSkuId || !quantityToBuild || quantityToBuild <= 0) {
      return { error: "SKU and valid quantity are required" };
    }

    // Verify we can build this quantity
    const eligibility = await calculateBuildEligibility(outputSkuId);
    if (eligibility.maxBuildable < quantityToBuild) {
      return {
        error: `Cannot build ${quantityToBuild} units. Maximum buildable: ${eligibility.maxBuildable}`,
      };
    }

    const workOrder = await prisma.workOrder.create({
      data: {
        outputSkuId,
        quantityToBuild,
        notes: notes || null,
        createdById: user.id,
      },
    });

    await createAuditLog(user.id, "CREATE_WORK_ORDER", "WorkOrder", workOrder.id, {
      outputSkuId,
      quantityToBuild,
    });

    return { success: true, message: `Work order created for ${quantityToBuild} units` };
  }

  // Execute build (partial or full)
  if (intent === "build") {
    const workOrderId = formData.get("workOrderId") as string;
    const quantityToBuild = parseInt(formData.get("quantityToBuild") as string, 10);

    if (!workOrderId || !quantityToBuild || quantityToBuild <= 0) {
      return { error: "Valid work order and quantity required" };
    }

    const result = await executeBuild(workOrderId, quantityToBuild);

    if (!result.success) {
      return { error: result.error };
    }

    await createAuditLog(user.id, "EXECUTE_BUILD", "WorkOrder", workOrderId, {
      quantityBuilt: quantityToBuild,
    });

    return { success: true, message: `Built ${quantityToBuild} units` };
  }

  // Cancel work order
  if (intent === "cancel") {
    const workOrderId = formData.get("workOrderId") as string;

    await prisma.workOrder.update({
      where: { id: workOrderId },
      data: { status: "CANCELLED" },
    });

    await createAuditLog(user.id, "CANCEL_WORK_ORDER", "WorkOrder", workOrderId, {});

    return { success: true, message: "Work order cancelled" };
  }

  return { error: "Invalid action" };
};

export default function WorkOrders() {
  const { user, workOrders, buildableSkus, counts, currentStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "pending", label: "Pending", count: counts.pending },
    { id: "in_progress", label: "In Progress", count: counts.inProgress },
    { id: "completed", label: "Completed", count: counts.completed },
  ];

  const getStatusClass = (status: string) => {
    switch (status) {
      case "PENDING":
        return "status-pending";
      case "IN_PROGRESS":
        return "status-in-progress";
      case "COMPLETED":
        return "status-completed";
      case "CANCELLED":
        return "status-rejected";
      default:
        return "badge-gray";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Work Orders</h1>
        <p className="page-subtitle">Create and manage production work orders</p>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* New Work Order Form */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Create Work Order</h2>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">SKU to Build *</label>
                <select name="outputSkuId" className="form-select" required>
                  <option value="">Select SKU...</option>
                  <optgroup label="Assemblies">
                    {buildableSkus
                      .filter((s) => s.type === "ASSEMBLY")
                      .map((sku) => (
                        <option key={sku.id} value={sku.id}>
                          {sku.sku} - {sku.name}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Completed Products">
                    {buildableSkus
                      .filter((s) => s.type === "COMPLETED")
                      .map((sku) => (
                        <option key={sku.id} value={sku.id}>
                          {sku.sku} - {sku.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Quantity *</label>
                <input
                  type="number"
                  name="quantityToBuild"
                  className="form-input"
                  min="1"
                  required
                  placeholder="How many to build"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Notes</label>
                <input
                  type="text"
                  name="notes"
                  className="form-input"
                  placeholder="Optional notes"
                />
              </div>
            </div>
            <div className="mt-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating..." : "Create Work Order"}
              </button>
              <Link to="/build" className="btn btn-secondary ml-3">
                Check Eligibility First
              </Link>
            </div>
          </Form>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/work-orders?status=${tab.id}`}
            className={`tab ${currentStatus === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Work Orders Table */}
      <div className="card">
        {workOrders.length === 0 ? (
          <div className="card-body">
            <div className="empty-state">
              <svg
                className="empty-state-icon"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
                />
              </svg>
              <h3 className="empty-state-title">No work orders</h3>
              <p className="empty-state-description">
                Create your first work order above.
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>SKU</th>
                <th>Name</th>
                <th className="text-right">Target</th>
                <th className="text-right">Built</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {workOrders.map((wo) => (
                <tr key={wo.id}>
                  <td>
                    <span className="font-mono text-sm">
                      {wo.orderNumber.slice(0, 8)}
                    </span>
                  </td>
                  <td>
                    <span className="font-mono text-sm">{wo.outputSku.sku}</span>
                  </td>
                  <td className="max-w-xs truncate">{wo.outputSku.name}</td>
                  <td className="text-right font-semibold">{wo.quantityToBuild}</td>
                  <td className="text-right">
                    <span
                      className={
                        wo.quantityBuilt >= wo.quantityToBuild
                          ? "text-green-600 font-semibold"
                          : wo.quantityBuilt > 0
                          ? "text-blue-600 font-semibold"
                          : "text-gray-400"
                      }
                    >
                      {wo.quantityBuilt}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${getStatusClass(wo.status)}`}>
                      {wo.status.replace("_", " ")}
                    </span>
                  </td>
                  <td>{new Date(wo.createdAt).toLocaleDateString()}</td>
                  <td>
                    {(wo.status === "PENDING" || wo.status === "IN_PROGRESS") && (
                      <div className="flex gap-2">
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="build" />
                          <input type="hidden" name="workOrderId" value={wo.id} />
                          <input
                            type="number"
                            name="quantityToBuild"
                            className="form-input w-20 text-sm"
                            min="1"
                            max={wo.quantityToBuild - wo.quantityBuilt}
                            defaultValue={Math.min(10, wo.quantityToBuild - wo.quantityBuilt)}
                            required
                          />
                          <button
                            type="submit"
                            className="btn btn-sm btn-primary ml-2"
                            disabled={isSubmitting}
                          >
                            Build
                          </button>
                        </Form>
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="cancel" />
                          <input type="hidden" name="workOrderId" value={wo.id} />
                          <button
                            type="submit"
                            className="btn btn-sm btn-ghost text-red-600"
                            disabled={isSubmitting}
                          >
                            Cancel
                          </button>
                        </Form>
                      </div>
                    )}
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
