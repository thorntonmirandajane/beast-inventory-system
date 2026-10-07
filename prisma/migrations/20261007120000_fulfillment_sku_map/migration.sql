-- Shopify SKU handling for the fulfillment views only (Unfulfilled, Game plans,
-- Compare plans). Kept apart from Backorder's SkuAlias/BackorderExclusion on
-- purpose, so edits here can't move the Backorder or Build Plan numbers.
CREATE TABLE IF NOT EXISTS "fulfillment_sku_map" (
  "id" TEXT PRIMARY KEY,
  "shopifySku" TEXT NOT NULL,
  "inventorySku" TEXT,
  "ignore" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_sku_map_shopifySku_key"
  ON "fulfillment_sku_map"("shopifySku");
CREATE INDEX IF NOT EXISTS "fulfillment_sku_map_ignore_idx"
  ON "fulfillment_sku_map"("ignore");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fulfillment_sku_map_createdById_fkey') THEN
    ALTER TABLE "fulfillment_sku_map" ADD CONSTRAINT "fulfillment_sku_map_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
