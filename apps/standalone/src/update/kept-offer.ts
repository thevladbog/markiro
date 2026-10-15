import { useState } from "react";

import type { HostUpdateOffer } from "./host-offer.js";

export type AvailableOffer = Extract<HostUpdateOffer, { kind: "available" }>;

function same(a: AvailableOffer, b: AvailableOffer): boolean {
  return a.hostVersion === b.hostVersion && a.manifest === b.manifest && a.required === b.required;
}

/**
 * The offer for the «С хоста» dialog: the current one while it is available,
 * and the last available one for as long as the dialog is open — a link flap
 * or a re-read must not unmount a dialog in the middle of a download or of
 * the start.
 */
export function useKeptOffer(offer: HostUpdateOffer, open: boolean): AvailableOffer | null {
  const [kept, setKept] = useState<AvailableOffer | null>(null);
  const available = offer.kind === "available" ? offer : null;
  if (available !== null && (kept === null || !same(kept, available))) setKept(available);
  else if (available === null && !open && kept !== null) setKept(null);
  return available ?? (open ? kept : null);
}
