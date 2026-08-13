import type { KioskBootstrapDto, KioskBootstrapSnapshotDto } from "../api/types.js";
import { STORE_SNAPSHOT, withStore } from "./db.js";

const KEY = "current";

export interface CachedSnapshot {
  bootstrap: KioskBootstrapSnapshotDto;
  fetchedAt: string;
}

/**
 * A bootstrap the store refused because it cannot be measured.
 *
 * A named type rather than a bare `Error` because callers must tell it apart
 * from a transport failure and give the two different instructions: a network
 * blink is worth retrying with the same pairing code, an unusable payload never
 * is — redeeming it already spent the code, so every retry can only 401.
 */
export class UnusableBootstrapError extends Error {
  constructor(generatedAt: unknown) {
    super(`bootstrap has an unparseable generatedAt: ${JSON.stringify(generatedAt)}`);
    this.name = "UnusableBootstrapError";
  }
}

/**
 * Refuses a bootstrap whose `generatedAt` cannot be parsed, BEFORE anything is
 * persisted.
 *
 * `cacheAge` measures staleness against that stamp and nothing else, and every
 * comparison against a NaN age is false — so a stored unparseable stamp reads
 * `fresh` forever and permanently disables the seven-day lockout. A gate that
 * cannot establish freshness must not assert it, and the cheapest place to
 * stop that is at the door: never let such a snapshot into the store.
 *
 * Both write paths call this — the sync refresh and pairing — because both must
 * react to the refusal before they act (pairing picks a different message for
 * it, and neither wants a rejected write in the middle of a sequence). Those
 * pre-checks are for the CALLER's control flow; `replaceSnapshot` asserts this
 * itself as well, so the invariant survives a call site that forgets.
 *
 * Throws rather than returning a boolean so a caller cannot quietly ignore it.
 */
export function assertMeasurableGeneratedAt(bootstrap: KioskBootstrapSnapshotDto): void {
  if (Number.isNaN(Date.parse(bootstrap.generatedAt))) {
    throw new UnusableBootstrapError(bootstrap.generatedAt);
  }
}

export async function readSnapshot(): Promise<CachedSnapshot | null> {
  const found = await withStore<CachedSnapshot>(STORE_SNAPSHOT, "readonly", (s) => s.get(KEY));
  return found ?? null;
}

/**
 * Replaces the whole snapshot in ONE transaction. Two properties matter and
 * both come from it being a single `put` of a single record: a reader never
 * observes a half-written dataset, and an employee deleted on the server
 * disappears locally instead of lingering (the station's
 * `replaceOperatorsMirror` achieves the same with two slot tables and a
 * pointer flip; IndexedDB gives it to us for free).
 *
 * Rejects an unmeasurable `generatedAt` HERE, at the write, and not only where
 * the callers check it: a guard that lives entirely in its call sites is one
 * the next write path added can bypass without noticing. The store owns the
 * invariant because the store is what would be poisoned by breaking it.
 */
export async function replaceSnapshot(
  bootstrap: KioskBootstrapDto,
  fetchedAt: Date,
): Promise<void> {
  assertMeasurableGeneratedAt(bootstrap);
  await withStore(STORE_SNAPSHOT, "readwrite", (s) =>
    s.put({ bootstrap, fetchedAt: fetchedAt.toISOString() }, KEY),
  );
}
