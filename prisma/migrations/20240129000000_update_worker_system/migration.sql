-- Add rejection photo field to worker time entries
ALTER TABLE "worker_time_entries" ADD COLUMN IF NOT EXISTS "rejectionPhoto" TEXT;

-- Add pay rate field to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payRate" DOUBLE PRECISION;

-- Note: PostgreSQL doesn't have CHECK constraints on existing columns by default
-- Inventory can now go negative by design (no changes needed)
