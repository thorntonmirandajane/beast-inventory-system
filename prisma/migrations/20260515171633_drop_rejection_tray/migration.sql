/*
  Warnings:

  - You are about to drop the `rejection_tray_items` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `rejection_trays` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "rejection_tray_items" DROP CONSTRAINT "rejection_tray_items_componentSkuId_fkey";

-- DropForeignKey
ALTER TABLE "rejection_tray_items" DROP CONSTRAINT "rejection_tray_items_rejectionTrayId_fkey";

-- DropForeignKey
ALTER TABLE "rejection_trays" DROP CONSTRAINT "rejection_trays_createdById_fkey";

-- DropForeignKey
ALTER TABLE "rejection_trays" DROP CONSTRAINT "rejection_trays_outputSkuId_fkey";

-- DropForeignKey
ALTER TABLE "rejection_trays" DROP CONSTRAINT "rejection_trays_timeEntryLineId_fkey";

-- DropTable
DROP TABLE "rejection_tray_items";

-- DropTable
DROP TABLE "rejection_trays";

-- DropEnum
DROP TYPE "RejectionTrayStatus";
