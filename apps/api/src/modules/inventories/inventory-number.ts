/**
 * Inventory document numbering.
 *
 * Inventories share the house document format used by pickup orders (`ORD`)
 * and disaggregation acts (`DSG`): a Latin prefix, the two-digit year of
 * creation, and a zero-padded per-tenant sequence.
 *
 * The prefix is `IVN` rather than `INV` because `INV-NNNNNN` already
 * identifies billing invoices in the same cabinet.
 */

/** Formats a per-tenant sequence + creation date as `IVN-YY-NNNN`. */
export function formatInventoryNumber(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `IVN-${yy}-${String(seq).padStart(4, "0")}`;
}
