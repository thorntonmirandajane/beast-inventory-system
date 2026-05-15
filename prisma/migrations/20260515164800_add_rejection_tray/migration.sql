-- CreateEnum
CREATE TYPE "RejectionTrayStatus" AS ENUM ('PENDING', 'RESOLVED');

-- CreateTable
CREATE TABLE "rejection_trays" (
    "id" TEXT NOT NULL,
    "timeEntryLineId" TEXT,
    "outputSkuId" TEXT NOT NULL,
    "rejectedQty" INTEGER NOT NULL,
    "processName" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "status" "RejectionTrayStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "rejection_trays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rejection_tray_items" (
    "id" TEXT NOT NULL,
    "rejectionTrayId" TEXT NOT NULL,
    "componentSkuId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "recoveredQty" INTEGER NOT NULL DEFAULT 0,
    "disposedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rejection_tray_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rejection_trays_status_idx" ON "rejection_trays"("status");

-- CreateIndex
CREATE INDEX "rejection_trays_outputSkuId_idx" ON "rejection_trays"("outputSkuId");

-- CreateIndex
CREATE INDEX "rejection_tray_items_rejectionTrayId_idx" ON "rejection_tray_items"("rejectionTrayId");

-- AddForeignKey
ALTER TABLE "rejection_trays" ADD CONSTRAINT "rejection_trays_timeEntryLineId_fkey" FOREIGN KEY ("timeEntryLineId") REFERENCES "time_entry_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_trays" ADD CONSTRAINT "rejection_trays_outputSkuId_fkey" FOREIGN KEY ("outputSkuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_trays" ADD CONSTRAINT "rejection_trays_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_tray_items" ADD CONSTRAINT "rejection_tray_items_rejectionTrayId_fkey" FOREIGN KEY ("rejectionTrayId") REFERENCES "rejection_trays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_tray_items" ADD CONSTRAINT "rejection_tray_items_componentSkuId_fkey" FOREIGN KEY ("componentSkuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
