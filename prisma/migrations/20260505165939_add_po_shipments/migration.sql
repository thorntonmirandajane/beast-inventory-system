-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "po_items" ADD COLUMN     "unitCost" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "po_shipments" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "shipmentNumber" INTEGER NOT NULL,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "tariffAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "packingSlipImageUrl" TEXT,
    "boxImageUrls" TEXT[],
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "varianceNotes" TEXT,
    "hasVariance" BOOLEAN NOT NULL DEFAULT false,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "po_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_shipment_items" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "poItemId" TEXT NOT NULL,
    "quantityReceived" INTEGER NOT NULL,
    "actualUnitCost" DOUBLE PRECISION,
    "varianceNotes" TEXT,

    CONSTRAINT "po_shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "po_shipments_purchaseOrderId_idx" ON "po_shipments"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "po_shipments_status_idx" ON "po_shipments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "po_shipments_purchaseOrderId_shipmentNumber_key" ON "po_shipments"("purchaseOrderId", "shipmentNumber");

-- CreateIndex
CREATE INDEX "po_shipment_items_shipmentId_idx" ON "po_shipment_items"("shipmentId");

-- CreateIndex
CREATE INDEX "po_shipment_items_poItemId_idx" ON "po_shipment_items"("poItemId");

-- AddForeignKey
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "po_shipment_items_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "po_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "po_shipment_items_poItemId_fkey" FOREIGN KEY ("poItemId") REFERENCES "po_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
