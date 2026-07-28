import type { SqlExecutor } from "./mirror.js";

const META_KEY = "install_id";

/**
 * This installation's stable random identifier: generated once and
 * persisted in `station_meta` (the same key/value table `hardware_config`
 * and the roster slot pointer use), read back on every later call rather
 * than regenerated per process. That is what makes it survive an app
 * restart — and, crucially, NOT survive `station-mirror.db` being deleted
 * and recreated, since it is itself a row in that same database.
 *
 * Pairing this into the sync batch key (see `sync.ts`) is what closes the
 * Finding 3 gap: a support action that deletes only the corrupt local
 * database — leaving `station.json`, and therefore `machineId`, untouched —
 * used to let the outbox's id counter restart at 1 while the batch key's
 * other component (`machineId`) stayed the same, so the very first
 * post-recreation batch could collide with a batch key the server had
 * already recorded, and the device would silently delete scans the server
 * had never actually seen. A fresh database now mints a fresh `install_id`
 * on its very first use, so its batch keys occupy a keyspace the server has
 * never seen, however the outbox ids happen to restart.
 */
export async function getInstallId(exec: SqlExecutor): Promise<string> {
  const existing = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [META_KEY],
  );
  if (existing[0]?.value) return existing[0].value;

  const id = crypto.randomUUID();
  // ON CONFLICT DO NOTHING: a concurrent first caller (two engines built in
  // the same process against the same database, or a StrictMode
  // double-invoke) could win this insert race. Reading back afterwards,
  // rather than trusting the `id` this call generated, is what makes every
  // caller agree on whichever id actually landed.
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
    [META_KEY, id],
  );
  const after = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [META_KEY],
  );
  // Fall back to the id THIS call generated rather than a non-null assertion
  // on the read-back: an empty read-back (a device DB error surfacing as a
  // 0-row result instead of a thrown one) would otherwise throw a confusing
  // `TypeError` deep in a batch key, and a pre-existing row with a NULL
  // value (schema allows it; nothing has ever written one, but nothing
  // guarantees it either) would silently produce the literal string
  // `"null"` as a batch-key component instead of an actual id.
  return after[0]?.value ?? id;
}
