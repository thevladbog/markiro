export interface MembershipRow {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  ownerIsThisScan: boolean;
}

/**
 * Exact box-item rows that must be marked displaced.
 *
 * Aggregation follows ownership: 06b's rule is that the earlier scannedAt
 * owns the code, and a box may only count what its own scan owns. The item
 * is MARKED, never deleted — it is the only evidence that two terminals
 * boxed what is physically one item.
 */
export function displacedMemberships(rows: MembershipRow[]): MembershipRow[] {
  return rows.filter((row) => !row.ownerIsThisScan);
}
