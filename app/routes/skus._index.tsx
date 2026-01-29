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
  const processFilter = url.searchParams.get("process") || "";
  const categoryFilter = url.searchParams.get("category") || "";

  const whereClause: any = { isActive: true };

  if (search) {
    whereClause.OR = [
      { sku: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
  }

  if (type === "raw") {
    whereClause.type = "RAW";
  } else if (type === "finished") {
    // Combine ASSEMBLY and COMPLETED into "finished" tab
    whereClause.type = { in: ["ASSEMBLY", "COMPLETED"] };
  } else if (type !== "all") {
    whereClause.type = type.toUpperCase();
  }

  if (processFilter) {
    whereClause.material = processFilter;
  }

  if (categoryFilter) {
    whereClause.category = categoryFilter;
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
    orderBy: [
      { processOrder: "asc" },
      { type: "asc" },
      { sku: "asc" }
    ],
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
    finished: await prisma.sku.count({ where: { isActive: true, type: { in: ["ASSEMBLY", "COMPLETED"] } } }),
  };

  // Get unique processes and categories for filters
  const uniqueProcesses = await prisma.sku.findMany({
    where: { material: { not: null }, isActive: true },
    select: { material: true },
    distinct: ["material"],
    orderBy: { material: "asc" },
  });

  const uniqueCategories = await prisma.sku.findMany({
    where: { category: { not: null }, isActive: true },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });

  return {
    user,
    skus: skusWithStats,
    counts,
    currentType: type,
    search,
    processFilter,
    categoryFilter,
    processes: uniqueProcesses.map(p => p.material).filter(Boolean) as string[],
    categories: uniqueCategories.map(c => c.category).filter(Boolean) as string[],
  };
};

export default function SkusList() {
  const { user, skus, counts, currentType, search, processFilter, categoryFilter, processes, categories } = useLoaderData<typeof loader>();

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "raw", label: "Raw Materials", count: counts.raw },
    { id: "finished", label: "Assembled", count: counts.finished },
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
          <h1 className="page-title">SKU Catalog</h1>
          <p className="page-subtitle">Browse all products and components</p>
        </div>
        <div className="flex gap-3">
          <Link to="/skus/print" className="btn btn-secondary">
            Print Barcodes
          </Link>
          {user.role === "ADMIN" && (
            <>
              <Link to="/capacity" className="btn btn-secondary">
                <svg className="w-4 h-4 mr-1 inline" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Manage Categories & Processes
              </Link>
              <Link to="/skus/export" className="btn btn-secondary">
                Export CSV
              </Link>
              <Link to="/skus/import" className="btn btn-secondary">
                Import CSV
              </Link>
              <Link to="/skus/new" className="btn btn-primary">
                + Add New SKU
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Search and Filters */}
      <div className="card mb-6">
        <div className="card-body">
          <Form method="get">
            <input type="hidden" name="type" value={currentType} />
            <div className="flex flex-col gap-4">
              <input
                type="text"
                name="search"
                className="form-input text-base py-3 px-4"
                placeholder="Search by SKU or name..."
                defaultValue={search}
              />
              <div className="flex items-center gap-4">
                <select
                  name="process"
                  className="form-input flex-1"
                  defaultValue={processFilter}
                >
                  <option value="">All Materials</option>
                  {processes.map((process) => (
                    <option key={process} value={process}>
                      {process}
                    </option>
                  ))}
                </select>
                <select
                  name="category"
                  className="form-input flex-1"
                  defaultValue={categoryFilter}
                >
                  <option value="">All Categories</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-primary">
                  Filter
                </button>
                {(search || processFilter || categoryFilter) && (
                  <Link
                    to={`/skus?type=${currentType}`}
                    className="btn btn-secondary"
                  >
                    Clear
                  </Link>
                )}
              </div>
            </div>
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
              <h3 className="empty-state-title">No SKUs found</h3>
              <p className="empty-state-description">
                {search
                  ? "Try a different search term."
                  : "No SKUs match your filters."}
              </p>
            </div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>SKU</th>
                <th>Name</th>
                <th>Type</th>
                <th>Material</th>
                <th>Category</th>
                <th className="text-right">Inventory</th>
                <th className="text-right">Components</th>
                <th className="text-right">Used In</th>
              </tr>
            </thead>
            <tbody>
              {skus.map((sku) => (
                <tr key={sku.id}>
                  <td>
                    <span className="text-gray-600 font-mono text-sm">
                      {sku.processOrder ?? "—"}
                    </span>
                  </td>
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
                  <td>
                    {sku.material ? (
                      <span className="badge bg-yellow-100 text-yellow-800 text-xs">
                        {sku.material}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td>
                    {sku.category ? (
                      <span className="badge bg-purple-100 text-purple-800 text-xs">
                        {sku.category.replace("_", " ")}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
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
