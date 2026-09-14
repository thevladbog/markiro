/**
 * Which device produced a pickup document.
 *
 * `pickup_orders` began as a kiosk table and the service threaded a bare
 * `kioskId` everywhere. A handheld files the same document for
 * `reason='writeoff'`, so the owner became data rather than an assumption baked
 * into a parameter name. Keep this a discriminated union: the compiler is what
 * guarantees every kiosk-only branch (admission proofs, day-limit bootstrap,
 * the kiosks table itself) stays explicitly kiosk-only.
 */
export type PickupDocumentSource =
  { kind: "kiosk"; kioskId: string } | { kind: "handheld"; stationDeviceId: string };

export function kioskSource(kioskId: string): PickupDocumentSource {
  return { kind: "kiosk", kioskId };
}

export function handheldSource(stationDeviceId: string): PickupDocumentSource {
  return { kind: "handheld", stationDeviceId };
}

/** The exact `pickup_orders` owner columns for a source. */
export function sourceColumns(source: PickupDocumentSource): {
  sourceKind: "kiosk" | "handheld";
  kioskId: string | null;
  stationDeviceId: string | null;
} {
  return source.kind === "kiosk"
    ? { sourceKind: "kiosk", kioskId: source.kioskId, stationDeviceId: null }
    : { sourceKind: "handheld", kioskId: null, stationDeviceId: source.stationDeviceId };
}

/** Stable identifier for log lines. Never used as a query key. */
export function sourceLabel(source: PickupDocumentSource): string {
  return source.kind === "kiosk" ? `kiosk ${source.kioskId}` : `handheld ${source.stationDeviceId}`;
}
