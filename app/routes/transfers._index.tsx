import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, Link, useNavigation } from "react-router";
import { requireUser, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { deductInventory, getAvailableQuantity } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const dateFilter = url.searchParams.get("date");

  const whereClause: any = {};
  if (dateFilter) {
    const startDate = new Date(dateFilter);
    const endDate = new Date(dateFilter);
    endDate.setDate(endDate.getDate() + 1);
    whereClause.shippedAt = {
      gte: startDate,
      lt: endDate,
    };
  }

  const transfers = await prisma.transfer.findMany({
    where: whereClause,
    include: {
      items: {
        include: {
          sku: true,
        },
      },
      createdBy: true,
    },
    orderBy: { shippedAt: "desc" },
    take: 100,
  });

  // Get transferable SKUs (ASSEMBLED or COMPLETED with available inventory)
  const transferableSkus = await prisma.sku.findMany({
    where: {
      isActive: true,
      type: { in: ["ASSEMBLED", "COMPLETED"] },
      inventoryItems: {
        some: {
          quantity: { gt: 0 },
          state: { in: ["ASSEMBLED", "COMPLETED"] },
        },
      },
    },
    include: {
      inventoryItems: {
        where: {
          quantity: { gt: 0 },
          state: { in: ["ASSEMBLED", "COMPLETED"] },
        },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  const skusWithQty = transferableSkus.map((sku) => ({
    ...sku,
    availableQty: sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0),
  }));

  const stats = {
    totalTransfers: await prisma.transfer.count(),
    todayTransfers: await prisma.transfer.count({
      where: {
        transferDate: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    }),
    totalItemsTransferred: await prisma.transferItem.aggregate({
      _sum: { quantity: true },
    }),
  };

  return { user, transfers, transferableSkus: skusWithQty, stats, dateFilter };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const destination = formData.get("destination") as string;
    const transferDate = formData.get("transferDate") as string;
    const notes = formData.get("notes") as string;

    // Parse items from form data
    const items: { skuId: string; quantity: number }[] = [];
    let i = 0;
    while (formData.get(`items[${i}][skuId]`)) {
      const skuId = formData.get(`items[${i}][skuId]`) as string;
      const quantity = parseInt(formData.get(`items[${i}][quantity]`) as string, 10);
      if (skuId && quantity > 0) {
        items.push({ skuId, quantity });
      }
      i++;
    }

    if (!destination) {
      return { error: "Destination is required" };
    }

    if (items.length === 0) {
      return { error: "At least one item is required" };
    }

    // Verify all items have sufficient inventory
    for (const item of items) {
      const sku = await prisma.sku.findUnique({ where: { id: item.skuId } });
      if (!sku) {
        return { error: `SKU not found: ${item.skuId}` };
      }

      const targetState = sku.type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED";
      const available = await getAvailableQuantity(item.skuId, [targetState]);
      if (available < item.quantity) {
        return {
          error: `Insufficient inventory for ${sku.sku}. Available: ${available}, Requested: ${item.quantity}`,
        };
      }
    }

    // Create transfer and deduct inventory
    const transfer = await prisma.transfer.create({
      data: {
        destination,
        shippedAt: transferDate ? new Date(transferDate) : new Date(),
        notes: notes || null,
        createdById: user.id,
        items: {
          create: items.map((item) => ({
            skuId: item.skuId,
            quantity: item.quantity,
          })),
        },
      },
      include: {
        items: {
          include: { sku: true },
        },
      },
    });

    // Deduct inventory for each item
    for (const item of transfer.items) {
      const targetState = item.sku.type === "COMPLETED" ? "COMPLETED" : "ASSEMBLED";
      await deductInventory(item.skuId, item.quantity, [targetState]);
    }

    await createAuditLog(user.id, "CREATE_TRANSFER", "Transfer", transfer.id, {
      destination,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    });

    return {
      success: true,
      message: `Transfer created with ${items.length} item(s) to ${destination}`,
    };
  }

  return { error: "Invalid action" };
};

export default function Transfers() {
  const { user, transfers, transferableSkus, stats, dateFilter } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Transfers</h1>
        <p className="page-subtitle">Transfer inventory to external destinations</p>
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
          <div className="stat-value">{stats.totalTransfers}</div>
          <div className="stat-label">Total Transfers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.todayTransfers}</div>
          <div className="stat-label">Today's Transfers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {stats.totalItemsTransferred._sum.quantity || 0}
          </div>
          <div className="stat-label">Total Items Transferred</div>
        </div>
      </div>

      {/* New Transfer Form */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-title">Create Transfer</h2>
        </div>
        <div className="card-body">
          <Form method="post" id="transfer-form">
            <input type="hidden" name="intent" value="create" />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div className="form-group mb-0">
                <label className="form-label">Destination *</label>
                <input
                  type="text"
                  name="destination"
                  className="form-input"
                  required
                  placeholder="e.g., Warehouse B, Customer Order #123"
                />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Transfer Date</label>
                <input
                  type="date"
                  name="transferDate"
                  className="form-input"
                  defaultValue={new Date().toISOString().split("T")[0]}
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

            {/* Transfer Items */}
            <div className="mb-4">
              <label className="form-label">Items to Transfer</label>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Name</th>
                      <th>Available</th>
                      <th className="w-32">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transferableSkus.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-gray-500 py-8">
                          No transferable inventory available. Build some assemblies or
                          completed products first.
                        </td>
                      </tr>
                    ) : (
                      transferableSkus.map((sku, index) => (
                        <tr key={sku.id}>
                          <td>
                            <input
                              type="hidden"
                              name={`items[${index}][skuId]`}
                              value={sku.id}
                            />
                            <span className="font-mono text-sm">{sku.sku}</span>
                          </td>
                          <td className="max-w-xs truncate">{sku.name}</td>
                          <td>
                            <span className="font-semibold text-green-600">
                              {sku.availableQty}
                            </span>
                          </td>
                          <td>
                            <input
                              type="number"
                              name={`items[${index}][quantity]`}
                              className="form-input w-24"
                              min="0"
                              max={sku.availableQty}
                              defaultValue="0"
                              placeholder="0"
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || transferableSkus.length === 0}
              >
                {isSubmitting ? "Creating..." : "Create Transfer"}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {/* Filter */}
      <div className="card mb-4">
        <div className="card-body py-3">
          <Form method="get" className="flex items-center gap-4">
            <label className="form-label mb-0">Filter by Date:</label>
            <input
              type="date"
              name="date"
              className="form-input w-auto"
              defaultValue={dateFilter || ""}
            />
            <button type="submit" className="btn btn-secondary btn-sm">
              Filter
            </button>
            {dateFilter && (
              <Link to="/transfers" className="btn btn-ghost btn-sm">
                Clear
              </Link>
            )}
          </Form>
        </div>
      </div>

      {/* Transfers History */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Transfer History</h2>
        </div>
        {transfers.length === 0 ? (
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
              <h3 className="empty-state-title">No transfers yet</h3>
              <p className="empty-state-description">
                Create your first transfer using the form above.
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Transfer #</th>
                <th>Destination</th>
                <th>Items</th>
                <th>Total Qty</th>
                <th>Date</th>
                <th>Created By</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((transfer) => {
                const totalQty = transfer.items.reduce(
                  (sum, item) => sum + item.quantity,
                  0
                );
                return (
                  <tr key={transfer.id}>
                    <td>
                      <span className="font-mono text-sm">
                        {transfer.id.slice(0, 8)}
                      </span>
                    </td>
                    <td className="font-medium">{transfer.destination}</td>
                    <td>
                      <div className="text-sm">
                        {transfer.items.slice(0, 2).map((item) => (
                          <div key={item.id}>
                            {item.sku.sku} × {item.quantity}
                          </div>
                        ))}
                        {transfer.items.length > 2 && (
                          <div className="text-gray-500">
                            +{transfer.items.length - 2} more
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="font-semibold">{totalQty}</td>
                    <td>{new Date(transfer.shippedAt).toLocaleDateString()}</td>
                    <td>
                      {transfer.createdBy.firstName} {transfer.createdBy.lastName}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
