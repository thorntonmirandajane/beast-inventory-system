import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type") || "all";
  const search = url.searchParams.get("search") || "";

  // Build where clause
  const whereClause: any = { isActive: true };
  if (typeFilter !== "all") {
    whereClause.type = typeFilter.toUpperCase();
  }
  if (search) {
    whereClause.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }

  // Get SKUs with inventory
  const skus = await prisma.sku.findMany({
    where: whereClause,
    include: {
      inventoryItems: true,
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  // Get pending PO items for raw materials
  const pendingPOItems = await prisma.pOItem.findMany({
    where: {
      purchaseOrder: {
        status: { in: ["SUBMITTED", "PARTIAL"] },
      },
    },
    include: {
      purchaseOrder: true,
    },
  });

  // Build map of pending quantities by SKU
  const pendingBySkuId: Record<string, { quantity: number; poId: string; poNumber: string }[]> = {};
  for (const item of pendingPOItems) {
    const pending = item.quantityOrdered - item.quantityReceived;
    if (pending > 0) {
      if (!pendingBySkuId[item.skuId]) {
        pendingBySkuId[item.skuId] = [];
      }
      pendingBySkuId[item.skuId].push({
        quantity: pending,
        poId: item.purchaseOrder.id,
        poNumber: item.purchaseOrder.poNumber,
      });
    }
  }

  // Calculate inventory totals for each SKU
  const inventory = skus.map((sku) => {
    const byState: Record<string, number> = {
      RECEIVED: 0,
      RAW: 0,
      ASSEMBLED: 0,
      COMPLETED: 0,
    };

    for (const item of sku.inventoryItems) {
      if (byState[item.state] !== undefined) {
        byState[item.state] += item.quantity;
      }
    }

    // Determine "available" based on type
    let available = 0;
    if (sku.type === "RAW") {
      available = byState.RAW;
    } else if (sku.type === "ASSEMBLY") {
      available = byState.ASSEMBLED;
    } else {
      available = byState.COMPLETED;
    }

    // Get pending POs for this SKU (only for RAW)
    const pendingPOs = sku.type === "RAW" ? pendingBySkuId[sku.id] || [] : [];
    const totalPending = pendingPOs.reduce((sum, p) => sum + p.quantity, 0);

    return {
      id: sku.id,
      sku: sku.sku,
      name: sku.name,
      type: sku.type,
      received: byState.RECEIVED,
      available,
      total: Object.values(byState).reduce((a, b) => a + b, 0),
      pendingPOs,
      totalPending,
    };
  });

  // Get counts by type
  const counts = {
    all: await prisma.sku.count({ where: { isActive: true } }),
    raw: await prisma.sku.count({ where: { isActive: true, type: "RAW" } }),
    assembly: await prisma.sku.count({ where: { isActive: true, type: "ASSEMBLY" } }),
    completed: await prisma.sku.count({ where: { isActive: true, type: "COMPLETED" } }),
  };

  return { user, inventory, counts, typeFilter, search };
};

export default function Inventory() {
  const { user, inventory, counts, typeFilter, search } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newSearch = form.get("search") as string;
    const params = new URLSearchParams(searchParams);
    if (newSearch) {
      params.set("search", newSearch);
    } else {
      params.delete("search");
    }
    setSearchParams(params);
  };

  const tabs = [
    { id: "all", label: "ALL", count: counts.all },
    { id: "raw", label: "RAW MATERIALS", count: counts.raw },
    { id: "assembly", label: "ASSEMBLIES", count: counts.assembly },
    { id: "completed", label: "COMPLETED", count: counts.completed },
  ];

  const getTypeClass = (type: string) => {
    switch (type) {
      case "RAW":
        return "sku-type-raw";
      case "ASSEMBLY":
        return "sku-type-assembly";
      case "COMPLETED":
        return "sku-type-completed";
      default:
        return "badge-gray";
    }
  };

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">INVENTORY</h1>
        <p className="page-subtitle">VIEW CURRENT INVENTORY LEVELS BY SKU</p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="SEARCH BY SKU OR NAME..."
            className="form-input max-w-md uppercase"
          />
          <button type="submit" className="btn btn-secondary">
            SEARCH
          </button>
          {search && (
            <Link to="/inventory" className="btn btn-ghost">
              CLEAR
            </Link>
          )}
        </div>
      </form>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/inventory?type=${tab.id}${search ? `&search=${search}` : ""}`}
            className={`tab ${typeFilter === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Inventory Table */}
      <div className="card">
        {inventory.length === 0 ? (
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
                  d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                />
              </svg>
              <h3 className="empty-state-title">NO INVENTORY FOUND</h3>
              <p className="empty-state-description">
                {search
                  ? "TRY A DIFFERENT SEARCH TERM"
                  : "RECEIVE INVENTORY TO SEE IT HERE"}
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>NAME</th>
                <th>TYPE</th>
                <th className="text-right">PENDING POS</th>
                <th className="text-right">AVAILABLE</th>
                <th className="text-right">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link
                      to={`/skus/${item.id}`}
                      className="font-mono text-sm text-beast-600 hover:underline"
                    >
                      {item.sku.toUpperCase()}
                    </Link>
                  </td>
                  <td className="max-w-xs truncate">{item.name.toUpperCase()}</td>
                  <td>
                    <span className={`badge ${getTypeClass(item.type)}`}>
                      {item.type}
                    </span>
                  </td>
                  <td className="text-right">
                    {item.type === "RAW" ? (
                      item.totalPending > 0 ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-yellow-600 font-medium">
                            {item.totalPending}
                          </span>
                          {item.pendingPOs.length > 0 && (
                            <Link
                              to={`/po?status=submitted`}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              ({item.pendingPOs.length} PO{item.pendingPOs.length > 1 ? "S" : ""})
                            </Link>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )
                    ) : (
                      <span className="text-gray-400">N/A</span>
                    )}
                  </td>
                  <td className="text-right font-semibold">
                    {item.available > 0 ? (
                      <span className="text-beast-600">{item.available}</span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="text-right">{item.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
