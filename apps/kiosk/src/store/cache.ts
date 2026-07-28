import type { KioskBootstrapDto } from "../api/types.js";
import { STORE_SNAPSHOT, withStore } from "./db.js";

const KEY = "current";

export interface CachedSnapshot {
  bootstrap: KioskBootstrapDto;
  fetchedAt: string;
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
