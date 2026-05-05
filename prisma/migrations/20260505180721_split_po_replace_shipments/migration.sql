/*
  Warnings:

  - You are about to drop the `po_shipment_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `po_shipments` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "po_shipment_items" DROP CONSTRAINT "po_shipment_items_poItemId_fkey";

-- DropForeignKey
ALTER TABLE "po_shipment_items" DROP CONSTRAINT "po_shipment_items_shipmentId_fkey";

-- DropForeignKey
ALTER TABLE "po_shipments" DROP CONSTRAINT "po_shipments_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "po_shipments" DROP CONSTRAINT "po_shipments_createdById_fkey";

-- DropForeignKey
ALTER TABLE "po_shipments" DROP CONSTRAINT "po_shipments_purchaseOrderId_fkey";

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "boxImageUrls" TEXT[],
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "hasVariance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packingSlipImageUrl" TEXT,
ADD COLUMN     "parentPOId" TEXT,
ADD COLUMN     "shippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "tariffAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "trackingNumber" TEXT,
ADD COLUMN     "varianceNotes" TEXT;

-- DropTable
DROP TABLE "po_shipment_items";

-- DropTable
DROP TABLE "po_shipments";

-- DropEnum
DROP TYPE "ShipmentStatus";

-- CreateIndex
CREATE INDEX "purchase_orders_parentPOId_idx" ON "purchase_orders"("parentPOId");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_parentPOId_fkey" FOREIGN KEY ("parentPOId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
