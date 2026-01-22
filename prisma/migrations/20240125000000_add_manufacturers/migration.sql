-- Create manufacturers table
CREATE TABLE "manufacturers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- Create sku_manufacturers junction table
CREATE TABLE "sku_manufacturers" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "cost" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sku_manufacturers_pkey" PRIMARY KEY ("id")
);

-- Add manufacturerId to po_items
ALTER TABLE "po_items" ADD COLUMN "manufacturerId" TEXT;

-- Create unique index on manufacturer name
CREATE UNIQUE INDEX "manufacturers_name_key" ON "manufacturers"("name");

-- Create unique index on sku-manufacturer combination
CREATE UNIQUE INDEX "sku_manufacturers_skuId_manufacturerId_key" ON "sku_manufacturers"("skuId", "manufacturerId");

-- Create indexes
CREATE INDEX "sku_manufacturers_skuId_idx" ON "sku_manufacturers"("skuId");
CREATE INDEX "sku_manufacturers_manufacturerId_idx" ON "sku_manufacturers"("manufacturerId");

-- Add foreign key constraints
ALTER TABLE "sku_manufacturers" ADD CONSTRAINT "sku_manufacturers_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sku_manufacturers" ADD CONSTRAINT "sku_manufacturers_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_items" ADD CONSTRAINT "po_items_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "manufacturers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
