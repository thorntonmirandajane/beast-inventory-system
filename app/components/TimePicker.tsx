import { useEffect, useLayoutEffect, useRef, useState } from "react";

// iOS-style scrollable wheel time picker. Start + End, each with hour (1–12),
// minute (0–59, every minute), and AM/PM wheels. Values are "HH:MM" 24h strings;
// an empty string means unset (a blank side => day off).

const ITEM_H = 34;
const VISIBLE = 5; // odd, so one is centered

function WheelColumn({
  items,
  index,
  onChange,
  width,
}: {
  items: string[];
  index: number;
  onChange: (i: number) => void;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [center, setCenter] = useState(index);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = index * ITEM_H;
    setCenter(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScroll = () => {
    if (!ref.current) return;
    const i = Math.max(0, Math.min(items.length - 1, Math.round(ref.current.scrollTop / ITEM_H)));
    setCenter(i);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => onChange(i), 90);
  };

  const pad = (VISIBLE - 1) / 2;
  return (
    <div style={{ position: "relative", width }}>
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{
          height: ITEM_H * VISIBLE,
          overflowY: "scroll",
          scrollSnapType: "y mandatory",
          WebkitOverflowScrolling: "touch",
          maskImage: "linear-gradient(to bottom, transparent, #000 30%, #000 70%, transparent)",
        }}
        className="no-scrollbar"
      >
        <div style={{ height: ITEM_H * pad }} />
        {items.map((it, i) => (
          <div
            key={i}
            onClick={() => {
              if (ref.current) ref.current.scrollTop = i * ITEM_H;
              onChange(i);
            }}
            style={{
              height: ITEM_H,
              scrollSnapAlign: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontWeight: i === center ? 700 : 400,
              color: i === center ? "#111827" : "#9ca3af",
              fontSize: i === center ? 17 : 15,
              transition: "color .1s, font-size .1s",
            }}
          >
            {it}
          </div>
        ))}
        <div style={{ height: ITEM_H * pad }} />
      </div>
      {/* center band */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: ITEM_H * pad,
          height: ITEM_H,
          borderTop: "1px solid #e5e7eb",
          borderBottom: "1px solid #e5e7eb",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const AMPM = ["AM", "PM"];

function to12(hhmm: string): { h: number; m: number; ap: number } {
  if (!hhmm) return { h: 8, m: 0, ap: 0 }; // default 8:00 AM
  const [H, M] = hhmm.split(":").map(Number);
  const ap = H >= 12 ? 1 : 0;
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return { h: h12 - 1, m: M, ap };
}
function from12(hIdx: number, mIdx: number, apIdx: number): string {
  const h12 = hIdx + 1;
  let H = h12 % 12;
  if (apIdx === 1) H += 12;
  return `${String(H).padStart(2, "0")}:${String(mIdx).padStart(2, "0")}`;
}

export function TimeWheels({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cur = to12(value || "08:00");
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center", background: "#fff", borderRadius: 8 }}>
      <WheelColumn items={HOURS} index={cur.h} width={44} onChange={(i) => onChange(from12(i, cur.m, cur.ap))} />
      <span style={{ fontWeight: 700 }}>:</span>
      <WheelColumn items={MINUTES} index={cur.m} width={52} onChange={(i) => onChange(from12(cur.h, i, cur.ap))} />
      <WheelColumn items={AMPM} index={cur.ap} width={48} onChange={(i) => onChange(from12(cur.h, cur.m, i))} />
    </div>
  );
}

// Mobile bottom sheet: slides up from the bottom, full-width wheels.
export function BottomSheetTimePicker({
  start,
  end,
  title,
  onDone,
  onClear,
  onClose,
}: {
  start: string;
  end: string;
  title: string;
  onDone: (start: string, end: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(start || "08:00");
  const [e, setE] = useState(end || "17:00");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "flex-end" }} onClick={onClose}>
      <div
        style={{ background: "#fff", width: "100%", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 24, animation: "sheetUp .2s ease-out" }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <style>{`@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
        <div style={{ textAlign: "center", fontWeight: 600, marginBottom: 12 }}>{title}</div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 4, textAlign: "center" }}>Start</div>
            <TimeWheels value={s} onChange={setS} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 4, textAlign: "center" }}>End</div>
            <TimeWheels value={e} onChange={setE} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-secondary text-red-600" style={{ flex: 1 }} onClick={() => { onClear(); onClose(); }}>Off</button>
          <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" style={{ flex: 2 }} onClick={() => { onDone(s, e); onClose(); }}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function TimeRangePicker({
  start,
  end,
  anchor,
  onDone,
  onClear,
  onClose,
}: {
  start: string;
  end: string;
  anchor: { left: number; top: number; bottom: number; width: number };
  onDone: (start: string, end: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(start || "08:00");
  const [e, setE] = useState(end || "17:00");
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number>(anchor.bottom + 6);
  // Viewport-aware: open below the cell, but flip above when there isn't room
  // (rows near the bottom of the list would otherwise cut off the wheels).
  useLayoutEffect(() => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const h = ref.current?.offsetHeight ?? 280;
    let t = anchor.bottom + 6;
    if (t + h > vh - 8) {
      const above = anchor.top - h - 6;
      t = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    setTop(t);
  }, [anchor]);
  const centerX = anchor.left + anchor.width / 2;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const left = Math.max(150, Math.min(vw - 150, centerX));
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        zIndex: 60,
        top,
        left,
        transform: "translateX(-50%)",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        boxShadow: "0 10px 30px rgba(0,0,0,.15)",
        padding: 12,
      }}
      onClick={(ev) => ev.stopPropagation()}
    >
      <div style={{ display: "flex", gap: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 4, textAlign: "center" }}>Start</div>
          <TimeWheels value={s} onChange={setS} />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 4, textAlign: "center" }}>End</div>
          <TimeWheels value={e} onChange={setE} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "space-between" }}>
        <button type="button" className="btn btn-secondary btn-sm text-red-600" onClick={() => { onClear(); onClose(); }}>
          Day off
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { onDone(s, e); onClose(); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
