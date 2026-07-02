// Read-only client for the queued-orders app's /api/programmed-orders endpoint.
// Used on the forecasting page to surface upcoming/scheduled orders by SKU.
//
// CONSTRAINT: read-only — only GET requests, no POST/PUT/DELETE.

export interface ProgrammedOrderLineItem {
  sku: string | null;
  productTitle: string;
  variantTitle: string | null;
  quantity: number;
}

export interface ProgrammedOrder {
  id: string;
  scheduledDate: string;
  customerName: string;
  companyName: string | null;
  poNumber: string | null;
  totalAmount: number;
  holdAutoConvert: boolean;
  lineItems: ProgrammedOrderLineItem[];
}

export interface ProgrammedOrdersResponse {
  from: string;
  to: string;
  shop_filter: string | null;
  count: number;
  totalUnits: number;
  totalAmount: number;
  bySku: { sku: string; quantity: number; orderCount: number }[];
  orders: ProgrammedOrder[];
}

export interface FetchOptions {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  shop?: string;
}

// Short in-memory cache so the Forecast tab (which also needs programmed
// totals) doesn't hammer the queued-orders service on every page load.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: ProgrammedOrdersResponse; at: number }>();

export async function fetchProgrammedOrders(
  opts: FetchOptions
): Promise<ProgrammedOrdersResponse> {
  const key = `${opts.from}|${opts.to}|${opts.shop ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }

  const baseUrl = process.env.QUEUED_ORDERS_API_URL;
  const secret = process.env.BEAST_API_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "Programmed orders feed not configured: set QUEUED_ORDERS_API_URL and BEAST_API_SECRET"
    );
  }

  const url = new URL("/api/programmed-orders", baseUrl);
  url.searchParams.set("from", opts.from);
  url.searchParams.set("to", opts.to);
  if (opts.shop) url.searchParams.set("shop", opts.shop);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-beast-secret": secret },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Programmed orders fetch ${res.status}: ${body.slice(0, 300)}`);
  }
  const value = (await res.json()) as ProgrammedOrdersResponse;
  cache.set(key, { value, at: Date.now() });
  return value;
}
