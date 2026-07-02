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
//
// We fetch on-hand only for the specific SKUs beast cares about (~116), not the
// whole warehouse. The Apex warehouse holds every Bowmar product (5,000+ SKUs),
// and paging through all of them costs ~3,700 of ShipHero's 4,004 credit budget
// per refresh — one refresh nearly drains the quota and throttling then zeros
// out the page. warehouse_products' `sku` filter is case-insensitive and cheap
// (~1-2 credits each), and GraphQL aliases let us batch many SKUs per request.

const norm = (s: string) => s.trim().toUpperCase();

// 5-minute TTL, cached per normalized SKU. Serving a slightly stale value beats
// dropping to 0 on a transient throttle, so on a fetch error we keep whatever's
// already cached rather than clearing it.
const DATA_TTL_MS = 5 * 60 * 1000;
const onHandCache = new Map<string, { qty: number; at: number }>();

// Aliases per request. 20 keeps us well under ShipHero's query-complexity limit
// while cutting ~116 SKUs down to ~6 round-trips.
const BATCH_SIZE = 20;

/**
 * Fetch on-hand for a batch of SKUs in a single aliased query. Returns a map
 * keyed by normalized SKU. Sums rows defensively in case a SKU filter matches
 * more than one warehouse_product row.
 */
async function fetchOnHandBatch(
  warehouseId: string,
  skus: string[]
): Promise<Map<string, number>> {
  const decls = skus.map((_, i) => `$sku${i}: String`).join(", ");
  const body = skus
    .map(
      (_, i) =>
        `a${i}: warehouse_products(warehouse_id: $warehouseId, sku: $sku${i}) { data(first: 5) { edges { node { on_hand } } } }`
    )
    .join("\n");
  const variables: Record<string, unknown> = { warehouseId };
  skus.forEach((s, i) => {
    variables[`sku${i}`] = s;
  });

  const data: any = await shipheroGraphQL(
    `query($warehouseId: String!, ${decls}) { ${body} }`,
    variables
  );

  const result = new Map<string, number>();
  skus.forEach((s, i) => {
    const edges = data[`a${i}`]?.data?.edges ?? [];
    const qty = edges.reduce(
      (sum: number, e: any) => sum + (e.node?.on_hand ?? 0),
      0
    );
    result.set(norm(s), qty);
  });
  return result;
}

/**
 * Live on-hand at the Apex warehouse for the given SKUs, keyed by the SKU
 * strings as passed in. Same map shape the forecasting page expects.
 *
 * Resilient by design: fresh cached SKUs are served without a network call;
 * only stale/missing SKUs are fetched, in batches. If a batch fails (e.g.
 * ShipHero throttling), we keep the previously-cached values for those SKUs
 * instead of zeroing them. We only surface an error if we end up with no data
 * at all, so the forecasting page can show its "unavailable" banner.
 */
export async function getOnHandForSkus(
  requestedSkus: string[]
): Promise<Map<string, number>> {
  // De-dup by normalized SKU, remembering one original casing per SKU to return.
  const origByNorm = new Map<string, string>();
  for (const s of requestedSkus) {
    if (!s) continue;
    const n = norm(s);
    if (!origByNorm.has(n)) origByNorm.set(n, s);
  }

  const now = Date.now();
  const toFetch: string[] = [];
  for (const [n, orig] of origByNorm) {
    const hit = onHandCache.get(n);
    if (!hit || now - hit.at >= DATA_TTL_MS) toFetch.push(orig);
  }

  if (toFetch.length > 0) {
    const warehouseId = await getApexWarehouseId();
    let lastErr: unknown = null;
    let anyBatchSucceeded = false;

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const group = toFetch.slice(i, i + BATCH_SIZE);
      try {
        const batch = await fetchOnHandBatch(warehouseId, group);
        for (const [n, qty] of batch) {
          onHandCache.set(n, { qty, at: now });
        }
        anyBatchSucceeded = true;
      } catch (err) {
        // Keep cached values for this group; don't clear them to 0.
        lastErr = err;
        console.error(
          "[shiphero] on-hand batch failed (serving cached where available):",
          err instanceof Error ? err.message : err
        );
      }
    }

    // Total failure with nothing cached to fall back on — let the caller show
    // its "ShipHero unavailable" banner rather than silently reporting 0s.
    if (!anyBatchSucceeded && onHandCache.size === 0 && lastErr) {
      throw lastErr;
    }
  }

  const result = new Map<string, number>();
  for (const [n, orig] of origByNorm) {
    const hit = onHandCache.get(n);
    if (hit) result.set(orig, hit.qty);
  }
  return result;
}
