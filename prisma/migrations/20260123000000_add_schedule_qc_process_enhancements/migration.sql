-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('RECURRING', 'SPECIFIC_DATE');

-- DropIndex
DROP INDEX "worker_schedules_userId_dayOfWeek_key";

-- AlterTable
ALTER TABLE "process_configs" ADD COLUMN     "consumesState" "InventoryState",
ADD COLUMN     "description" TEXT,
ADD COLUMN     "producesState" "InventoryState";

-- AlterTable
ALTER TABLE "time_entry_lines" ADD COLUMN     "adminAdjustedQuantity" INTEGER,
ADD COLUMN     "adminNotes" TEXT,
ADD COLUMN     "isMisc" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isRejected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "miscDescription" TEXT,
ADD COLUMN     "rejectionQuantity" INTEGER,
ADD COLUMN     "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "worker_schedules" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "scheduleDate" TIMESTAMP(3),
ADD COLUMN     "scheduleType" "ScheduleType" NOT NULL DEFAULT 'RECURRING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "dayOfWeek" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "worker_schedules_scheduleDate_idx" ON "worker_schedules"("scheduleDate");

-- CreateIndex
CREATE UNIQUE INDEX "worker_schedules_userId_dayOfWeek_scheduleDate_key" ON "worker_schedules"("userId", "dayOfWeek", "scheduleDate");

