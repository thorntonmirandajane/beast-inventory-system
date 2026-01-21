import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { addInventory } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";

  const whereClause = status === "all" ? {} : { status: status.toUpperCase() as any };

  const records = await prisma.receivingRecord.findMany({
    where: whereClause,
    include: {
      sku: true,
      createdBy: true,
      signedOffBy: true,
    },
    orderBy: { receivedAt: "desc" },
    take: 100,
  });

  const skus = await prisma.sku.findMany({
    where: { isActive: true, type: "RAW" },
    orderBy: { sku: "asc" },
  });

  const counts = {
    all: await prisma.receivingRecord.count(),
    pending: await prisma.receivingRecord.count({ where: { status: "PENDING" } }),
    approved: await prisma.receivingRecord.count({ where: { status: "APPROVED" } }),
    rejected: await prisma.receivingRecord.count({ where: { status: "REJECTED" } }),
  };

  return { user, records, skus, counts, currentStatus: status };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Create new receiving record
  if (intent === "create") {
    const skuId = formData.get("skuId") as string;
    const quantity = parseInt(formData.get("quantity") as string, 10);
    const poNumber = formData.get("poNumber") as string;
    const vendorName = formData.get("vendorName") as string;
    const notes = formData.get("notes") as string;

    if (!skuId || !quantity || quantity <= 0) {
      return { error: "SKU and valid quantity are required" };
    }

    const record = await prisma.receivingRecord.create({
      data: {
        skuId,
        quantity,
        poNumber: poNumber || null,
        vendorName: vendorName || null,
        notes: notes || null,
        createdById: user.id,
      },
    });

    await createAuditLog(user.id, "RECEIVE", "ReceivingRecord", record.id, {
      skuId,
      quantity,
      poNumber,
      vendorName,
    });

    return { success: true, message: `Received ${quantity} units` };
  }

  // Sign off on receiving record
  if (intent === "signoff") {
    const recordId = formData.get("recordId") as string;
    const action = formData.get("action") as "approve" | "reject";

    const record = await prisma.receivingRecord.findUnique({
      where: { id: recordId },
      include: { sku: true },
    });

    if (!record) {
      return { error: "Record not found" };
    }

    if (record.status !== "PENDING") {
      return { error: "Record already processed" };
    }

    const newStatus = action === "approve" ? "APPROVED" : "REJECTED";

    await prisma.receivingRecord.update({
      where: { id: recordId },
      data: {
        status: newStatus,
        signedOffById: user.id,
        signedOffAt: new Date(),
      },
    });

    // If approved, add to RAW inventory
    if (action === "approve") {
      await addInventory(record.skuId, record.quantity, "RAW");
    }

    await createAuditLog(user.id, "SIGN_OFF", "ReceivingRecord", recordId, {
      action,
      quantity: record.quantity,
      skuId: record.skuId,
    });

    return {
      success: true,
      message: action === "approve"
        ? `Approved and added ${record.quantity} units to inventory`
        : "Receiving record rejected",
    };
  }

  return { error: "Invalid action" };
};

export default function Receiving() {
  const { user, records, skus, counts, currentStatus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "pending", label: "Pending", count: counts.pending },
    { id: "approved", label: "Approved", count: counts.approved },
    { id: "rejected", label: "Rejected", count: counts.rejected },
  ];

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start">
        <div>
          <h1 className="page-title">Receiving</h1>
          <p className="page-subtitle">Record and sign off on incoming inventory</p>
        </div>
      </div>

      {actionData?.error && (
        <div className="alert alert-error">{actionData.error}</div>
      )}
      {actionData?.success && (
        <div className="alert alert-success">{actionData.message}</div>
      )}

      {/* New Receipt Form */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">New Receipt</h2>
        </div>
        <div className="card-body">
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="form-group mb-0">
                <label className="form-label">SKU *</label>
                <select name="skuId" className="form-select" required>
                  <option value="">Select SKU...</option>
                  {skus.map((sku) => (
                    <option key={sku.id} value={sku.id}>
                      {sku.sku} - {sku.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Quantity *</label>
                <input
                  type="number"
                  name="quantity"
                  className="form-input"
                  min="1"
                  required
                  placeholder="Enter quantity"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">PO Number</label>
                <input
                  type="text"
                  name="poNumber"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Vendor</label>
                <input
                  type="text"
                  name="vendorName"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
            </div>
            <div className="form-group mt-4">
              <label className="form-label">Notes</label>
              <textarea
                name="notes"
                className="form-textarea"
                rows={2}
                placeholder="Optional notes..."
              />
            </div>
            <div className="mt-4">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Recording..." : "Record Receipt"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/receiving?status=${tab.id}`}
            className={`tab ${currentStatus === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Records Table */}
      <div className="card">
        {records.length === 0 ? (
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
                  d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 00-3.213-9.193 2.056 2.056 0 00-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 00-10.026 0 1.106 1.106 0 00-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12"
                />
              </svg>
              <h3 className="empty-state-title">No receiving records</h3>
              <p className="empty-state-description">
                Record your first receipt using the form above.
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Quantity</th>
                <th>PO #</th>
                <th>Received</th>
                <th>Status</th>
                <th>Signed Off By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <span className="font-mono text-sm">{record.sku.sku}</span>
                  </td>
                  <td className="max-w-xs truncate">{record.sku.name}</td>
                  <td className="font-semibold">{record.quantity}</td>
                  <td>{record.poNumber || "—"}</td>
                  <td>{new Date(record.receivedAt).toLocaleDateString()}</td>
                  <td>
                    <span
                      className={`badge ${
                        record.status === "PENDING"
                          ? "status-pending"
                          : record.status === "APPROVED"
                          ? "status-approved"
                          : "status-rejected"
                      }`}
                    >
                      {record.status}
                    </span>
                  </td>
                  <td>
                    {record.signedOffBy
                      ? `${record.signedOffBy.firstName} ${record.signedOffBy.lastName}`
                      : "—"}
                  </td>
                  <td>
                    {record.status === "PENDING" && (
                      <div className="flex gap-2">
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="signoff" />
                          <input type="hidden" name="recordId" value={record.id} />
                          <input type="hidden" name="action" value="approve" />
                          <button
                            type="submit"
                            className="btn btn-sm btn-primary"
                            disabled={isSubmitting}
                          >
                            Approve
                          </button>
                        </Form>
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="signoff" />
                          <input type="hidden" name="recordId" value={record.id} />
                          <input type="hidden" name="action" value="reject" />
                          <button
                            type="submit"
                            className="btn btn-sm btn-danger"
                            disabled={isSubmitting}
                          >
                            Reject
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
