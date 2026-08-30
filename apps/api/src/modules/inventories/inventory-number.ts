/**
 * Inventory document numbering.
 *
 * Inventories share the house document format used by pickup orders (`ORD`)
 * and disaggregation acts (`DSG`): a Latin prefix, the two-digit year of
 * creation, and a zero-padded per-tenant sequence.
 *
 * The explicit `INVENTORY` prefix keeps the number readable and distinct from
 * billing invoices (`MRK-INV-NNNNNN`) in the same cabinet.
 */

/** Formats a per-tenant sequence + creation date as `INVENTORY-YY-NNNN`. */
export function formatInventoryNumber(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `INVENTORY-${yy}-${String(seq).padStart(4, "0")}`;
}
