-- Time pulled off for ad-hoc/other projects, excluded from the efficiency
-- denominator (trackable hours = actual - misc).
ALTER TABLE "worker_time_entries" ADD COLUMN "miscMinutes" INTEGER NOT NULL DEFAULT 0;
