-- Worker schedule requests.
CREATE TABLE IF NOT EXISTS "schedule_requests" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "days" TEXT NOT NULL,
  "note" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT
);
CREATE INDEX IF NOT EXISTS "schedule_requests_userId_idx" ON "schedule_requests"("userId");
CREATE INDEX IF NOT EXISTS "schedule_requests_status_idx" ON "schedule_requests"("status");
