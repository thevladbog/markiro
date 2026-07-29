/** A scan currently owning a code, as held by `code_registry`. */
export interface OwnerRow {
  codeHash: string;
  shiftId: string;
  terminalId: string | null;
  scannedAt: Date;
}

/** An accepted code from an incoming batch, competing for ownership. */
export interface ClaimItem {
  codeHash: string;
  shiftId: string;
  terminalId: string | null;
  scannedAt: Date;
}

export interface ConflictRow {
  codeHash: string;
  losing: Omit<ClaimItem, "codeHash">;
  winning: Omit<ClaimItem, "codeHash">;
}

function sideOf(x: ClaimItem | OwnerRow): Omit<ClaimItem, "codeHash"> {
  return { shiftId: x.shiftId, terminalId: x.terminalId, scannedAt: x.scannedAt };
}

function sameScan(a: Omit<ClaimItem, "codeHash">, b: Omit<ClaimItem, "codeHash">): boolean {
  return (
    a.shiftId === b.shiftId &&
    a.terminalId === b.terminalId &&
    a.scannedAt.getTime() === b.scannedAt.getTime()
  );
}

/**
 * Collapses a batch's accepted scans to at most one claim per code, keeping
 * the earliest `scannedAt` — the physical moment, never arrival order — so a
 * station that was offline does not lose an item merely because its
 * neighbour had a better link, and replaying a batch cannot change the
 * answer. A tie keeps the first item in array order, deterministically,
 * rather than depending on sort stability.
 *
 * This is now this function's ONLY job. Postgres refuses an ON CONFLICT DO
 * UPDATE whose VALUES name the same conflict key twice, so the batch must be
 * collapsed to one row per code before the upsert runs — that part is still
 * correct and race-free, since it only looks at the batch's own items.
 *
 * Ownership against any PRE-EXISTING incumbent, and every conflict row, used
 * to be decided here too, from a pre-read of `code_registry` passed in as
 * `owners`. That was wrong: under READ COMMITTED, two overlapping batches can
 * both read an empty (or stale) registry, each conclude "no conflict", and
 * the upsert's `setWhere` — which IS race-free, since it re-evaluates against
 * whatever the database actually holds at commit time — can then produce a
 * final owner that contradicts what was written to `code_conflicts`, or skip
 * writing a conflict at all. So this function no longer takes an `owners`
 * argument or returns `conflicts`/`lostByThisBatch`: every conflict is now
 * computed in the service, from the upsert's own `.returning()` and a
 * post-upsert re-read of the registry — see `conflictsAgainstOwner` and
 * `displacedIncumbents` below, and station-scans.service.ts.
 *
 * Runs in two passes rather than a single pairwise fold: folding compares
 * each item only against the *current* running winner, so with three or more
 * duplicates an early loser could get compared against an intermediate value
 * that a still-earlier duplicate later beats. Instead, the earliest scan per
 * code is found first, deterministically, regardless of array order.
 */
export function collapseClaims(items: ClaimItem[]): ClaimItem[] {
  const groups = new Map<string, ClaimItem[]>();
  for (const item of items) {
    const group = groups.get(item.codeHash);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.codeHash, [item]);
    }
  }

  const claims: ClaimItem[] = [];
  for (const [, group] of groups) {
    let winner = group[0]!;
    for (const candidate of group) {
      if (candidate.scannedAt < winner.scannedAt) {
        winner = candidate;
      }
    }
    claims.push(winner);
  }
  return claims;
}

/**
 * Pairs every accepted scan in the batch against its code's TRUE final
 * owner, as read back from `code_registry` AFTER the upsert has run, inside
 * the same transaction (`ownerByHash`) — never against a pre-read taken
 * before the upsert, which concurrency can invalidate (see `collapseClaims`'s
 * doc comment). A scan whose (shift, terminal, scannedAt) matches the owner
 * IS the owner and is not a conflict; every other scan in `items` lost.
 *
 * Every input here comes from the CURRENT batch, so every row this returns
 * is the sending station's own loss and belongs in both the sync response
 * and `code_conflicts` — see station-scans.service.ts.
 */
export function conflictsAgainstOwner(
  items: ClaimItem[],
  ownerByHash: ReadonlyMap<string, OwnerRow>,
): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const item of items) {
    const owner = ownerByHash.get(item.codeHash);
    // Every code in `items` was just fed through the upsert (or already
    // existed), so the post-upsert re-read must have a row for it; the
    // fallback is defensive only.
    if (!owner) continue;
    if (sameScan(sideOf(item), sideOf(owner))) continue;
    rows.push({ codeHash: item.codeHash, losing: sideOf(item), winning: sideOf(owner) });
  }
  return rows;
}

/**
 * Records the OTHER direction of losing: a code this batch just won (present
 * in `wonHashes`, from the upsert's `.returning()`) that had a DIFFERENT
 * pre-existing incumbent now displaces that incumbent's earlier-acknowledged
 * scan. That station cannot be told through the sync response — the cabinet
 * (`code_conflicts`) is the only record.
 *
 * `priorByHash` must come from a read taken before the upsert but locked
 * (`SELECT ... FOR UPDATE`) and held through it, in the same transaction, so
 * the value cannot change between the read and the upsert's own conflict
 * check — see station-scans.service.ts. Unlike `conflictsAgainstOwner`, this
 * is inherently about a scan that is NOT part of the current batch, so a
 * post-upsert re-read can't recover it: by the time this batch's upsert
 * commits, that row holds this batch's own claim, not the incumbent it
 * replaced.
 */
export function displacedIncumbents(
  claims: ClaimItem[],
  wonHashes: ReadonlySet<string>,
  priorByHash: ReadonlyMap<string, OwnerRow>,
): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const claim of claims) {
    if (!wonHashes.has(claim.codeHash)) continue;
    const prior = priorByHash.get(claim.codeHash);
    if (!prior) continue;
    if (sameScan(sideOf(prior), sideOf(claim))) continue;
    rows.push({ codeHash: claim.codeHash, losing: sideOf(prior), winning: sideOf(claim) });
  }
  return rows;
}
