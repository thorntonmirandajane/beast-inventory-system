import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, Form } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "all";

  const whereClause: any = { isActive: true };

  if (search) {
    whereClause.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }

  if (type !== "all") {
    whereClause.type = type.toUpperCase();
  }

  const skus = await prisma.sku.findMany({
    where: whereClause,
    include: {
      bomComponents: {
        select: { id: true },
      },
      usedInBoms: {
        select: { id: true },
      },
      inventoryItems: {
        where: { quantity: { gt: 0 } },
        select: { quantity: true, state: true },
      },
    },
    orderBy: [{ type: "asc" }, { sku: "asc" }],
  });

  const skusWithStats = skus.map((sku) => ({
    ...sku,
    totalInventory: sku.inventoryItems.reduce((sum, item) => sum + item.quantity, 0),
    componentCount: sku.bomComponents.length,
    usedInCount: sku.usedInBoms.length,
  }));

  const counts = {
    all: await prisma.sku.count({ where: { isActive: true } }),
    raw: await prisma.sku.count({ where: { isActive: true, type: "RAW" } }),
    assembly: await prisma.sku.count({ where: { isActive: true, type: "ASSEMBLY" } }),
    completed: await prisma.sku.count({ where: { isActive: true, type: "COMPLETED" } }),
  };

  return { user, skus: skusWithStats, counts, currentType: type, search };
};

export default function SkusList() {
  const { user, skus, counts, currentType, search } = useLoaderData<typeof loader>();

  const tabs = [
    { id: "all", label: "ALL", count: counts.all },
    { id: "raw", label: "RAW MATERIALS", count: counts.raw },
    { id: "assembly", label: "ASSEMBLIES", count: counts.assembly },
    { id: "completed", label: "COMPLETED", count: counts.completed },
  ];

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

  return (
    <Layout user={user}>
      <div className="page-header flex justify-between items-start">
        <div>
          <h1 className="page-title">SKU CATALOG</h1>
          <p className="page-subtitle">BROWSE ALL PRODUCTS AND COMPONENTS</p>
        </div>
        <div className="flex gap-3">
          <Link to="/skus/print" className="btn btn-secondary">
            PRINT BARCODES
          </Link>
          {user.role === "ADMIN" && (
            <Link to="/skus/new" className="btn btn-primary">
              + ADD NEW SKU
            </Link>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="card mb-6">
        <div className="card-body py-3">
          <Form method="get" className="flex items-center gap-4">
            <input type="hidden" name="type" value={currentType} />
            <input
              type="text"
              name="search"
              className="form-input flex-1"
              placeholder="SEARCH BY SKU OR NAME..."
              defaultValue={search}
            />
            <button type="submit" className="btn btn-primary">
              SEARCH
            </button>
            {search && (
              <Link
                to={`/skus?type=${currentType}`}
                className="btn btn-secondary"
              >
                CLEAR
              </Link>
            )}
          </Form>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/skus?type=${tab.id}${search ? `&search=${search}` : ""}`}
            className={`tab ${currentType === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* SKUs Grid */}
      <div className="card">
        {skus.length === 0 ? (
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
              <h3 className="empty-state-title">NO SKUS FOUND</h3>
              <p className="empty-state-description">
                {search
                  ? "TRY A DIFFERENT SEARCH TERM."
                  : "NO SKUS MATCH YOUR FILTERS."}
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Type</th>
                <th className="text-right">Inventory</th>
                <th className="text-right">Components</th>
                <th className="text-right">Used In</th>
              </tr>
            </thead>
            <tbody>
              {skus.map((sku) => (
                <tr key={sku.id}>
                  <td>
                    <Link
                      to={`/skus/${sku.id}`}
                      className="font-mono text-sm text-blue-600 hover:underline"
                    >
                      {sku.sku}
                    </Link>
                  </td>
                  <td className="max-w-xs truncate">{sku.name}</td>
                  <td>
                    <span className={`badge ${getTypeColor(sku.type)}`}>
                      {sku.type}
                    </span>
                  </td>
                  <td className="text-right">
                    <span
                      className={
                        sku.totalInventory > 0
                          ? "font-semibold text-green-600"
                          : "text-gray-400"
                      }
                    >
                      {sku.totalInventory}
                    </span>
                  </td>
                  <td className="text-right">
                    {sku.componentCount > 0 ? (
                      <span className="text-blue-600">{sku.componentCount}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="text-right">
                    {sku.usedInCount > 0 ? (
                      <span className="text-blue-600">{sku.usedInCount}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
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
