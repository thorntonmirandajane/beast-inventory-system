// Shorthand schedule-hours parsing, shared by the weekly grid (client, for live
// totals/errors) and the server actions (to store start/end). Pure — no server
// deps — so it bundles to the client too.
//
// Accepted: "start-end" where each side is an hour (7, 11) or hour:min (7:30,
// 11:30) on a 12-hour clock, no am/pm. Blank / off / x / - / — = day off.
// Ambiguous end < start defaults to a daytime shift (10-2 => 10:00–14:00).

export interface ParsedCell {
  off: boolean;
  error?: string;
  hours: number; // 0 when off or error
  start?: string; // "HH:MM" 24h
  end?: string; // "HH:MM" 24h
}

const OFF_TOKENS = new Set(["off", "x", "-", "—", "–", "n/a", "none"]);

function to24(hour12: number, minute: number, isStart: boolean, startVal?: number): number {
  // Daytime heuristic: starts 6–11 are AM, 12 is noon, 1–5 are PM.
  if (isStart) {
    if (hour12 === 12) return 12 * 60 + minute;
    if (hour12 >= 6) return hour12 * 60 + minute; // 6–11 AM
    return (hour12 + 12) * 60 + minute; // 1–5 -> PM
  }
  // End: noon stays noon; otherwise prefer PM if that lands after the start.
  if (hour12 === 12) return 12 * 60 + minute;
  const pm = (hour12 + 12) * 60 + minute;
  if (startVal != null && pm > startVal) return pm;
  const am = hour12 * 60 + minute;
  if (startVal != null && am > startVal) return am;
  return pm;
}

export function parseShorthand(raw: string): ParsedCell {
  const s = (raw || "").trim().toLowerCase();
  if (s === "") return { off: true, hours: 0 };
  if (OFF_TOKENS.has(s)) return { off: true, hours: 0 };

  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return { off: false, hours: 0, error: "format" };

  const sh = parseInt(m[1], 10);
  const smin = m[2] ? parseInt(m[2], 10) : 0;
  const eh = parseInt(m[3], 10);
  const emin = m[4] ? parseInt(m[4], 10) : 0;
  if (sh < 1 || sh > 12 || eh < 1 || eh > 12 || smin > 59 || emin > 59) {
    return { off: false, hours: 0, error: "time" };
  }

  const startMin = to24(sh, smin, true);
  const endMin = to24(eh, emin, false, startMin);
  if (endMin <= startMin) return { off: false, hours: 0, error: "order" };

  const hours = Math.round(((endMin - startMin) / 60) * 100) / 100;
  const fmt = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return { off: false, hours, start: fmt(startMin), end: fmt(endMin) };
}

// "07:00" -> "7:00 AM", "15:30" -> "3:30 PM"
export function format12(hhmm?: string | null): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h)) return hhmm;
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m || 0).padStart(2, "0")} ${ap}`;
}

// "07:00","15:00" -> "7-3"; "07:30","15:30" -> "7:30-3:30"
export function toShorthand(start?: string | null, end?: string | null): string {
  if (!start || !end) return "";
  const h12 = (t: string) => {
    const [h, mm] = t.split(":").map(Number);
    const hh = h % 12 === 0 ? 12 : h % 12;
    return mm ? `${hh}:${String(mm).padStart(2, "0")}` : `${hh}`;
  };
  return `${h12(start)}-${h12(end)}`;
}
