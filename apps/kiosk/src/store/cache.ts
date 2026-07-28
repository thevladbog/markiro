import type { KioskBootstrapDto } from "../api/types.js";
import { STORE_SNAPSHOT, withStore } from "./db.js";

const KEY = "current";

export interface CachedSnapshot {
  bootstrap: KioskBootstrapDto;
  fetchedAt: string;
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
 * Both write paths call this — the sync refresh and pairing. It lives here,
 * beside the write it protects, rather than being restated at each call site:
 * they are the same hole through two different doors, and a copy of the
 * condition is a copy that can rot on one side only.
 *
 * Throws rather than returning a boolean so a caller cannot quietly ignore it.
 */
export function assertMeasurableGeneratedAt(bootstrap: KioskBootstrapDto): void {
  if (Number.isNaN(Date.parse(bootstrap.generatedAt))) {
    throw new Error(
      `bootstrap has an unparseable generatedAt: ${JSON.stringify(bootstrap.generatedAt)}`,
    );
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
 */
export async function replaceSnapshot(
  bootstrap: KioskBootstrapDto,
  fetchedAt: Date,
): Promise<void> {
  await withStore(STORE_SNAPSHOT, "readwrite", (s) =>
    s.put({ bootstrap, fetchedAt: fetchedAt.toISOString() }, KEY),
  );
}
