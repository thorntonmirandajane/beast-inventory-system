import { useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { requireRole, createAuditLog } from "../utils/auth.server";
import { Layout } from "../components/Layout";
import prisma from "../db.server";
import { applyOpeningCounts, getAvailableQuantity } from "../utils/inventory.server";
import { resolveProcessConfig } from "../utils/process";

type SpotType = "RAW" | "ASSEMBLY" | "COMPLETED";

type SpotSku = {
  id: string;
  sku: string;
  name: string;
  type: SpotType;
  process: string; // "" for raws/completed or no matching process
  upc: string; // "" if none; used to match completed-unit barcode labels
  onHand: number;
};

const AVAILABLE_STATE: Record<SpotType, "RAW" | "ASSEMBLED" | "COMPLETED"> = {
  RAW: "RAW",
  ASSEMBLY: "ASSEMBLED",
  COMPLETED: "COMPLETED",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);

  const [skus, processConfigs] = await Promise.all([
    prisma.sku.findMany({
      where: { isActive: true, type: { in: ["RAW", "ASSEMBLY", "COMPLETED"] } },
      select: { id: true, sku: true, name: true, type: true, material: true, upc: true },
      orderBy: [{ type: "asc" }, { sku: "asc" }],
    }),
    prisma.processConfig.findMany({
      where: { isActive: true },
      select: { displayName: true, processOrder: true },
      orderBy: { processOrder: "asc" },
    }),
  ]);

  const items: SpotSku[] = await Promise.all(
    skus.map(async (s) => {
      const type = s.type as SpotType;
      const onHand = await getAvailableQuantity(s.id, [AVAILABLE_STATE[type]]);
      const process =
        type === "ASSEMBLY"
          ? resolveProcessConfig(s.material, processConfigs)?.displayName ?? ""
          : "";
      return { id: s.id, sku: s.sku, name: s.name, type, process, upc: s.upc ?? "", onHand };
    })
  );

  return { user, items };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await requireRole(request, ["ADMIN", "MANAGER"]);

  const formData = await request.formData();
  const sku = String(formData.get("sku") || "").trim();
  const newQtyRaw = String(formData.get("newQty") || "").trim();

  if (!sku) return { error: "Pick a SKU first." };
  if (newQtyRaw === "" || !/^-?\d+$/.test(newQtyRaw)) {
    return { error: "Enter a whole-number count." };
  }
  const newQty = parseInt(newQtyRaw, 10);
  if (newQty < 0) return { error: "Count can't be negative." };

  const result = await applyOpeningCounts([{ sku, qty: newQty }], user.id, {
    dryRun: false,
    source: "SPOT_CHECK",
  });

  if (result.unknownSkus.length > 0) {
    return { error: `SKU "${sku}" not found.` };
  }
  const item = result.items[0];

  await createAuditLog(user.id, "SPOT_CHECK_COUNT", "InventoryItem", item.sku, {
    from: item.current,
    to: item.newQty,
    delta: item.delta,
    state: item.state,
  });

  return { applied: item };
};

export default function SpotCheck() {
  const { user, items } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [type, setType] = useState<SpotType>("RAW");
  const [processFilter, setProcessFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [newQty, setNewQty] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // Distinct processes among assemblies, for the sort/filter dropdown.
  const processes = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => {
      if (i.type === "ASSEMBLY" && i.process) set.add(i.process);
    });
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => i.type === type)
      .filter((i) => type !== "ASSEMBLY" || processFilter === "ALL" || i.process === processFilter)
      .filter((i) => !q || i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  }, [items, type, processFilter, search]);

  const selected = items.find((i) => i.id === selectedId) || null;
  const parsed = /^\d+$/.test(newQty.trim()) ? parseInt(newQty.trim(), 10) : null;
  const delta = selected && parsed !== null ? parsed - selected.onHand : null;

  function pick(id: string) {
    setSelectedId(id);
    const s = items.find((i) => i.id === id);
    setNewQty(s ? String(s.onHand) : "");
  }

  function switchType(t: SpotType) {
    setType(t);
    setProcessFilter("ALL");
    setSelectedId("");
    setNewQty("");
  }

  // Barcode labels encode the SKU (uppercased) or, for completed units, the UPC.
  function handleScan(code: string) {
    const c = code.trim();
    const cu = c.toUpperCase();
    const match =
      items.find((i) => i.sku.toUpperCase() === cu) ||
      items.find((i) => i.upc && i.upc.trim() === c);
    if (!match) {
      setScanMsg(`No SKU matches barcode "${c}". Keep scanning or enter it by hand.`);
      return; // leave the camera running
    }
    setScanning(false);
    setScanMsg(`Scanned ${match.sku}.`);
    setType(match.type);
    setProcessFilter("ALL");
    setSearch("");
    setSelectedId(match.id);
    setNewQty(String(match.onHand));
  }

  return (
    <Layout user={user}>
      <div className="page-header">
        <h1 className="page-title">Spot Check</h1>
        <p className="page-subtitle">
          Pick a SKU, compare its on-hand count to what you physically have, and correct it.
          A higher number adds inventory; a lower one removes it — logged as an adjustment.
        </p>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="alert alert-error mb-6">{actionData.error}</div>
      )}
      {actionData && "applied" in actionData && actionData.applied && (
        <div className="alert alert-success mb-6">
          <strong>{actionData.applied.sku}</strong> set to{" "}
          {actionData.applied.newQty.toLocaleString()} (was{" "}
          {actionData.applied.current.toLocaleString()}) —{" "}
          {actionData.applied.delta === 0 ? (
            "no change"
          ) : (
            <span className={actionData.applied.delta > 0 ? "text-green-700" : "text-red-700"}>
              {actionData.applied.delta > 0 ? "added" : "removed"}{" "}
              {Math.abs(actionData.applied.delta).toLocaleString()}
            </span>
          )}
          .
        </div>
      )}

      {scanning && (
        <BarcodeScanner onDetected={handleScan} onClose={() => setScanning(false)} />
      )}

      <div className="card mb-6">
        <div className="card-body space-y-4">
          {/* Scan (mobile) */}
          <div>
            <button
              type="button"
              className="btn btn-primary w-full sm:w-auto"
              onClick={() => {
                setScanMsg(null);
                setScanning(true);
              }}
            >
              📷 Scan barcode
            </button>
            {scanMsg && <p className="text-sm text-gray-600 mt-2">{scanMsg}</p>}
          </div>

          {/* Type toggle */}
          <div>
            <label className="form-label">SKU type</label>
            <div className="flex gap-2 flex-wrap">
              {(["RAW", "ASSEMBLY", "COMPLETED"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchType(t)}
                  className={`btn ${type === t ? "btn-primary" : "btn-secondary"}`}
                >
                  {t === "RAW" ? "Raw materials" : t === "ASSEMBLY" ? "Assembly SKUs" : "Completed units"}
                </button>
              ))}
            </div>
          </div>

          {/* Process filter (assemblies only) */}
          {type === "ASSEMBLY" && (
            <div className="form-group">
              <label htmlFor="processFilter" className="form-label">Sort by process</label>
              <select
                id="processFilter"
                className="form-input"
                value={processFilter}
                onChange={(e) => {
                  setProcessFilter(e.target.value);
                  setSelectedId("");
                  setNewQty("");
                }}
              >
                <option value="ALL">All processes</option>
                {processes.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}

          {/* Search + SKU picker */}
          <div className="form-group">
            <label htmlFor="search" className="form-label">Find SKU</label>
            <input
              id="search"
              className="form-input"
              placeholder="Type to filter by SKU or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="skuPick" className="form-label">SKU ({filtered.length})</label>
            <select
              id="skuPick"
              className="form-input"
              value={selectedId}
              onChange={(e) => pick(e.target.value)}
              size={Math.min(8, Math.max(3, filtered.length))}
            >
              {filtered.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.sku} — {i.name} ({i.onHand.toLocaleString()} on hand)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Adjust panel */}
      {selected && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title font-mono">{selected.sku}</h2>
          </div>
          <div className="card-body">
            <p className="text-sm text-gray-600 mb-4">
              {selected.name}
              {selected.type === "ASSEMBLY" && selected.process ? ` · ${selected.process}` : ""}
            </p>

            <div className="flex flex-wrap items-end gap-6 mb-4">
              <div>
                <div className="text-xs uppercase text-gray-500">System on hand</div>
                <div className="text-2xl font-semibold">{selected.onHand.toLocaleString()}</div>
              </div>
              <Form method="post" className="flex items-end gap-3">
                <input type="hidden" name="sku" value={selected.sku} />
                <div className="form-group mb-0">
                  <label htmlFor="newQty" className="form-label">Actual count</label>
                  <input
                    id="newQty"
                    name="newQty"
                    type="number"
                    min={0}
                    step={1}
                    className="form-input w-32"
                    value={newQty}
                    onChange={(e) => setNewQty(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting || delta === 0 || parsed === null}
                  onClick={(e) => {
                    if (
                      !confirm(
                        `Set ${selected.sku} to ${parsed?.toLocaleString()} (was ${selected.onHand.toLocaleString()})?`
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  {isSubmitting ? "Saving…" : "Apply count"}
                </button>
              </Form>
              {delta !== null && (
                <div>
                  <div className="text-xs uppercase text-gray-500">Change</div>
                  <div
                    className={
                      "text-2xl font-semibold " +
                      (delta > 0 ? "text-green-700" : delta < 0 ? "text-red-700" : "text-gray-400")
                    }
                  >
                    {delta > 0 ? "+" : ""}
                    {delta.toLocaleString()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let controls: { stop: () => void } | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } } },
          videoRef.current ?? undefined,
          (result) => {
            if (result && !cancelled) onDetectedRef.current(result.getText());
          }
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Could not start the camera — check camera permission and that you're on HTTPS."
        );
      }
    })();
    return () => {
      cancelled = true;
      try {
        controls?.stop();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg overflow-hidden w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 flex items-center justify-between border-b">
          <span className="font-medium">Point at the SKU barcode</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <div className="alert alert-error m-4">{error}</div>
        ) : (
          <video
            ref={videoRef}
            className="w-full bg-black"
            style={{ aspectRatio: "3 / 4", objectFit: "cover" }}
            muted
            playsInline
          />
        )}
        <p className="text-xs text-gray-500 p-3">
          Hold steady over the barcode. It selects the SKU automatically.
        </p>
      </div>
    </div>
  );
}
