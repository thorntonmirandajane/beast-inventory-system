-- Backorder allocation & production planning.

-- Wildcard-pattern (rewrite-rule) support for SkuAlias (e.g. "TR-*" -> "TRUMP-*").
-- Existing rows default to exact-match (isPattern=false), so the fulfillment
-- sync and other exact-only consumers are unaffected. Pattern rows use
-- `replacement` and have no skuId, so skuId becomes nullable.
ALTER TABLE "sku_aliases" ADD COLUMN IF NOT EXISTS "isPattern" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sku_aliases" ADD COLUMN IF NOT EXISTS "replacement" TEXT;
ALTER TABLE "sku_aliases" ALTER COLUMN "skuId" DROP NOT NULL;

-- SKUs handled manually — output as their own list, never allocated.
CREATE TABLE IF NOT EXISTS "backorder_exclusions" (
  "id" TEXT PRIMARY KEY,
  "sku" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "backorder_exclusions_sku_key" ON "backorder_exclusions"("sku");

-- Singleton checkpoint: last-run timestamp + cached output snapshot.
CREATE TABLE IF NOT EXISTS "backorder_runs" (
  "id" TEXT PRIMARY KEY,
  "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "backorder" BOOLEAN NOT NULL DEFAULT false,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Singleton config for backorder / ETA settings.
CREATE TABLE IF NOT EXISTS "backorder_config" (
  "id" TEXT PRIMARY KEY,
  "etaBusinessDays" INTEGER NOT NULL DEFAULT 4,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
