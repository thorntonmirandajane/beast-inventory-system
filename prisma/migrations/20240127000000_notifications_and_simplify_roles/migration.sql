-- Create notifications table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationType') THEN
        CREATE TYPE "NotificationType" AS ENUM ('LATE_CLOCK_IN', 'MISSED_CLOCK_IN', 'MISSED_CLOCK_OUT');
    END IF;
END $$;

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

-- Create index if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'notifications_isRead_createdAt_idx'
    ) THEN
        CREATE INDEX "notifications_isRead_createdAt_idx" ON "notifications"("isRead", "createdAt");
    END IF;
END $$;

-- Update existing MANAGER users to ADMIN (idempotent)
UPDATE "users" SET "role" = 'ADMIN' WHERE "role" = 'MANAGER';

-- Safely remove MANAGER from UserRole enum if it exists
DO $$
BEGIN
    -- Check if MANAGER exists in the enum
    IF EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'MANAGER'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'UserRole')
    ) THEN
        -- Create new enum without MANAGER
        CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'WORKER');

        -- Update the column to use the new type
        ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new"
            USING "role"::text::"UserRole_new";

        -- Drop old type and rename new one
        DROP TYPE "UserRole";
        ALTER TYPE "UserRole_new" RENAME TO "UserRole";
    END IF;
END $$;
