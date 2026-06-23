// Read-only Shopify Admin API client for the Bowmar (archery) store.
// Beast Inventory uses this to surface live "Current in Gallatin" inventory
// and unfulfilled line items on the forecasting page.
//
// CONSTRAINT: read-only — only GraphQL `query {}` calls, never `mutation {}`,
// and only GET requests over REST. Beast must not write back to Shopify.

const API_VERSION = "2024-10";

function getCreds() {
  const shop = process.env.ARCHERY_SHOPIFY_STORE;
  const token = process.env.ARCHERY_SHOPIFY_TOKEN;
  if (!shop || !token) {
    throw new Error(
      "Missing Shopify credentials: set ARCHERY_SHOPIFY_STORE and ARCHERY_SHOPIFY_TOKEN"
    );
  }
  return { shop, token };
}

async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  // Hard guard: never let a caller smuggle a mutation through this client.
  if (/\bmutation\b/i.test(query)) {
    throw new Error("Shopify client is read-only; mutations are not allowed");
  }

  const { shop, token } = getCreds();
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  let res: Response | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status !== 429) break;
    const retryAfter = parseFloat(res.headers.get("retry-after") || "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
  }
  if (!res) throw new Error("Shopify request never completed");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Shopify GraphQL returned no data");
  return json.data;
}

// ============================================================
// Locations
// ============================================================

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export async function getLocations(): Promise<ShopifyLocation[]> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string; name: string; isActive: boolean } }[] };
  }>(`
    query {
      locations(first: 50) {
        edges {
          node { id name isActive }
        }
      }
    }
  `);
  return data.locations.edges.map((e) => e.node);
}

let cachedGallatinId: string | null = null;
let cachedAt = 0;
const LOCATION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Generic in-memory TTL cache for the slower Shopify queries (inventory +
// unfulfilled). 5 minutes keeps the forecasting page snappy without making
// stale data a real concern for an internal tool. Survives until the Render
// service restarts.
const DATA_TTL_MS = 5 * 60 * 1000;
const dataCache = new Map<string, { value: unknown; at: number }>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.at < DATA_TTL_MS) {
    return hit.value as T;
  }
  const value = await fetcher();
  dataCache.set(key, { value, at: Date.now() });
  return value;
}

export async function getGallatinLocationId(): Promise<string> {
  const override = process.env.GALLATIN_LOCATION_ID;
  if (override) return override;

  const now = Date.now();
  if (cachedGallatinId && now - cachedAt < LOCATION_TTL_MS) {
    return cachedGallatinId;
  }

  const locations = await getLocations();
  const match = locations.find(
    (l) => l.isActive && l.name.toLowerCase().includes("gallatin")
  );
  if (!match) {
    throw new Error(
      `No active Shopify location matching "Gallatin" — set GALLATIN_LOCATION_ID env var explicitly. Found: ${locations.map((l) => l.name).join(", ")}`
    );
  }
  cachedGallatinId = match.id;
  cachedAt = now;
  return match.id;
}

// ============================================================
// Inventory at a location
// ============================================================

export interface InventoryAtLocation {
  sku: string;
  available: number;
}

/**
 * Fetch inventory levels at a specific location, joined with variant SKUs.
 * Paginated; iterates until Shopify says there's no more.
 */
export async function getInventoryAtLocation(
  locationId: string
): Promise<Map<string, number>> {
  const skuToQty = new Map<string, number>();
  let cursor: string | null = null;

  while (true) {
    const data: any = await shopifyGraphQL(
      `
      query($locationId: ID!, $cursor: String) {
        location(id: $locationId) {
          inventoryLevels(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                quantities(names: ["available"]) { name quantity }
                item {
                  variant { sku }
                }
              }
            }
          }
        }
      }
    `,
      { locationId, cursor }
    );

    const levels = data.location?.inventoryLevels;
    if (!levels) break;

    for (const edge of levels.edges) {
      const sku = edge.node.item?.variant?.sku as string | null;
      if (!sku) continue;
      const available =
        edge.node.quantities.find((q: any) => q.name === "available")?.quantity ?? 0;
      // Sum if a SKU somehow appears more than once
      skuToQty.set(sku, (skuToQty.get(sku) ?? 0) + available);
    }

    if (!levels.pageInfo.hasNextPage) break;
    cursor = levels.pageInfo.endCursor;
  }

  return skuToQty;
}

export async function getGallatinInventory(): Promise<Map<string, number>> {
  return cached("gallatin-inventory", async () => {
    const locationId = await getGallatinLocationId();
    return getInventoryAtLocation(locationId);
  });
}

// ============================================================
// Unfulfilled line items
// ============================================================

export interface UnfulfilledLineItem {
  orderId: string;
  orderName: string;
  orderCreatedAt: string;
  sku: string;
  title: string;
  quantity: number; // remaining fulfillable & unfulfilled (excludes removed/canceled)
}

/**
 * Fetch open, unfulfilled (or partially fulfilled) orders and return their
 * remaining-unfulfilled line items. Aggregating-by-SKU is the caller's job
 * (the forecasting page does this so it can also drill into individual orders).
 */
export async function getUnfulfilledLineItems(): Promise<UnfulfilledLineItem[]> {
  return cached("unfulfilled-line-items", () => fetchUnfulfilledLineItemsUncached());
}

async function fetchUnfulfilledLineItemsUncached(): Promise<UnfulfilledLineItem[]> {
  const items: UnfulfilledLineItem[] = [];
  let cursor: string | null = null;

  while (true) {
    const data: any = await shopifyGraphQL(
      `
      query($cursor: String) {
        orders(
          first: 100,
          after: $cursor,
          query: "fulfillment_status:unfulfilled OR fulfillment_status:partial"
        ) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              createdAt
              cancelledAt
              displayFulfillmentStatus
              lineItems(first: 100) {
                edges {
                  node {
                    sku
                    title
                    quantity
                    currentQuantity
                    unfulfilledQuantity
                  }
                }
              }
            }
          }
        }
      }
    `,
      { cursor }
    );

    const orders = data.orders;
    if (!orders) break;

    for (const orderEdge of orders.edges) {
      const order = orderEdge.node;
      // Skip canceled orders entirely — their line items are not fulfillable.
      if (order.cancelledAt) continue;

      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.sku) continue;

        // currentQuantity = units still on the order AFTER refunds/removals/edits
        // (0 once a line is canceled/removed). This is what's actually
        // fulfillable — never fall back to li.quantity, which is the ORIGINAL
        // ordered amount and would re-include removed/canceled units.
        const current = li.currentQuantity ?? 0;
        if (current <= 0) continue;

        // Of what's still on the order, count only what isn't fulfilled yet,
        // capped at current so a stale unfulfilledQuantity can't exceed it.
        const unfulfilled = li.unfulfilledQuantity ?? current;
        const remaining = Math.min(unfulfilled, current);
        if (remaining <= 0) continue;

        items.push({
          orderId: order.id,
          orderName: order.name,
          orderCreatedAt: order.createdAt,
          sku: li.sku,
          title: li.title,
          quantity: remaining,
        });
      }
    }

    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }

  return items;
}

// ============================================================
// Convenience: aggregate unfulfilled by SKU
// ============================================================

export function aggregateUnfulfilledBySku(
  items: UnfulfilledLineItem[]
): Map<string, { quantity: number; orderCount: number }> {
  const map = new Map<string, { quantity: number; orderCount: number }>();
  const ordersPerSku = new Map<string, Set<string>>();
  for (const it of items) {
    const existing = map.get(it.sku);
    if (existing) {
      existing.quantity += it.quantity;
    } else {
      map.set(it.sku, { quantity: it.quantity, orderCount: 0 });
    }
    let s = ordersPerSku.get(it.sku);
    if (!s) {
      s = new Set();
      ordersPerSku.set(it.sku, s);
    }
    s.add(it.orderId);
  }
  for (const [sku, agg] of map.entries()) {
    agg.orderCount = ordersPerSku.get(sku)?.size ?? 0;
  }
  return map;
}

// ============================================================
// Historical sales by SKU (DtC) — for the demand-projection forecaster.
// Read-only orders query, paginated with cursors, summed by SKU. Cached.
// `start`/`end` are YYYY-MM-DD (inclusive).
// ============================================================

export async function getSalesBySku(start: string, end: string): Promise<Map<string, number>> {
  return cached(`sales-by-sku:${start}:${end}`, () => fetchSalesBySkuUncached(start, end));
}

async function fetchSalesBySkuUncached(start: string, end: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor: string | null = null;
  const q = `created_at:>=${start} created_at:<=${end}`;

  while (true) {
    const data: any = await shopifyGraphQL(
      `
      query($cursor: String, $q: String) {
        orders(first: 100, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              cancelledAt
              lineItems(first: 100) {
                edges { node { sku quantity currentQuantity } }
              }
            }
          }
        }
      }
    `,
      { cursor, q }
    );

    const orders = data.orders;
    if (!orders) break;

    for (const orderEdge of orders.edges) {
      const order = orderEdge.node;
      if (order.cancelledAt) continue; // canceled orders aren't sales
      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.sku) continue;
        // Net of refunds/removals when available; fall back to ordered qty.
        const qty = li.currentQuantity ?? li.quantity ?? 0;
        if (qty <= 0) continue;
        out.set(li.sku, (out.get(li.sku) ?? 0) + qty);
      }
    }

    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }

  return out;
}
