// Read-only API gate for the Archery Brand Brain integration.
// Each /api/brain/* loader calls this first; without the matching x-brain-secret
// header, no DB query runs. The brain never sees this database directly — it can
// only consume the curated rollups the loaders return.
export function requireBrainAuth(request: Request): { ok: true } | { ok: false; response: Response } {
  const expected = process.env.BRAIN_API_SECRET;
  if (!expected) {
    return { ok: false, response: Response.json({ error: "Brain API not configured (BRAIN_API_SECRET unset)" }, { status: 503 }) };
  }
  const provided = request.headers.get("x-brain-secret");
  if (provided !== expected) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}
