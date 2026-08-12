-- Learned Shopify-SKU -> system-SKU aliases for fulfillment matching.
CREATE TABLE IF NOT EXISTS "sku_aliases" (
  "id" TEXT PRIMARY KEY,
  "alias" TEXT NOT NULL,
  "skuId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "sku_aliases_alias_key" ON "sku_aliases"("alias");
