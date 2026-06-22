// Pure (no-DB) test for the assignment core. Run: node test-assignments.ts
import { assignWork, type WorkItem, type WorkerCapacity } from "./app/utils/assignments.ts";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` (${extra})` : ""}`);
}

// Stage 1 (tipping): 1000 units @ 30s = 8.33h total -> spans >1 worker.
// Stage 2 (blading): blocked (no tipped ferrules in stock yet).
// Stage 3 (stud test): 100 units @ 60s = 1.67h, buildable.
const queue: WorkItem[] = [
  { process: "Tipping", processName: "TIPPING", skuId: "t1", sku: "TIPPED", name: "Tipped Ferrule", units: 1000, hoursPerUnit: 30 / 3600, buildable: true, stageOrder: 1 },
  { process: "Blading", processName: "BLADING", skuId: "b1", sku: "BLADED", name: "Bladed Ferrule", units: 500, hoursPerUnit: 45 / 3600, buildable: false, stageOrder: 2 },
  { process: "Stud Testing", processName: "STUD_TESTING", skuId: "s1", sku: "BEAST", name: "Broadhead", units: 100, hoursPerUnit: 60 / 3600, buildable: true, stageOrder: 3 },
];

const workers: WorkerCapacity[] = [
  { userId: "u1", name: "A", hours: 8 },
  { userId: "u2", name: "B", hours: 8 },
];

const { assignments, blocked, unassigned } = assignWork(queue, workers);
const byWorker = (id: string) => assignments.filter((a) => a.userId === id);
const tippingUnits = assignments.filter((a) => a.process === "Tipping").reduce((s, a) => s + a.units, 0);

console.log("Assignment core:");
check("blading is blocked (not assigned)", blocked.length === 1 && blocked[0].process === "Blading");
check("no blading in assignments", !assignments.some((a) => a.process === "Blading"));
check("upstream tipping assigned first", assignments[0].process === "Tipping");
check("tipping splits across both workers", byWorker("u1").some(a=>a.process==="Tipping") && byWorker("u2").some(a=>a.process==="Tipping"));
check("each worker's hours don't exceed 8", workers.every((w) => byWorker(w.userId).reduce((s, a) => s + a.hours, 0) <= 8 + 1e-9));
// 16h capacity; tipping needs 8.33h, stud test 1.67h -> all 1100 buildable units fit.
check("all buildable tipping units assigned (1000)", tippingUnits === 1000);
check("stud-test units assigned (100)", assignments.filter(a=>a.process==="Stud Testing").reduce((s,a)=>s+a.units,0) === 100);
check("nothing buildable left unassigned", unassigned.length === 0);

// Capacity-limited case: tiny capacity -> some buildable work unassigned.
const tiny = assignWork(queue, [{ userId: "u1", name: "A", hours: 1 }]);
check("with 1h capacity, some buildable work is unassigned", tiny.unassigned.length > 0);

console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
