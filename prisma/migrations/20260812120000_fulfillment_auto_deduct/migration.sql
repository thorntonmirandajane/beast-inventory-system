-- Utah fulfillment auto-deduction: idempotency ledger + sync checkpoint.
CREATE TABLE IF NOT EXISTS "fulfillment_deductions" (
  "id" TEXT PRIMARY KEY,
  "store" TEXT NOT NULL,
  "fulfillmentId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "skuId" TEXT,
  "quantity" INTEGER NOT NULL,
  "orderName" TEXT NOT NULL,
  "fulfilledAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "transferId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_deductions_store_fulfillmentId_sku_key"
  ON "fulfillment_deductions"("store","fulfillmentId","sku");
CREATE INDEX IF NOT EXISTS "fulfillment_deductions_createdAt_idx"
  ON "fulfillment_deductions"("createdAt");

CREATE TABLE IF NOT EXISTS "fulfillment_sync" (
  "id" TEXT PRIMARY KEY,
  "startAt" TIMESTAMP(3) NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
