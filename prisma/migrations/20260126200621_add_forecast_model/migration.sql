-- CreateTable
CREATE TABLE "forecasts" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forecasts_skuId_idx" ON "forecasts"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "forecasts_skuId_key" ON "forecasts"("skuId");
