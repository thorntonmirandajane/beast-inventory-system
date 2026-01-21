-- Add category and material to skus table
ALTER TABLE "skus" ADD COLUMN "category" TEXT;
ALTER TABLE "skus" ADD COLUMN "material" TEXT;

-- Create process_configs table for global process time settings
CREATE TABLE "process_configs" (
    "id" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "secondsPerUnit" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_configs_pkey" PRIMARY KEY ("id")
);

-- Create unique index on processName
CREATE UNIQUE INDEX "process_configs_processName_key" ON "process_configs"("processName");

-- Insert default process configurations
INSERT INTO "process_configs" ("id", "processName", "displayName", "secondsPerUnit", "isActive", "createdAt", "updatedAt")
VALUES
    (gen_random_uuid()::text, 'TIPPING', 'Tipping', 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'BLADING', 'Blading', 50, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'STUD_TESTING', 'Stud Testing', 50, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'COMPLETE_PACKS', 'Complete Packs', 60, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
