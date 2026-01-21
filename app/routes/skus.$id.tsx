import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { calculateBuildEligibility } from "../utils/inventory.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { id } = params;

  const sku = await prisma.sku.findUnique({
    where: { id },
    include: {
      bomComponents: {
        include: {
          componentSku: {
            include: {
              inventoryItems: {
                where: { quantity: { gt: 0 } },
              },
            },
          },
        },
        orderBy: { componentSku: { sku: "asc" } },
      },
      usedInBoms: {
        include: {
          parentSku: true,
        },
        orderBy: { parentSku: { sku: "asc" } },
      },
      inventoryItems: {
        where: { quantity: { gt: 0 } },
        orderBy: { state: "asc" },
      },
    },
  });

  if (!sku) {
    throw new Response("SKU not found", { status: 404 });
  }

  // Calculate build eligibility if this is a buildable SKU
  let buildEligibility = null;
  if (sku.type !== "RAW" && sku.bomComponents.length > 0) {
    buildEligibility = await calculateBuildEligibility(sku.id);
  }

  // Get inventory totals by state
  const inventoryByState = sku.inventoryItems.reduce(
    (acc, item) => {
      acc[item.state] = (acc[item.state] || 0) + item.quantity;
      return acc;
    },
    {} as Record<string, number>
  );

  // Get recent work orders for this SKU
  const recentWorkOrders = await prisma.workOrder.findMany({
    where: { outputSkuId: sku.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      createdBy: true,
    },
  });

  // Get recent receiving records for this SKU
  const recentReceiving = await prisma.receivingRecord.findMany({
    where: { skuId: sku.id },
    orderBy: { receivedAt: "desc" },
    take: 10,
    include: {
      createdBy: true,
    },
  });

  return {
    user,
    sku,
    buildEligibility,
    inventoryByState,
    recentWorkOrders,
    recentReceiving,
  };
};

export default function SkuDetail() {
  const {
    user,
    sku,
    buildEligibility,
    inventoryByState,
    recentWorkOrders,
    recentReceiving,
  } = useLoaderData<typeof loader>();

  const getTypeColor = (type: string) => {
    switch (type) {
      case "RAW":
        return "bg-gray-100 text-gray-800";
      case "ASSEMBLY":
        return "bg-blue-100 text-blue-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case "RECEIVED":
        return "bg-yellow-100 text-yellow-800";
      case "RAW":
        return "bg-gray-100 text-gray-800";
      case "ASSEMBLED":
        return "bg-blue-100 text-blue-800";
      case "COMPLETED":
        return "bg-green-100 text-green-800";
      case "TRANSFERRED":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const totalInventory = Object.values(inventoryByState).reduce(
    (sum, qty) => sum + qty,
    0
  );

  return (
    <Layout user={user}>
      {/* Header */}
      <div className="mb-6">
        <Link to="/inventory" className="text-sm text-gray-500 hover:text-gray-700">
          ← Back to Inventory
        </Link>
      </div>

      <div className="page-header flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="page-title font-mono">{sku.sku}</h1>
            <span className={`badge ${getTypeColor(sku.type)}`}>{sku.type}</span>
            {!sku.isActive && (
              <span className="badge bg-red-100 text-red-800">Inactive</span>
            )}
          </div>
          <p className="page-subtitle">{sku.name}</p>
        </div>

        {buildEligibility && buildEligibility.maxBuildable > 0 && (
          <Link
            to={`/work-orders?sku=${sku.id}`}
            className="btn btn-primary"
          >
            Create Work Order
          </Link>
        )}
      </div>

      {/* Stats Grid */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-value">{totalInventory}</div>
          <div className="stat-label">Total Inventory</div>
        </div>
        {buildEligibility && (
          <>
            <div className="stat-card">
              <div
                className={`stat-value ${
                  buildEligibility.maxBuildable > 0
                    ? "text-green-600"
                    : "text-red-600"
                }`}
              >
                {buildEligibility.maxBuildable}
              </div>
              <div className="stat-label">Max Buildable</div>
            </div>
            {buildEligibility.bottleneck && (
              <div className="stat-card">
                <div className="stat-value text-sm font-mono">
                  {buildEligibility.bottleneck.sku}
                </div>
                <div className="stat-label">Bottleneck Component</div>
              </div>
            )}
          </>
        )}
        <div className="stat-card">
          <div className="stat-value">{sku.bomComponents.length}</div>
          <div className="stat-label">Components</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{sku.usedInBoms.length}</div>
          <div className="stat-label">Used In</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inventory by State */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Inventory by State</h2>
          </div>
          <div className="card-body">
            {Object.keys(inventoryByState).length === 0 ? (
              <p className="text-gray-500">No inventory for this SKU</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(inventoryByState).map(([state, qty]) => (
                  <div
                    key={state}
                    className="flex justify-between items-center p-3 bg-gray-50 rounded-lg"
                  >
                    <span className={`badge ${getStateColor(state)}`}>{state}</span>
                    <span className="font-semibold">{qty}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Bill of Materials */}
        {sku.bomComponents.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Bill of Materials</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Component SKU</th>
                  <th>Name</th>
                  <th className="text-right">Qty Needed</th>
                  <th className="text-right">Available</th>
                </tr>
              </thead>
              <tbody>
                {sku.bomComponents.map((bom) => {
                  const available = bom.componentSku.inventoryItems.reduce(
                    (sum, item) => sum + item.quantity,
                    0
                  );
                  return (
                    <tr key={bom.id}>
                      <td>
                        <Link
                          to={`/skus/${bom.componentSku.id}`}
                          className="font-mono text-sm text-blue-600 hover:underline"
                        >
                          {bom.componentSku.sku}
                        </Link>
                      </td>
                      <td className="max-w-xs truncate text-sm">
                        {bom.componentSku.name}
                      </td>
                      <td className="text-right font-semibold">{bom.quantity}</td>
                      <td
                        className={`text-right font-semibold ${
                          available >= bom.quantity
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {available}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Used In */}
        {sku.usedInBoms.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Used In</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Parent SKU</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className="text-right">Qty Per</th>
                </tr>
              </thead>
              <tbody>
                {sku.usedInBoms.map((bom) => (
                  <tr key={bom.id}>
                    <td>
                      <Link
                        to={`/skus/${bom.parentSku.id}`}
                        className="font-mono text-sm text-blue-600 hover:underline"
                      >
                        {bom.parentSku.sku}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate text-sm">
                      {bom.parentSku.name}
                    </td>
                    <td>
                      <span className={`badge ${getTypeColor(bom.parentSku.type)}`}>
                        {bom.parentSku.type}
                      </span>
                    </td>
                    <td className="text-right font-semibold">{bom.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent Work Orders */}
        {recentWorkOrders.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Work Orders</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Target</th>
                  <th>Built</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentWorkOrders.map((wo) => (
                  <tr key={wo.id}>
                    <td className="font-mono text-sm">{wo.orderNumber.slice(0, 8)}</td>
                    <td>{wo.quantityToBuild}</td>
                    <td>{wo.quantityBuilt}</td>
                    <td>
                      <span
                        className={`badge ${
                          wo.status === "COMPLETED"
                            ? "status-completed"
                            : wo.status === "IN_PROGRESS"
                            ? "status-in-progress"
                            : wo.status === "CANCELLED"
                            ? "status-rejected"
                            : "status-pending"
                        }`}
                      >
                        {wo.status}
                      </span>
                    </td>
                    <td>{new Date(wo.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent Receiving */}
        {recentReceiving.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Receiving</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Quantity</th>
                  <th>Status</th>
                  <th>PO #</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentReceiving.map((rec) => (
                  <tr key={rec.id}>
                    <td className="font-semibold">{rec.quantity}</td>
                    <td>
                      <span
                        className={`badge ${
                          rec.status === "APPROVED"
                            ? "status-approved"
                            : rec.status === "REJECTED"
                            ? "status-rejected"
                            : "status-pending"
                        }`}
                      >
                        {rec.status}
                      </span>
                    </td>
                    <td>{rec.poNumber || "—"}</td>
                    <td>{new Date(rec.receivedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
