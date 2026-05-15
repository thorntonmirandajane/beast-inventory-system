-- AlterTable
ALTER TABLE "rejection_tray_items" ADD COLUMN     "brokenApartQty" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "rejection_tray_items_componentSkuId_idx" ON "rejection_tray_items"("componentSkuId");
