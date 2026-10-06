import type { LoaderFunctionArgs } from "react-router";
import { requireRole } from "../utils/auth.server";
import prisma from "../db.server";
import { previewPlan, parseRules, toMatrixifyCsv, type PlanLocation } from "../utils/fulfillment-plan.server";

// GET /fulfillment-plans/export?plan=<id>&skipActioned=1
//
// Download only — the plan is committed and marked exported by the POST on the
// plans page, which then redirects here. A file Response returned straight from
// an action comes back as action data instead of downloading.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireRole(request, ["ADMIN", "MANAGER"]);
  const url = new URL(request.url);
  const planId = url.searchParams.get("plan") || "";

  const plan = await prisma.fulfillmentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Response("Plan not found", { status: 404 });

  const preview = await previewPlan({
    planId: plan.id,
    planName: plan.name,
    location: plan.location as PlanLocation,
    storeFilter: plan.storeFilter,
    noteTemplate: plan.noteTemplate,
    rules: parseRules(plan.rules),
    skipActioned: url.searchParams.get("skipActioned") === "1",
  });

  const csv = toMatrixifyCsv(preview, plan.name);
  const slug = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="matrixify_${slug}_${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
