-- AlterEnum: Remove IN_PROGRESS from TaskStatus enum
-- First, update any existing IN_PROGRESS tasks to PENDING
UPDATE "worker_tasks" SET status = 'PENDING' WHERE status = 'IN_PROGRESS';

-- Remove IN_PROGRESS from the enum
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');
ALTER TABLE "worker_tasks" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "worker_tasks" ALTER COLUMN "status" TYPE "TaskStatus" USING "status"::text::"TaskStatus";
ALTER TABLE "worker_tasks" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "TaskStatus_old";
