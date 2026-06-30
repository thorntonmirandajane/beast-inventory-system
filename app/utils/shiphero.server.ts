// Read-only ShipHero GraphQL client for the Bowmar Archery LLC account.
//
// Beast Inventory uses this to surface the *physical on-hand* count at the
// Apex warehouse (the WMS source of truth) for the forecasting page's
// "Current in Gallatin" column. Previously this number came from Shopify's
// `available` quantity, which deducts committed/reserved units and so
// understates what is physically on the shelf. ShipHero's `on_hand` is the
// real count.
//
// Auth is username/password against ShipHero's auth endpoint, which returns a
// 28-day bearer access token (https://developer.shiphero.com/getting-started/).
// We cache the token in memory and re-auth on expiry or cold start.

const AUTH_URL = "https://public-api.shiphero.com/auth/token";
const REFRESH_URL = "https://public-api.shiphero.com/auth/refresh";
const GRAPHQL_URL = "https://public-api.shiphero.com/graphql";

// ============================================================
// Auth
// ============================================================

interface TokenState {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenState: TokenState | null = null;
let inFlightAuth: Promise<TokenState> | null = null;

// Refresh a little before the real 28-day expiry so an in-flight request never
// races the boundary.
const TOKEN_SAFETY_MS = 60 * 60 * 1000; // 1 hour

async function authenticate(): Promise<TokenState> {
  const refreshToken = process.env.SHIPHERO_REFRESH_TOKEN;

  let res: Response;
  if (refreshToken) {
    res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } else {
    const username = process.env.SHIPHERO_USERNAME;
    const password = process.env.SHIPHERO_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "Missing ShipHero credentials: set SHIPHERO_USERNAME and SHIPHERO_PASSWORD (or SHIPHERO_REFRESH_TOKEN)"
      );
    }
    res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ShipHero auth ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("ShipHero auth returned no access_token");
  }

  // expires_in is seconds (typically 2,419,200 = 28 days). Be defensive if absent.
  const ttlMs = (json.expires_in ?? 28 * 24 * 60 * 60) * 1000;
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + ttlMs - TOKEN_SAFETY_MS,
  };
}

async function getAccessToken(): Promise<string> {
  if (tokenState && Date.now() < tokenState.expiresAt) {
    return tokenState.accessToken;
  }
  // Collapse concurrent auths into one request.
  if (!inFlightAuth) {
    inFlightAuth = authenticate().finally(() => {
      inFlightAuth = null;
    });
  }
  tokenState = await inFlightAuth;
  return tokenState.accessToken;
}

// ============================================================
// GraphQL transport
// ============================================================

async function shipheroGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  // Hard guard: this client is read-only.
  if (/\bmutation\b/i.test(query)) {
    throw new Error("ShipHero client is read-only; mutations are not allowed");
  }

  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    // Expired/invalid token — force a re-auth and retry once.
    if (res.status === 401) {
      tokenState = null;
      lastErr = "401 unauthorized";
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ShipHero ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string; code?: number; time_remaining?: string }[];
    };

    if (json.errors && json.errors.length > 0) {
      const throttle = json.errors.find(
        (e) => /throttle/i.test(e.message) || e.code === 30
      );
      if (throttle) {
        // ShipHero reports throttling in errors; back off and retry.
        const secs = parseFloat(throttle.time_remaining ?? "") || 2 * (attempt + 1);
        await new Promise((r) => setTimeout(r, secs * 1000));
        lastErr = throttle.message;
        continue;
      }
      throw new Error(
        `ShipHero GraphQL: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }

    if (!json.data) throw new Error("ShipHero GraphQL returned no data");
    return json.data;
  }
  throw new Error(`ShipHero GraphQL failed after retries: ${lastErr}`);
}

// ============================================================
// Warehouse resolution
// ============================================================

let cachedWarehouseId: string | null = null;
let warehouseCachedAt = 0;
const WAREHOUSE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface WarehouseNode {
  id: string;
  legacy_id?: number;
  identifier?: string | null;
  address?: { name?: string | null } | null;
}

/**
 * Resolve the ShipHero warehouse id for the Apex warehouse. Prefers an
 * explicit SHIPHERO_WAREHOUSE_ID override; otherwise matches a warehouse whose
 * identifier or address name contains SHIPHERO_WAREHOUSE (default "Apex").
 */
export async function getApexWarehouseId(): Promise<string> {
  const override = process.env.SHIPHERO_WAREHOUSE_ID;
  if (override) return override;

  const now = Date.now();
  if (cachedWarehouseId && now - warehouseCachedAt < WAREHOUSE_TTL_MS) {
    return cachedWarehouseId;
  }

  const wanted = (process.env.SHIPHERO_WAREHOUSE || "Apex").toLowerCase();

  const data = await shipheroGraphQL<{
    account: { data: { warehouses: WarehouseNode[] } };
  }>(`
    query {
      account {
        data {
          warehouses {
            id
            legacy_id
            identifier
            address { name }
          }
        }
      }
    }
  `);

  const warehouses = data.account?.data?.warehouses ?? [];
  const match = warehouses.find((w) => {
    const id = (w.identifier || "").toLowerCase();
    const name = (w.address?.name || "").toLowerCase();
    return id.includes(wanted) || name.includes(wanted);
  });

  if (!match) {
    const names = warehouses
      .map((w) => w.identifier || w.address?.name || w.id)
      .join(", ");
    throw new Error(
      `No ShipHero warehouse matching "${process.env.SHIPHERO_WAREHOUSE || "Apex"}" — set SHIPHERO_WAREHOUSE_ID explicitly. Found: ${names}`
    );
  }

  cachedWarehouseId = match.id;
  warehouseCachedAt = now;
  return match.id;
}

// ============================================================
// On-hand inventory
// ============================================================

// 5-minute TTL cache mirrors the Shopify client: keeps the forecasting page
// snappy without making stale numbers a concern for an internal tool.
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

interface WarehouseProductEdge {
  node: {
    on_hand: number | null;
    product: { sku: string | null } | null;
  };
  cursor: string;
}

/**
 * Page through warehouse_products for a warehouse and return a SKU -> on_hand
 * map. Keeps the per-node field set minimal (on_hand + sku) so ShipHero's
 * query-complexity budget allows a large page size.
 */
async function fetchOnHandForWarehouse(
  warehouseId: string
): Promise<Map<string, number>> {
  const skuToOnHand = new Map<string, number>();
  const customerAccountId = process.env.SHIPHERO_CUSTOMER_ACCOUNT_ID;
  let cursor: string | null = null;

  // ShipHero rejects a null customer_account_id, so only declare + pass the
  // argument when it's actually set (3PL parent-account logins).
  const customerArgDecl = customerAccountId ? ", $customerAccountId: String" : "";
  const customerArgUse = customerAccountId ? "customer_account_id: $customerAccountId" : "";

  while (true) {
    const data: any = await shipheroGraphQL(
      `
      query($warehouseId: String!${customerArgDecl}, $cursor: String) {
        warehouse_products(
          warehouse_id: $warehouseId
          ${customerArgUse}
        ) {
          data(first: 200, after: $cursor) {
            edges {
              node {
                on_hand
                product { sku }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
      customerAccountId
        ? { warehouseId, customerAccountId, cursor }
        : { warehouseId, cursor }
    );

    const conn = data.warehouse_products?.data;
    if (!conn) break;

    for (const edge of conn.edges as WarehouseProductEdge[]) {
      const sku = edge.node.product?.sku;
      if (!sku) continue;
      const onHand = edge.node.on_hand ?? 0;
      // Sum defensively in case a SKU appears across multiple bins/rows.
      skuToOnHand.set(sku, (skuToOnHand.get(sku) ?? 0) + onHand);
    }

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return skuToOnHand;
}

/**
 * Live on-hand inventory at the Apex warehouse, keyed by SKU. Same shape as the
 * old Shopify `getGallatinInventory()` so the forecasting page can drop it in.
 */
export async function getOnHandInventory(): Promise<Map<string, number>> {
  return cached("apex-on-hand", async () => {
    const warehouseId = await getApexWarehouseId();
    return fetchOnHandForWarehouse(warehouseId);
  });
}
