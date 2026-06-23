-- Demand-projection forecaster: single scenario, per-SKU overrides, cached Shopify sales.
CREATE TABLE IF NOT EXISTS "forecast_scenarios" (
  "id" TEXT NOT NULL,
  "globalMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
  "comparisonStart" TIMESTAMP(3) NOT NULL,
  "comparisonEnd" TIMESTAMP(3) NOT NULL,
  "horizonStart" TIMESTAMP(3) NOT NULL,
  "horizonEnd" TIMESTAMP(3) NOT NULL,
  "salesRefreshedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "forecast_scenarios_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "forecast_overrides" (
  "id" TEXT NOT NULL,
  "skuId" TEXT NOT NULL,
  "overrideQty" INTEGER NOT NULL,
  "note" TEXT,
  "updatedBy" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "forecast_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "forecast_overrides_skuId_key" ON "forecast_overrides"("skuId");

CREATE TABLE IF NOT EXISTS "projection_sales" (
  "id" TEXT NOT NULL,
  "skuId" TEXT NOT NULL,
  "ytdQty" INTEGER NOT NULL DEFAULT 0,
  "priorQty" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "projection_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "projection_sales_skuId_key" ON "projection_sales"("skuId");
