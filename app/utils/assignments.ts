// Pure (no-DB) core of the daily-assignment generator: given an ordered work
// queue (each item already flagged buildable/blocked, with a stage order) and
// the scheduled workers' available hours, distribute the buildable work.
//
// The DB layer builds the queue (projected inventory + forecast need exploded to
// stages) and loads worker capacity; this just does the matching, so it's unit
// testable without a database.

export interface WorkItem {
  process: string; // process display name (for the UI)
  processName: string; // ProcessConfig.processName (for the WorkerTask record)
  skuId: string;
  sku: string;
  name: string;
  units: number; // units still needed to build
  hoursPerUnit: number; // secondsPerUnit / 3600
  buildable: boolean; // immediate inputs in (projected) stock?
  stageOrder: number; // lower = more upstream (tipping < blading < stud-test < pack)
}

export interface WorkerCapacity {
  userId: string;
  name: string;
  hours: number; // scheduled hours available
}

export interface Assignment {
  userId: string;
  name: string;
  process: string;
  processName: string;
  skuId: string;
  sku: string;
  skuName: string;
  units: number;
  hours: number;
}

export interface AssignmentResult {
  assignments: Assignment[];
  blocked: WorkItem[]; // not buildable yet (needs an upstream stage)
  unassigned: WorkItem[]; // buildable, but no worker capacity left
}

export function assignWork(queue: WorkItem[], workers: WorkerCapacity[]): AssignmentResult {
  // Blocked work is surfaced, never assigned.
  const blocked = queue.filter((w) => !w.buildable && w.units > 0);

  // Buildable work, ordered: upstream stages first, then biggest total hours.
  const buildable = queue
    .filter((w) => w.buildable && w.units > 0 && w.hoursPerUnit > 0)
    .map((w) => ({ ...w }))
    .sort(
      (a, b) =>
        a.stageOrder - b.stageOrder || b.units * b.hoursPerUnit - a.units * a.hoursPerUnit
    );

  const remaining = workers.map((w) => ({ ...w, left: w.hours }));
  const assignments: Assignment[] = [];

  // Each worker fills their hours from the top of the queue. A large item that
  // exceeds one worker's hours rolls over to the next worker, so big jobs split.
  for (const worker of remaining) {
    for (const item of buildable) {
      if (worker.left <= 0) break;
      if (item.units <= 0) continue;
      const maxUnitsByTime = Math.floor(worker.left / item.hoursPerUnit);
      if (maxUnitsByTime <= 0) continue;
      const units = Math.min(item.units, maxUnitsByTime);
      const hours = units * item.hoursPerUnit;
      assignments.push({
        userId: worker.userId,
        name: worker.name,
        process: item.process,
        processName: item.processName,
        skuId: item.skuId,
        sku: item.sku,
        skuName: item.name,
        units,
        hours,
      });
      item.units -= units;
      worker.left -= hours;
    }
  }

  const unassigned = buildable.filter((w) => w.units > 0);
  return { assignments, blocked, unassigned };
}
