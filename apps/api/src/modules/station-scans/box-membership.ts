export interface MembershipRow {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  ownerIsThisScan: boolean;
}

/**
 * Hashes whose box item must be marked displaced.
 *
 * Aggregation follows ownership: 06b's rule is that the earlier scannedAt
 * owns the code, and a box may only count what its own scan owns. The item
 * is MARKED, never deleted — it is the only evidence that two terminals
 * boxed what is physically one item.
 */
export function displacedHashes(rows: MembershipRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) if (!r.ownerIsThisScan) out.add(r.codeHash);
  return [...out];
}
