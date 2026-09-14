function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Native owner checks accepted barcode/operator/job; grant additionally binds its frozen print policy. */
export function matchesPreparedEvidenceScope(
  scope: Record<string, unknown>,
  event: { shiftId: string; policyRevision: string; templateDigest: string; dpi: number },
): boolean {
  const shift = object(scope.shift),
    snapshot = object(shift?.validationPrintSnapshot),
    spec = object(snapshot?.spec);
  return (
    shift?.id === event.shiftId &&
    shift.mode === "validation" &&
    shift.validationPrintMode === "duplicate_dm" &&
    shift.validationPrintPolicyRevision === event.policyRevision &&
    snapshot?.digest === event.templateDigest &&
    spec?.dpi === event.dpi
  );
}
