// Read-only API gate for the Dealer Orders (queued-orders) app.
// The Beast <-> Dealer link already shares BEAST_API_SECRET (the inventory
// system sends it to the dealer app as x-beast-secret when pulling programmed
// orders); we validate the same header/secret for calls coming the other way,
// so no new secret needs provisioning. Read-only: the dealer app only reads
// STG stock, it never writes here.
export function requireDealerAuth(
  request: Request,
): { ok: true } | { ok: false; response: Response } {
  const expected = process.env.BEAST_API_SECRET;
  if (!expected) {
    return {
      ok: false,
      response: Response.json(
        { error: "Dealer API not configured (BEAST_API_SECRET unset)" },
        { status: 503 },
      ),
    };
  }
  const provided = request.headers.get("x-beast-secret");
  if (provided !== expected) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}
