-- Allow non-WORKER users (e.g. admins like Carson) to log time / be selected for time entry
ALTER TABLE "users" ADD COLUMN "canLogTime" BOOLEAN NOT NULL DEFAULT false;
