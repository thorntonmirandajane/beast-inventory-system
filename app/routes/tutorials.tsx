import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useSearchParams } from "react-router";
import { requireUser } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const skuId = url.searchParams.get("sku");
  const processName = url.searchParams.get("process");

  // Get all tutorials with SKU details
  let tutorials = await prisma.processTutorial.findMany({
    where: { isActive: true },
    include: {
      skuTutorials: true,
    },
    orderBy: [{ processName: "asc" }, { title: "asc" }],
  });

  // Get all SKU IDs from tutorials
  const allSkuIds = tutorials.flatMap(t => t.skuTutorials.map(st => st.skuId));
  const uniqueSkuIds = [...new Set(allSkuIds)];

  // Fetch SKU details
  const skuDetails = await prisma.sku.findMany({
    where: { id: { in: uniqueSkuIds } },
    select: { id: true, sku: true, name: true },
  });

  const skuMap = new Map(skuDetails.map(sku => [sku.id, sku]));

  // Filter by SKU if provided
  if (skuId) {
    tutorials = tutorials.filter(t =>
      t.skuTutorials.some(st => st.skuId === skuId)
    );
  }

  // Filter by process if provided
  if (processName) {
    tutorials = tutorials.filter(t => t.processName === processName);
  }

  // Get SKU info for display
  const skuInfo = skuId
    ? await prisma.sku.findUnique({
        where: { id: skuId },
        select: { sku: true, name: true, material: true },
      })
    : null;

  // Get all unique processes for filtering
  const allProcesses = await prisma.processTutorial.findMany({
    where: { isActive: true },
    select: { processName: true },
    distinct: ["processName"],
    orderBy: { processName: "asc" },
  });

  // Group tutorials by process
  const tutorialsByProcess = tutorials.reduce((acc, tutorial) => {
    if (!acc[tutorial.processName]) {
      acc[tutorial.processName] = [];
    }
    acc[tutorial.processName].push(tutorial);
    return acc;
  }, {} as Record<string, typeof tutorials>);

  return {
    user,
    tutorialsByProcess,
    skuInfo,
    allProcesses: allProcesses.map(p => p.processName),
    currentProcess: processName,
    skuMap: Object.fromEntries(skuMap),
  };
};

export default function Tutorials() {
  const { user, tutorialsByProcess, skuInfo, allProcesses, currentProcess, skuMap } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const hasNoTutorials = Object.keys(tutorialsByProcess).length === 0;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Process Tutorials</h1>
        {skuInfo ? (
          <p className="page-subtitle">
            Tutorials for <span className="font-mono">{skuInfo.sku}</span> - {skuInfo.name}
          </p>
        ) : (
          <p className="page-subtitle">Learn how to complete each process</p>
        )}
      </div>

      {/* Filter by Process */}
      <div className="card mb-6">
        <div className="card-body">
          <div className="flex flex-wrap gap-2">
            <Link
              to="/tutorials"
              className={`btn btn-sm ${
                !currentProcess ? "btn-primary" : "btn-ghost"
              }`}
            >
              All Processes
            </Link>
            {allProcesses.map(process => (
              <Link
                key={process}
                to={`/tutorials?process=${encodeURIComponent(process)}`}
                className={`btn btn-sm ${
                  currentProcess === process ? "btn-primary" : "btn-ghost"
                }`}
              >
                {process}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {hasNoTutorials ? (
        <div className="card">
          <div className="card-body text-center py-12">
            <svg
              className="w-16 h-16 mx-auto text-gray-400 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
              />
            </svg>
            <h3 className="text-xl font-semibold text-gray-700 mb-2">
              No Tutorials Available
            </h3>
            <p className="text-gray-500">
              {skuInfo
                ? `No tutorials have been created for ${skuInfo.sku} yet.`
                : currentProcess
                ? `No tutorials available for ${currentProcess}.`
                : "Check back later for process tutorials."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(tutorialsByProcess).map(([processName, processTutorials]) => (
            <div key={processName} className="card">
              <div className="card-header bg-blue-50">
                <h2 className="card-title text-blue-900">{processName}</h2>
                <p className="text-sm text-blue-700">
                  {processTutorials.length} tutorial{processTutorials.length !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="card-body">
                <div className="space-y-6">
                  {processTutorials.map(tutorial => (
                    <div
                      key={tutorial.id}
                      className="border-l-4 border-blue-500 pl-4 py-2"
                    >
                      <h3 className="text-lg font-semibold mb-3">{tutorial.title}</h3>

                      {tutorial.photoUrl && (
                        <div className="mb-4">
                          <img
                            src={tutorial.photoUrl}
                            alt={tutorial.title}
                            className="max-w-full h-auto rounded-lg shadow-md max-h-96 object-contain"
                          />
                        </div>
                      )}

                      <div className="prose prose-sm max-w-none mb-4">
                        <p className="whitespace-pre-wrap text-gray-700">
                          {tutorial.description}
                        </p>
                      </div>

                      <div className="border-t pt-3 mt-3">
                        <p className="text-xs text-gray-500 mb-2">Applies to:</p>
                        <div className="flex flex-wrap gap-2">
                          {tutorial.skuTutorials.map(st => {
                            const sku = skuMap[st.skuId];
                            return sku ? (
                              <span
                                key={st.id}
                                className="badge bg-gray-100 text-gray-700 font-mono text-xs"
                                title={sku.name}
                              >
                                {sku.sku}
                              </span>
                            ) : null;
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
