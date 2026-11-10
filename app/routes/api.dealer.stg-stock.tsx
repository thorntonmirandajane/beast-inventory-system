import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireDealerAuth } from "../utils/dealer-auth.server";
import { getStgAvailableForSkus } from "../utils/stg-stock.server";

// GET  /api/dealer/stg-stock?skus=SKU1,SKU2,...
// POST /api/dealer/stg-stock   { "skus": ["SKU1", "SKU2", ...] }
//
// Returns available STG (in-house / COMPLETED) stock per SKU for the Dealer
// Orders SPS tab. GET is convenient for order-sized lists; POST is there for
// longer lists. Value is units available, or null if the SKU isn't a tracked
// finished-goods item (caller shows "—").
async function respond(skus: string[]) {
  const { stock } = await getStgAvailableForSkus(skus);
  return Response.json({ as_of: new Date().toISOString(), location: "STG", stock });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = requireDealerAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const skus = (url.searchParams.get("skus") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return respond(skus);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = requireDealerAuth(request);
  if (!auth.ok) return auth.response;

  let skus: string[] = [];
  try {
    const body = await request.json();
    if (Array.isArray(body?.skus)) {
      skus = body.skus.map((s: unknown) => String(s).trim()).filter(Boolean);
    }
  } catch {
    return Response.json({ error: "Expected JSON body { skus: string[] }" }, { status: 400 });
  }
  return respond(skus);
};
