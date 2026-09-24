-- Explicit "Day off" markings, so a deliberately-off day is distinguishable
-- from a day nobody has filled in yet.
CREATE TABLE IF NOT EXISTS "schedule_days_off" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "schedule_days_off_userId_date_key"
  ON "schedule_days_off"("userId","date");
CREATE INDEX IF NOT EXISTS "schedule_days_off_userId_date_idx"
  ON "schedule_days_off"("userId","date");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_days_off_userId_fkey') THEN
    ALTER TABLE "schedule_days_off"
      ADD CONSTRAINT "schedule_days_off_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
