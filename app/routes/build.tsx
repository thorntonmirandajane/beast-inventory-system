import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import { getAllBuildEligibility, type BuildEligibility } from "../utils/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("type") || "all";
  const search = url.searchParams.get("search") || "";

  let eligibility = await getAllBuildEligibility();

  // Filter by type
  if (typeFilter !== "all") {
    eligibility = eligibility.filter(
      (e) => e.type === typeFilter.toUpperCase()
    );
  }

  // Filter by search
  if (search) {
    const searchLower = search.toLowerCase();
    eligibility = eligibility.filter(
      (e) =>
        e.sku.toLowerCase().includes(searchLower) ||
        e.name.toLowerCase().includes(searchLower)
    );
  }

  // Group by type for summary
  const summary = {
    assemblies: eligibility.filter((e) => e.type === "ASSEMBLY"),
    completed: eligibility.filter((e) => e.type === "COMPLETED"),
    totalBuildableAssemblies: eligibility
      .filter((e) => e.type === "ASSEMBLY" && e.maxBuildable > 0)
      .reduce((sum, e) => sum + e.maxBuildable, 0),
    totalBuildableCompleted: eligibility
      .filter((e) => e.type === "COMPLETED" && e.maxBuildable > 0)
      .reduce((sum, e) => sum + e.maxBuildable, 0),
  };

  return { user, eligibility, summary, typeFilter, search };
};

export default function BuildEligibility() {
  const { user, eligibility, summary, typeFilter, search } =
    useLoaderData<typeof loader>();
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
    { id: "all", label: "All", count: eligibility.length },
    { id: "assembly", label: "Assemblies", count: summary.assemblies.length },
    { id: "completed", label: "Completed", count: summary.completed.length },
  ];

  const getTypeClass = (type: string) => {
    switch (type) {
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
        <h1 className="page-title">Build Eligibility</h1>
        <p className="page-subtitle">
          See what can be built from current inventory
        </p>
      </div>

      {/* Summary Stats */}
      <div className="stats-grid mb-6">
        <div className="stat-card">
          <div className="stat-label">Assemblies Buildable</div>
          <div className="stat-value text-blue-600">
            {summary.totalBuildableAssemblies.toLocaleString()}
          </div>
          <div className="text-sm text-gray-500 mt-1">
            across {summary.assemblies.filter((a) => a.maxBuildable > 0).length} SKUs
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Completed Buildable</div>
          <div className="stat-value text-green-600">
            {summary.totalBuildableCompleted.toLocaleString()}
          </div>
          <div className="text-sm text-gray-500 mt-1">
            across {summary.completed.filter((c) => c.maxBuildable > 0).length} SKUs
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Blocked SKUs</div>
          <div className="stat-value text-red-600">
            {eligibility.filter((e) => e.maxBuildable === 0).length}
          </div>
          <div className="text-sm text-gray-500 mt-1">Missing components</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total SKUs</div>
          <div className="stat-value">{eligibility.length}</div>
          <div className="text-sm text-gray-500 mt-1">With BOMs defined</div>
        </div>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-4">
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Search by SKU or name..."
            className="form-input max-w-md"
          />
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
          {search && (
            <Link to="/build" className="btn btn-ghost">
              Clear
            </Link>
          )}
        </div>
      </form>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/build?type=${tab.id}${search ? `&search=${search}` : ""}`}
            className={`tab ${typeFilter === tab.id ? "active" : ""}`}
          >
            {tab.label}
            <span className="ml-2 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      {/* Eligibility Grid */}
      {eligibility.length === 0 ? (
        <div className="card">
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
                  d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"
                />
              </svg>
              <h3 className="empty-state-title">No buildable items found</h3>
              <p className="empty-state-description">
                {search
                  ? "Try a different search term"
                  : "Add BOMs to your SKUs to enable build tracking"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {eligibility.map((item) => (
            <div
              key={item.skuId}
              className={`eligibility-card ${
                item.maxBuildable === 0 ? "opacity-60" : ""
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <span className={`badge ${getTypeClass(item.type)}`}>
                  {item.type}
                </span>
                {item.maxBuildable > 0 && (
                  <Link
                    to={`/work-orders/new?skuId=${item.skuId}`}
                    className="btn btn-sm btn-primary"
                  >
                    Build
                  </Link>
                )}
              </div>
              <p className="eligibility-sku">{item.sku}</p>
              <p className="eligibility-name truncate" title={item.name}>
                {item.name}
              </p>
              <p className="eligibility-buildable">
                {item.maxBuildable.toLocaleString()}
                <span className="text-sm font-normal text-gray-500 ml-2">
                  buildable
                </span>
              </p>
              {item.bottleneck && item.maxBuildable === 0 && (
                <p className="eligibility-bottleneck">
                  Blocked by: {item.bottleneck.sku} (need{" "}
                  {item.bottleneck.required}, have {item.bottleneck.available})
                </p>
              )}
              {item.bottleneck && item.maxBuildable > 0 && (
                <p className="text-sm text-amber-600 mt-2">
                  Limited by: {item.bottleneck.sku}
                </p>
              )}

              {/* Component breakdown (collapsed by default, could add expand) */}
              <details className="mt-3">
                <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-700">
                  View {item.components.length} components
                </summary>
                <div className="mt-2 space-y-1">
                  {item.components.map((comp) => (
                    <div
                      key={comp.sku}
                      className="flex justify-between text-xs py-1 border-b border-gray-100"
                    >
                      <span className="font-mono text-gray-600">{comp.sku}</span>
                      <span
                        className={
                          comp.canSupply === 0
                            ? "text-red-600 font-medium"
                            : "text-gray-600"
                        }
                      >
                        {comp.available} / {comp.required} req
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
