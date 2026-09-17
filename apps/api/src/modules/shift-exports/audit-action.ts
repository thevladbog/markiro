/**
 * Both kinds of export live in `shift_exports`, but the audit trail names the
 * thing the operator acted on: a per-pallet export is a `pallet_export.*`
 * event, never a `shift_export.*` one. Shared by `ShiftExportsService` (the
 * request-driven `created`/`retried`/`downloaded` events) and
 * `ShiftExportRunnerService` (the job-driven `completed`/`failed` events) so
 * the rule lives in exactly one place.
 */
export function shiftExportAuditAction(row: { palletId: string | null }, action: string): string {
  return row.palletId === null ? action : action.replace(/^shift_export\./, "pallet_export.");
}
