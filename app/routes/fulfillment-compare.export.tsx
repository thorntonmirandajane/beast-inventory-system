import type { LoaderFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import { runStrategy, ordersToCsv, type ShipFrom } from "../utils/fulfillment-strategy.server";
import { STRATEGIES, type StrategyKind } from "../utils/strategy-kinds";

// GET /fulfillment-compare/export?kind=&location=&store=&customers=&name=
//
// A download has to be its own GET route: returning a file Response from an
// action sends the body back as action data instead, and the page renders the
// CSV as if it were state.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);

  const kind = url.searchParams.get("kind") as StrategyKind;
  if (!STRATEGIES.some((s) => s.kind === kind)) {
    throw new Response("Unknown strategy", { status: 400 });
  }
  const locationParam = url.searchParams.get("location");
  const location: ShipFrom = locationParam === "UTAH" ? "UTAH" : locationParam === "EITHER" ? "EITHER" : "GALLATIN";
  const scenarioName = (url.searchParams.get("name") || "Scenario").slice(0, 80);

  const result = await runStrategy({
    kind,
    location,
    storeFilter: url.searchParams.get("store") || "all",
    priorityCustomers: (url.searchParams.get("customers") || "").split(",").map((c) => c.trim()).filter(Boolean),
  });

  const csv = ordersToCsv(result, scenarioName);
  const slug = `${scenarioName}-${result.label}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug || "scenario"}_${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
