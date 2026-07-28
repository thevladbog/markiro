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

export interface Resolution {
  /** Rows to upsert, already collapsed so one code appears at most once. */
  claims: ClaimItem[];
  /** Every losing scan, in both directions. */
  conflicts: ConflictRow[];
  /** The subset the SENDING station should be told about: its own losses. */
  lostByThisBatch: ConflictRow[];
}

function sideOf(x: ClaimItem | OwnerRow): Omit<ClaimItem, "codeHash"> {
  return { shiftId: x.shiftId, terminalId: x.terminalId, scannedAt: x.scannedAt };
}

/**
 * Decides who owns each code in a batch, and records every scan that lost.
 *
 * The rule is "the earlier scan wins", by `scannedAt` — the physical moment,
 * never arrival order — so a station that was offline does not lose an item
 * merely because its neighbour had a better link, and replaying a batch
 * cannot change the answer. A tie leaves ownership with the incumbent, since
 * the comparison is strict.
 *
 * Losing happens in two directions and they are told apart deliberately:
 * an incoming scan that loses to the incumbent is the sender's own problem
 * and comes back in the sync response; an incoming scan that DISPLACES the
 * incumbent makes some other terminal's earlier-acknowledged scan the loser,
 * and that station cannot be told through this response — the cabinet is the
 * backstop. `lostByThisBatch` is that distinction.
 */
export function resolveOwnership(items: ClaimItem[], owners: OwnerRow[]): Resolution {
  const conflicts: ConflictRow[] = [];
  const lostByThisBatch: ConflictRow[] = [];

  // Postgres refuses an ON CONFLICT DO UPDATE whose values name the same
  // conflict key twice, so the batch is collapsed first. This runs in two
  // passes rather than a single pairwise fold: folding compares each item
  // only against the *current* running winner, so with three or more
  // duplicates an early loser could get recorded as losing to an
  // intermediate value that a still-earlier duplicate later beats. Instead,
  // the earliest scan per code is found first, then every other item in
  // that group is recorded as losing to THAT earliest — so the winner named
  // in every emitted conflict is always the batch's true earliest,
  // regardless of array order. On an exact tie within the batch, the first
  // item in array order wins, deterministically, rather than depending on
  // sort stability.
  const groups = new Map<string, ClaimItem[]>();
  for (const item of items) {
    const group = groups.get(item.codeHash);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.codeHash, [item]);
    }
  }

  const best = new Map<string, ClaimItem>();
  for (const [codeHash, group] of groups) {
    let winner = group[0]!;
    for (const candidate of group) {
      if (candidate.scannedAt < winner.scannedAt) {
        winner = candidate;
      }
    }
    best.set(codeHash, winner);
    for (const candidate of group) {
      if (candidate === winner) continue;
      const row = { codeHash, losing: sideOf(candidate), winning: sideOf(winner) };
      conflicts.push(row);
      lostByThisBatch.push(row);
    }
  }

  const ownerByHash = new Map(owners.map((o) => [o.codeHash, o]));
  const claims: ClaimItem[] = [];

  for (const item of best.values()) {
    const incumbent = ownerByHash.get(item.codeHash);
    if (!incumbent) {
      claims.push(item);
      continue;
    }
    if (item.scannedAt < incumbent.scannedAt) {
      claims.push(item);
      // The displaced scan belongs to a batch acknowledged long ago; its
      // station learns from the cabinet, not from this response.
      conflicts.push({
        codeHash: item.codeHash,
        losing: sideOf(incumbent),
        winning: sideOf(item),
      });
      continue;
    }
    const row = { codeHash: item.codeHash, losing: sideOf(item), winning: sideOf(incumbent) };
    conflicts.push(row);
    lostByThisBatch.push(row);
  }

  return { claims, conflicts, lostByThisBatch };
}
