// Carrier options + deep links to their public tracking pages. Pure module so
// both the PO list and detail pages can build a clickable tracking link.
export const CARRIERS = ["UPS", "FedEx", "USPS", "DHL", "Other"] as const;

export function carrierTrackingUrl(carrier: string | null | undefined, tracking: string | null | undefined): string | null {
  if (!carrier || !tracking) return null;
  const t = encodeURIComponent(tracking.trim());
  if (!t) return null;
  switch (carrier.toUpperCase()) {
    case "UPS":
      return `https://www.ups.com/track?tracknum=${t}`;
    case "FEDEX":
      return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
    case "USPS":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
    case "DHL":
      return `https://www.dhl.com/en/express/tracking.html?AWB=${t}`;
    default:
      return null;
  }
}
