// Read-only Shopify Admin API client for the Bowmar stores.
// Beast Inventory uses this to surface live "Current in Gallatin" inventory
// and unfulfilled line items (from BOTH the Bowmar Archery and Beast Broadhead
// stores) on the forecasting page.
//
// CONSTRAINT: read-only — only GraphQL `query {}` calls, never `mutation {}`,
// and only GET requests over REST. Beast must not write back to Shopify.

const API_VERSION = "2024-10";

export type StoreSource = "archery" | "beast";
interface StoreCreds {
  shop: string;
  token: string;
}

function getArcheryCreds(): StoreCreds {
  const shop = process.env.ARCHERY_SHOPIFY_STORE;
  const token = process.env.ARCHERY_SHOPIFY_TOKEN;
  if (!shop || !token) {
    throw new Error(
      "Missing Shopify credentials: set ARCHERY_SHOPIFY_STORE and ARCHERY_SHOPIFY_TOKEN"
    );
  }
  return { shop, token };
}

// Beast store is optional — if its env vars aren't set (e.g. locally, or before
// they're added in Render) we simply skip it rather than erroring, so the
// Archery data keeps working on its own.
function getBeastCreds(): StoreCreds | null {
  const shop = process.env.BEAST_SHOPIFY_STORE;
  const token = process.env.BEAST_SHOPIFY_TOKEN;
  if (!shop || !token) return null;
  return { shop, token };
}

async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  creds: StoreCreds = getArcheryCreds()
): Promise<T> {
  // Hard guard: never let a caller smuggle a mutation through this client.
  if (/\bmutation\b/i.test(query)) {
    throw new Error("Shopify client is read-only; mutations are not allowed");
  }

  const { shop, token } = creds;
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
      // Cap each request so a slow/hung Shopify page can't stall the loader.
      signal: AbortSignal.timeout(25000),
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

// Stale-while-revalidate in-memory cache for the slower Shopify queries
// (inventory + unfulfilled + sales). When a cached value goes stale we return it
// immediately AND kick a background refresh, so the forecasting page paints with
// the last-known numbers instantly instead of blocking on Shopify. Survives
// until the Render service restarts.
const DATA_TTL_MS = 5 * 60 * 1000;
const dataCache = new Map<string, { value: unknown; at: number; refreshing: boolean }>();

// Count of in-flight background refreshes, so the UI can show a "Syncing with
// Shopify" pill while live data is being pulled behind a stale render.
let pendingRefreshes = 0;
export function isShopifySyncing(): boolean {
  return pendingRefreshes > 0;
}

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = dataCache.get(key);
  if (hit) {
    const isStale = Date.now() - hit.at >= DATA_TTL_MS;
    if (isStale && !hit.refreshing) {
      hit.refreshing = true;
      pendingRefreshes++;
      fetcher()
        .then((v) => dataCache.set(key, { value: v, at: Date.now(), refreshing: false }))
        .catch((err) => {
          hit.refreshing = false; // keep the stale value; try again next time
          console.error(`[shopify] background refresh failed for ${key}:`, err instanceof Error ? err.message : err);
        })
        .finally(() => {
          pendingRefreshes--;
        });
    }
    return hit.value as T; // serve cached immediately (stale-while-revalidate)
  }
  // Cold cache — block on the first fetch.
  const value = await fetcher();
  dataCache.set(key, { value, at: Date.now(), refreshing: false });
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
  source: StoreSource; // which Shopify store the order came from
}

/**
 * Fetch open, unfulfilled (or partially fulfilled) orders from BOTH the Archery
 * and Beast stores and return their remaining-unfulfilled line items, each
 * tagged with its source store. Aggregating-by-SKU is the caller's job (the
 * forecasting page does this so it can also drill into individual orders).
 *
 * The Beast store is optional: if its credentials aren't configured we return
 * only Archery's items. Both stores are fetched concurrently and cached per
 * store, so a slow store doesn't hold up the other.
 */
export async function getUnfulfilledLineItems(): Promise<UnfulfilledLineItem[]> {
  const archery = cached("unfulfilled:archery", () =>
    fetchUnfulfilledForStore(getArcheryCreds(), "archery")
  );

  const beastCreds = getBeastCreds();
  const beast = beastCreds
    ? cached("unfulfilled:beast", () => fetchUnfulfilledForStore(beastCreds, "beast"))
    : Promise.resolve([] as UnfulfilledLineItem[]);

  const [archeryItems, beastItems] = await Promise.all([archery, beast]);
  return [...archeryItems, ...beastItems];
}

async function fetchUnfulfilledForStore(
  creds: StoreCreds,
  source: StoreSource
): Promise<UnfulfilledLineItem[]> {
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
      { cursor },
      creds
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
          source,
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

export interface UnfulfilledSkuAgg {
  quantity: number; // total across both stores
  beastQuantity: number;
  archeryQuantity: number;
  orderCount: number; // distinct orders across both stores
}

export function aggregateUnfulfilledBySku(
  items: UnfulfilledLineItem[]
): Map<string, UnfulfilledSkuAgg> {
  const map = new Map<string, UnfulfilledSkuAgg>();
  const ordersPerSku = new Map<string, Set<string>>();
  for (const it of items) {
    let agg = map.get(it.sku);
    if (!agg) {
      agg = { quantity: 0, beastQuantity: 0, archeryQuantity: 0, orderCount: 0 };
      map.set(it.sku, agg);
    }
    agg.quantity += it.quantity;
    if (it.source === "beast") agg.beastQuantity += it.quantity;
    else agg.archeryQuantity += it.quantity;

    let s = ordersPerSku.get(it.sku);
    if (!s) {
      s = new Set();
      ordersPerSku.set(it.sku, s);
    }
    // Namespace by source: order gids can collide between the two stores.
    s.add(`${it.source}:${it.orderId}`);
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

// Same window, but split each line into fulfilled vs still-unfulfilled units
// (line-level, so partially-shipped orders split correctly).
export async function getSalesBreakdownBySku(
  start: string,
  end: string
): Promise<Map<string, { fulfilled: number; unfulfilled: number }>> {
  return cached(`sales-breakdown:${start}:${end}`, () => fetchSalesBreakdownUncached(start, end));
}

async function fetchSalesBreakdownUncached(
  start: string,
  end: string
): Promise<Map<string, { fulfilled: number; unfulfilled: number }>> {
  const out = new Map<string, { fulfilled: number; unfulfilled: number }>();
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
                edges { node { sku quantity currentQuantity unfulfilledQuantity } }
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
      if (order.cancelledAt) continue;
      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.sku) continue;
        const current = li.currentQuantity ?? li.quantity ?? 0;
        if (current <= 0) continue;
        const unfulfilled = Math.min(li.unfulfilledQuantity ?? 0, current);
        const fulfilled = current - unfulfilled;
        const e = out.get(li.sku) ?? { fulfilled: 0, unfulfilled: 0 };
        e.fulfilled += fulfilled;
        e.unfulfilled += unfulfilled;
        out.set(li.sku, e);
      }
    }
    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }
  return out;
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

// ============================================================
// Fulfilled orders on a given day (ShipHero vs Utah)
// ------------------------------------------------------------
// Powers the "Fulfilled Orders" tab: for a chosen calendar day (Mountain Time),
// how many orders shipped, how many of each SKU, split by which fulfillment
// SERVICE shipped them. ShipHero registers as a third-party fulfillment service
// in Shopify; anything Bowmar ships in-house (the manual/default service at the
// Utah location) is bucketed as "Utah". Read from each fulfillment's `service`
// (with `location` as a secondary signal), which is the structured equivalent of
// the "Fulfilled by ShipHero" line you see in the Shopify order timeline.
// ============================================================

export type FulfillmentChannel = "shiphero" | "utah";

export interface FulfilledLineItem {
  store: StoreSource;
  orderId: string;
  orderName: string;
  fulfillmentId: string;
  fulfilledAt: string; // ISO timestamp the fulfillment was created
  sku: string;
  title: string;
  quantity: number;
  channel: FulfillmentChannel;
  serviceLabel: string; // the app/service that marked it fulfilled (timeline actor)
  locationName: string | null; // where it shipped from — "Utah" for both channels
}

// Substrings (case-insensitive) that identify ShipHero as the app that fulfilled
// an order. The signal is the TIMELINE EVENT that created the fulfillment, whose
// actor is "ShipHero Inventory & Shipping" (vs. "OD Auto-Fulfill" or a staff
// member for in-house). Shopify's structured `service` is "Manual" and the
// location is "Utah" for BOTH, so neither can distinguish them — only the event's
// app (`appTitle`) / message can. Everything that doesn't match here is treated as
// Utah (in-house). Override with SHIPHERO_SERVICE_MATCH="shiphero,..." if needed.
function shipheroMatchers(): string[] {
  const raw = process.env.SHIPHERO_SERVICE_MATCH;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["shiphero"];
}

function isShipheroActor(appTitle: string | null, message: string | null): boolean {
  const hay = `${appTitle ?? ""} ${message ?? ""}`.toLowerCase();
  return shipheroMatchers().some((m) => hay.includes(m));
}

// A short "who fulfilled this" label: prefer the app title Shopify records on the
// event, else the actor text before "marked"/"fulfilled" in the message.
function fulfillmentActorLabel(appTitle: string | null, message: string | null): string {
  if (appTitle && appTitle.trim()) return appTitle.trim();
  const text = (message ?? "").replace(/<[^>]+>/g, "").trim();
  const lower = text.toLowerCase();
  for (const b of [" marked ", " fulfilled ", " created "]) {
    const i = lower.indexOf(b);
    if (i > 0) return text.slice(0, i).trim();
  }
  return text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : "Manual / in-house";
}

// A timeline event that created a fulfillment (as opposed to shipping-email,
// archive, note, etc. events). Shopify phrases these as
// "<actor> marked N item(s) as fulfilled from <location>".
function isFulfillmentCreationEvent(message: string | null): boolean {
  return !!message && /fulfilled/i.test(message) && /(marked|fulfill)/i.test(message);
}

// Format a UTC instant as its calendar day (YYYY-MM-DD) in US Mountain Time,
// so a fulfillment created at 11pm MT lands on the right day regardless of the
// server's timezone. en-CA yields ISO-style YYYY-MM-DD.
const MT_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function mountainDay(iso: string): string {
  return MT_DAY_FMT.format(new Date(iso));
}

// We can't filter Shopify's order search by "fulfilled on day D" directly, so we
// query orders UPDATED across the range (a fulfillment bumps updated_at) and then
// keep only the fulfillments whose own createdAt lands on an MT day within
// [from, to]. Pad the window: start earlier than either possible MT midnight
// (DST), and extend the end so an order fulfilled in-range but edited later is
// still returned.
const UPDATED_BUFFER_DAYS = 30;
function updatedWindowUtc(fromYmd: string, toYmd: string): { startIso: string; endIso: string } {
  // MST midnight = 07:00Z; MDT midnight = 06:00Z. Start 2h before the earlier one.
  const startApprox = Date.parse(`${fromYmd}T00:00:00-07:00`);
  const start = new Date(startApprox - 2 * 3600 * 1000);
  // MDT end-of-day is 05:59Z next day; pad the far side for late edits.
  const endApprox = Date.parse(`${toYmd}T23:59:59-06:00`);
  const end = new Date(endApprox + (UPDATED_BUFFER_DAYS * 24 + 2) * 3600 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// We read each order's timeline `events` to learn which app created each
// fulfillment (`appTitle`). The `message` is a formatted string we also scan as a
// backstop. 25 events comfortably covers the fulfillment activity on a typical
// order without blowing up the query cost.
const FULFILLED_QUERY = `
  query($cursor: String, $q: String) {
    orders(first: 100, after: $cursor, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          cancelledAt
          fulfillments(first: 10) {
            id
            status
            createdAt
            location { name }
            fulfillmentLineItems(first: 100) {
              edges { node { quantity lineItem { sku title } } }
            }
          }
          events(first: 25, sortKey: CREATED_AT, reverse: true) {
            edges { node { id createdAt appTitle message } }
          }
        }
      }
    }
  }
`;

async function fetchFulfilledForStore(
  creds: StoreCreds,
  source: StoreSource,
  fromYmd: string,
  toYmd: string
): Promise<FulfilledLineItem[]> {
  const items: FulfilledLineItem[] = [];
  const { startIso, endIso } = updatedWindowUtc(fromYmd, toYmd);
  const q = `updated_at:>=${startIso} updated_at:<=${endIso}`;
  let cursor: string | null = null;

  while (true) {
    const data: any = await shopifyGraphQL(FULFILLED_QUERY, { cursor, q }, creds);

    const orders = data.orders;
    if (!orders) break;

    for (const orderEdge of orders.edges) {
      const order = orderEdge.node;
      if (order.cancelledAt) continue; // canceled orders didn't really ship

      // The order's fulfillment-creation timeline events, with the app that made
      // each one. We match a fulfillment to its event by nearest createdAt, so a
      // split order (some items shipped by ShipHero, some in-house) classifies
      // each fulfillment correctly.
      const fulfillEvents = (order.events?.edges ?? [])
        .map((e: any) => e.node)
        .filter((n: any) => isFulfillmentCreationEvent(n?.message))
        .map((n: any) => ({
          at: Date.parse(n.createdAt),
          appTitle: (n.appTitle ?? null) as string | null,
          message: (n.message ?? null) as string | null,
        }));

      for (const f of order.fulfillments ?? []) {
        // Only count fulfillments that actually shipped (success), whose MT day
        // falls within the requested [from, to] range (inclusive).
        if (f.status && f.status !== "SUCCESS") continue;
        const day = mountainDay(f.createdAt);
        if (day < fromYmd || day > toYmd) continue;

        // Find the creation event closest in time to this fulfillment.
        const fAt = Date.parse(f.createdAt);
        let best: { at: number; appTitle: string | null; message: string | null } | null = null;
        let bestDiff = Infinity;
        for (const ev of fulfillEvents) {
          const diff = Math.abs(ev.at - fAt);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = ev;
          }
        }

        const channel: FulfillmentChannel =
          best && isShipheroActor(best.appTitle, best.message) ? "shiphero" : "utah";
        const serviceLabel = best
          ? fulfillmentActorLabel(best.appTitle, best.message)
          : "Manual / in-house";
        const locationName = f.location?.name ?? null;

        for (const liEdge of f.fulfillmentLineItems?.edges ?? []) {
          const li = liEdge.node;
          const sku = li.lineItem?.sku;
          const qty = li.quantity ?? 0;
          if (!sku || qty <= 0) continue;
          items.push({
            store: source,
            orderId: order.id,
            orderName: order.name,
            fulfillmentId: f.id,
            fulfilledAt: f.createdAt,
            sku,
            title: li.lineItem?.title ?? "",
            quantity: qty,
            locationName,
            channel,
            serviceLabel,
          });
        }
      }
    }

    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }

  return items;
}

/**
 * All fulfilled line items across BOTH stores for a Mountain-Time date range
 * [fromYmd, toYmd] (inclusive; YYYY-MM-DD). Pass the same value twice for a
 * single day. Cached per (store, range) so re-opening the same window is instant.
 * Aggregation into the report shape is `aggregateFulfilled`'s job.
 */
export async function getFulfilledInRange(
  fromYmd: string,
  toYmd: string
): Promise<FulfilledLineItem[]> {
  const archery = cached(`fulfilled:archery:${fromYmd}:${toYmd}`, () =>
    fetchFulfilledForStore(getArcheryCreds(), "archery", fromYmd, toYmd)
  );

  const beastCreds = getBeastCreds();
  const beast = beastCreds
    ? cached(`fulfilled:beast:${fromYmd}:${toYmd}`, () =>
        fetchFulfilledForStore(beastCreds, "beast", fromYmd, toYmd)
      )
    : Promise.resolve([] as FulfilledLineItem[]);

  const [archeryItems, beastItems] = await Promise.all([archery, beast]);
  return [...archeryItems, ...beastItems];
}

// ============================================================
// Aggregate fulfilled line items into the report shape the tab renders.
// ============================================================

export interface FulfilledChannelTotals {
  orders: number; // distinct orders shipped by this channel
  units: number;
}

export interface FulfilledSkuRow {
  sku: string;
  title: string;
  total: number;
  shiphero: number;
  utah: number;
}

export interface FulfilledServiceRow {
  label: string; // the fulfillment service / app, as Shopify reports it
  location: string | null; // where it shipped from (e.g. "Utah")
  channel: FulfillmentChannel;
  units: number;
  orders: number;
}

export interface FulfilledReport {
  from: string;
  to: string;
  totalOrders: number;
  totalUnits: number;
  shiphero: FulfilledChannelTotals;
  utah: FulfilledChannelTotals;
  bySku: FulfilledSkuRow[];
  byService: FulfilledServiceRow[];
  storeUnits: { archery: number; beast: number };
}

export function aggregateFulfilled(
  items: FulfilledLineItem[],
  from: string,
  to: string
): FulfilledReport {
  const skuRows = new Map<string, FulfilledSkuRow>();
  const serviceRows = new Map<string, FulfilledServiceRow>();
  const serviceOrderSets = new Map<string, Set<string>>();

  const allOrders = new Set<string>();
  const shipheroOrders = new Set<string>();
  const utahOrders = new Set<string>();
  let totalUnits = 0;
  const channelUnits = { shiphero: 0, utah: 0 };
  const storeUnits = { archery: 0, beast: 0 };

  for (const it of items) {
    // Order gids can collide between the two stores; namespace by store.
    const orderKey = `${it.store}:${it.orderId}`;
    allOrders.add(orderKey);
    (it.channel === "shiphero" ? shipheroOrders : utahOrders).add(orderKey);
    totalUnits += it.quantity;
    channelUnits[it.channel] += it.quantity;
    storeUnits[it.store] += it.quantity;

    let row = skuRows.get(it.sku);
    if (!row) {
      row = { sku: it.sku, title: it.title, total: 0, shiphero: 0, utah: 0 };
      skuRows.set(it.sku, row);
    }
    row.total += it.quantity;
    row[it.channel] += it.quantity;

    // Key the transparency rows by service + location so we can see exactly what
    // Shopify reported for each (this is what we verify the ShipHero/Utah split on).
    const svcKey = `${it.serviceLabel} ${it.locationName ?? ""}`;
    let svc = serviceRows.get(svcKey);
    if (!svc) {
      svc = {
        label: it.serviceLabel,
        location: it.locationName,
        channel: it.channel,
        units: 0,
        orders: 0,
      };
      serviceRows.set(svcKey, svc);
      serviceOrderSets.set(svcKey, new Set());
    }
    svc.units += it.quantity;
    serviceOrderSets.get(svcKey)!.add(orderKey);
  }

  for (const [label, svc] of serviceRows) {
    svc.orders = serviceOrderSets.get(label)?.size ?? 0;
  }

  return {
    from,
    to,
    totalOrders: allOrders.size,
    totalUnits,
    shiphero: { orders: shipheroOrders.size, units: channelUnits.shiphero },
    utah: { orders: utahOrders.size, units: channelUnits.utah },
    bySku: [...skuRows.values()].sort((a, b) => b.total - a.total || a.sku.localeCompare(b.sku)),
    byService: [...serviceRows.values()].sort((a, b) => b.units - a.units),
    storeUnits,
  };
}
