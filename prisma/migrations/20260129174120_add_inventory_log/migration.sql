-- CreateEnum
CREATE TYPE "InventoryLogAction" AS ENUM ('RECEIVED', 'CONSUMED', 'PRODUCED', 'TRANSFERRED_OUT', 'TRANSFERRED_IN', 'ADJUSTED', 'DISPOSED');

-- CreateTable
CREATE TABLE "inventory_logs" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "action" "InventoryLogAction" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromState" "InventoryState",
    "toState" "InventoryState",
    "relatedResource" TEXT,
    "relatedResourceType" TEXT,
    "processName" TEXT,
    "notes" TEXT,
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_logs_skuId_createdAt_idx" ON "inventory_logs"("skuId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_logs_action_idx" ON "inventory_logs"("action");

-- CreateIndex
CREATE INDEX "inventory_logs_relatedResourceType_relatedResource_idx" ON "inventory_logs"("relatedResourceType", "relatedResource");

-- AddForeignKey
ALTER TABLE "inventory_logs" ADD CONSTRAINT "inventory_logs_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
