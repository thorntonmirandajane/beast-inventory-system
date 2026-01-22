-- Step 1: Create notification type enum if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationType') THEN
        CREATE TYPE "NotificationType" AS ENUM ('LATE_CLOCK_IN', 'MISSED_CLOCK_IN', 'MISSED_CLOCK_OUT');
    END IF;
END $$;

-- Step 2: Create notifications table if it doesn't exist
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Step 3: Create index if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'notifications_isRead_createdAt_idx'
    ) THEN
        CREATE INDEX "notifications_isRead_createdAt_idx" ON "notifications"("isRead", "createdAt");
    END IF;
END $$;

-- Step 4: Update MANAGER users to ADMIN (safe to run multiple times)
UPDATE "users" SET "role" = 'ADMIN' WHERE "role" = 'MANAGER';

-- Step 5: Handle UserRole enum change safely
DO $$
DECLARE
    has_manager BOOLEAN;
BEGIN
    -- Check if MANAGER exists in the enum
    SELECT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'MANAGER'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'UserRole')
    ) INTO has_manager;

    -- Only modify enum if MANAGER exists
    IF has_manager THEN
        -- Step 5a: Add a temporary column with TEXT type
        ALTER TABLE "users" ADD COLUMN "role_temp" TEXT;

        -- Step 5b: Copy current role values as text
        UPDATE "users" SET "role_temp" = "role"::TEXT;

        -- Step 5c: Drop the old column
        ALTER TABLE "users" DROP COLUMN "role";

        -- Step 5d: Create new enum type without MANAGER
        DROP TYPE "UserRole";
        CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'WORKER');

        -- Step 5e: Add the role column back with new enum type
        ALTER TABLE "users" ADD COLUMN "role" "UserRole";

        -- Step 5f: Copy values back (MANAGER already changed to ADMIN)
        UPDATE "users" SET "role" = "role_temp"::"UserRole";

        -- Step 5g: Make it NOT NULL with default
        ALTER TABLE "users" ALTER COLUMN "role" SET NOT NULL;
        ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'WORKER';

        -- Step 5h: Drop temporary column
        ALTER TABLE "users" DROP COLUMN "role_temp";
    END IF;
END $$;
