-- Create enums for worker productivity
CREATE TYPE "TaskAssignmentType" AS ENUM ('DAILY', 'BACKLOG');
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TimeEntryStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- Create worker_tasks table
CREATE TABLE "worker_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "skuId" TEXT,
    "targetQuantity" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "assignmentType" "TaskAssignmentType" NOT NULL DEFAULT 'DAILY',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "assignedById" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "worker_tasks_pkey" PRIMARY KEY ("id")
);

-- Create worker_time_entries table
CREATE TABLE "worker_time_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockInEventId" TEXT NOT NULL,
    "clockOutEventId" TEXT,
    "clockInTime" TIMESTAMP(3) NOT NULL,
    "clockOutTime" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "actualMinutes" INTEGER,
    "expectedMinutes" DOUBLE PRECISION,
    "efficiency" DOUBLE PRECISION,
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_time_entries_pkey" PRIMARY KEY ("id")
);

-- Create time_entry_lines table
CREATE TABLE "time_entry_lines" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "skuId" TEXT,
    "quantityCompleted" INTEGER NOT NULL,
    "secondsPerUnit" INTEGER NOT NULL,
    "expectedSeconds" INTEGER NOT NULL,
    "workerTaskId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entry_lines_pkey" PRIMARY KEY ("id")
);

-- Create unique indexes for time entry clock events
CREATE UNIQUE INDEX "worker_time_entries_clockInEventId_key" ON "worker_time_entries"("clockInEventId");
CREATE UNIQUE INDEX "worker_time_entries_clockOutEventId_key" ON "worker_time_entries"("clockOutEventId");

-- Create indexes for worker_tasks
CREATE INDEX "worker_tasks_userId_status_idx" ON "worker_tasks"("userId", "status");
CREATE INDEX "worker_tasks_dueDate_idx" ON "worker_tasks"("dueDate");

-- Create indexes for worker_time_entries
CREATE INDEX "worker_time_entries_userId_status_idx" ON "worker_time_entries"("userId", "status");
CREATE INDEX "worker_time_entries_clockInTime_idx" ON "worker_time_entries"("clockInTime");

-- Create indexes for time_entry_lines
CREATE INDEX "time_entry_lines_timeEntryId_idx" ON "time_entry_lines"("timeEntryId");

-- Add foreign key constraints
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worker_time_entries" ADD CONSTRAINT "worker_time_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "worker_time_entries" ADD CONSTRAINT "worker_time_entries_clockInEventId_fkey" FOREIGN KEY ("clockInEventId") REFERENCES "clock_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "worker_time_entries" ADD CONSTRAINT "worker_time_entries_clockOutEventId_fkey" FOREIGN KEY ("clockOutEventId") REFERENCES "clock_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "worker_time_entries" ADD CONSTRAINT "worker_time_entries_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "time_entry_lines" ADD CONSTRAINT "time_entry_lines_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "worker_time_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "time_entry_lines" ADD CONSTRAINT "time_entry_lines_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "time_entry_lines" ADD CONSTRAINT "time_entry_lines_workerTaskId_fkey" FOREIGN KEY ("workerTaskId") REFERENCES "worker_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
