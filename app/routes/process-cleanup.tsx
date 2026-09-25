import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, Link } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";

// ============================================================================
// Process cleanup.
//
// A SKU's process is stored as a plain string in `Sku.material`, not a foreign
// key, and two writers disagreed about what to put there: the Edit SKU form
// saved the internal name ("COMPLETE_PACKS"), the Process Times import saved
// the display name ("Complete Packs"). Same process, two strings — which is
// why the catalog's process filter listed everything twice.
//
// Separately, the Process Times import creates a ProcessConfig for any process
// it can't match, with a _2 suffix to get past the unique constraint. Process
// matching couldn't handle multi-word names until Sep 2026, so every import in
// that period minted duplicates like COMPLETE_PACKS_2 — real extra records,
// carrying an inherited or zero time-per-unit.
//
// This page merges those duplicates into the correctly-configured original and
// rewrites every SKU to the one canonical process name.
// ============================================================================

const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

type Cfg = {
  id: string;
  processName: string;
  displayName: string;
  secondsPerUnit: number;
  processOrder: number | null;
  isActive: boolean;
};

/**
 * Group configs that mean the same process, and pick the keeper: a real
 * time-per-unit first (that's the one configured on Process Times), then the
 * name without a _N suffix, then the oldest.
 */
function groupConfigs(configs: Cfg[]) {
  const byName = new Map<string, Cfg[]>();
  for (const c of configs) {
    const k = norm(c.displayName);
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  const groups: { key: string; keeper: Cfg; duplicates: Cfg[] }[] = [];
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) => {
      if ((b.secondsPerUnit > 0 ? 1 : 0) !== (a.secondsPerUnit > 0 ? 1 : 0)) {
        return (b.secondsPerUnit > 0 ? 1 : 0) - (a.secondsPerUnit > 0 ? 1 : 0);
      }
      const aSuffix = /_\d+$/.test(a.processName) ? 1 : 0;
      const bSuffix = /_\d+$/.test(b.processName) ? 1 : 0;
      if (aSuffix !== bSuffix) return aSuffix - bSuffix;
      return a.id.localeCompare(b.id);
    });
    groups.push({ key, keeper: ranked[0], duplicates: ranked.slice(1) });
  }
  return groups;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);

  const configs: Cfg[] = await prisma.processConfig.findMany({
    select: { id: true, processName: true, displayName: true, secondsPerUnit: true, processOrder: true, isActive: true },
    orderBy: { displayName: "asc" },
  });
  const groups = groupConfigs(configs);

  // Every distinct process string currently stored on a SKU, with a count.
  const skuValues = await prisma.sku.groupBy({
    by: ["material"],
    where: { material: { not: null } },
    _count: { _all: true },
  });

  const canonicalFor = new Map<string, Cfg>();
  for (const c of configs) {
    const dup = groups.find((g) => g.duplicates.some((d) => d.id === c.id));
    canonicalFor.set(c.processName, dup ? dup.keeper : c);
    if (!canonicalFor.has(c.displayName)) canonicalFor.set(c.displayName, dup ? dup.keeper : c);
  }

  const values = skuValues
    .map((v) => {
      const raw = v.material as string;
      const target =
        canonicalFor.get(raw) ??
        configs.find((c) => norm(c.displayName) === norm(raw)) ??
        configs.find((c) => norm(c.processName) === norm(raw));
      const keeper = target ? (groups.find((g) => g.duplicates.some((d) => d.id === target.id))?.keeper ?? target) : null;
      return {
        raw,
        count: v._count._all,
        target: keeper ? keeper.processName : null,
        targetLabel: keeper ? keeper.displayName : null,
        needsChange: !!keeper && keeper.processName !== raw,
        unmatched: !keeper,
      };
    })
    .sort((a, b) => a.raw.localeCompare(b.raw));

  return {
    user,
    configs,
    groups: groups.map((g) => ({
      key: g.key,
      keeper: g.keeper,
      duplicates: g.duplicates,
    })),
    values,
    toRelabel: values.filter((v) => v.needsChange).reduce((n, v) => n + v.count, 0),
    unmatched: values.filter((v) => v.unmatched),
    duplicateCount: groups.reduce((n, g) => n + g.duplicates.length, 0),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN"]);
  const form = await request.formData();
  if (form.get("intent") !== "cleanup") return { error: "Unknown action" };

  const configs: Cfg[] = await prisma.processConfig.findMany({
    select: { id: true, processName: true, displayName: true, secondsPerUnit: true, processOrder: true, isActive: true },
  });
  const groups = groupConfigs(configs);

  const canonicalFor = new Map<string, Cfg>();
  for (const c of configs) {
    const dupGroup = groups.find((g) => g.duplicates.some((d) => d.id === c.id));
    const keeper = dupGroup ? dupGroup.keeper : c;
    canonicalFor.set(c.processName, keeper);
    if (!canonicalFor.has(c.displayName)) canonicalFor.set(c.displayName, keeper);
  }

  let skusRelabelled = 0;
  let duplicatesDeleted = 0;

  await prisma.$transaction(async (tx) => {
    // 1) Point every SKU at the canonical process name.
    const skuValues = await tx.sku.groupBy({
      by: ["material"],
      where: { material: { not: null } },
      _count: { _all: true },
    });
    for (const v of skuValues) {
      const raw = v.material as string;
      const keeper =
        canonicalFor.get(raw) ??
        configs.find((c) => norm(c.displayName) === norm(raw)) ??
        configs.find((c) => norm(c.processName) === norm(raw));
      if (!keeper) continue; // nothing to point it at — left alone, reported on screen
      const target = groups.find((g) => g.duplicates.some((d) => d.id === keeper.id))?.keeper ?? keeper;
      if (target.processName === raw) continue;
      const res = await tx.sku.updateMany({ where: { material: raw }, data: { material: target.processName } });
      skusRelabelled += res.count;
    }

    // 2) Drop the duplicate process records, now that nothing points at them.
    for (const g of groups) {
      for (const d of g.duplicates) {
        const stillUsed = await tx.sku.count({ where: { material: d.processName } });
        const usedByWork = await tx.timeEntryLine.count({ where: { processName: d.processName } });
        // A duplicate that has real work logged against it is deactivated
        // rather than deleted, so that history keeps resolving.
        if (stillUsed > 0) continue;
        if (usedByWork > 0) {
          await tx.processConfig.update({ where: { id: d.id }, data: { isActive: false } });
        } else {
          await tx.processConfig.delete({ where: { id: d.id } });
        }
        duplicatesDeleted++;
      }
    }
  }, { timeout: 120000, maxWait: 15000 });

  await createAuditLog(user.id, "CLEANUP_PROCESS_DUPLICATES", "ProcessConfig", "bulk", {
    skusRelabelled,
    duplicatesRemoved: duplicatesDeleted,
  });

  return {
    success: true,
    message: `Pointed ${skusRelabelled} SKU(s) at their canonical process and cleared ${duplicatesDeleted} duplicate process record(s).`,
  };
};

export default function ProcessCleanup() {
  const { user, groups, values, toRelabel, unmatched, duplicateCount, configs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const clean = duplicateCount === 0 && toRelabel === 0;

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Process cleanup</h1>
        <p className="page-subtitle">
          Merges duplicate process records into the one configured on Process Times, and points every SKU
          at a single canonical process name.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && <div className="alert alert-error mb-4">{actionData.error}</div>}
      {actionData && "success" in actionData && actionData.success && <div className="alert alert-success mb-4">{actionData.message}</div>}

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Link to="/capacity" className="btn btn-secondary btn-sm">Process Times</Link>
        <Link to="/skus" className="btn btn-secondary btn-sm">SKU Catalog</Link>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Process records</div>
          <div className="stat-value">{configs.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Duplicates to merge</div>
          <div className={`stat-value ${duplicateCount ? "text-red-600" : "text-green-600"}`}>{duplicateCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">SKUs to relabel</div>
          <div className={`stat-value ${toRelabel ? "text-amber-600" : "text-green-600"}`}>{toRelabel}</div>
        </div>
      </div>

      {clean ? (
        <div className="alert alert-success mb-6">Nothing to clean up — every process is unique and every SKU uses its canonical name.</div>
      ) : (
        <Form method="post" className="mb-6" onSubmit={(e) => {
          if (!confirm(`Merge ${duplicateCount} duplicate process record(s) and relabel ${toRelabel} SKU(s)?`)) e.preventDefault();
        }}>
          <input type="hidden" name="intent" value="cleanup" />
          <button className="btn btn-primary" disabled={busy}>{busy ? "Cleaning up…" : "Run cleanup"}</button>
        </Form>
      )}

      {groups.length > 0 && (
        <div className="card mb-6">
          <div className="card-header"><span className="card-title">Duplicate process records</span></div>
          <div className="card-body">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Process</th><th>Keeping</th><th>Time/unit</th><th>Merging away</th></tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td className="font-medium">{g.keeper.displayName}</td>
                      <td className="font-mono text-xs">{g.keeper.processName}</td>
                      <td>{g.keeper.secondsPerUnit || <span className="text-red-600">not set</span>}</td>
                      <td className="font-mono text-xs text-red-600">
                        {g.duplicates.map((d) => `${d.processName} (${d.secondsPerUnit || 0}s)`).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">What each SKU currently stores</span></div>
        <div className="card-body">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Stored value</th><th>SKUs</th><th>Will become</th><th>Status</th></tr></thead>
              <tbody>
                {values.map((v) => (
                  <tr key={v.raw}>
                    <td className="font-mono text-xs">{v.raw}</td>
                    <td>{v.count}</td>
                    <td className="font-mono text-xs">{v.target ?? "—"}</td>
                    <td>
                      {v.unmatched ? <span className="badge badge-red">no matching process</span>
                        : v.needsChange ? <span className="badge badge-yellow">will be relabelled</span>
                        : <span className="badge badge-green">already canonical</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unmatched.length > 0 && (
            <p className="text-sm text-gray-600 mt-3">
              Values with no matching process are left untouched — add the process on Process Times, then run
              this again.
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}
