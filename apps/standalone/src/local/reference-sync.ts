import { z } from "zod";

import {
  lineRecordSchema,
  operatorBadgeRecordSchema,
  operatorRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";

/**
 * `quarantined`: the feed records the copies hold in `sync_quarantine` after
 * this run, the ones from earlier runs included.
 */
export type SyncResult =
  { kind: "synced"; rev: number; quarantined: number } | { kind: "other_host" };

export interface SyncOptions {
  /** `GET /v1/changes?since=<rev>` (`HostApi.getChanges`). */
  changes: (since: number) => Promise<ChangesResponse>;
  local: LocalExecutor;
  /** The host this device is paired with (`DeviceStatus.hostId`). */
  hostId: string;
  /** Unix milliseconds for `sync_quarantine.seen_at`; this computer's clock unless a test pins it. */
  now?: () => number;
}

/**
 * The feed broke its own contract: the host went back twice in one run, or
 * a page claimed more without moving past the revision it was asked for.
 * A class of its own, so the shell can tell a feed failure from a host or a
 * local one.
 */
export class SyncFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncFeedError";
  }
}

/** A live record flattened for `upsert`, or why it fails its schema. */
type Checked = { row: Record<string, unknown> } | { reason: string };

interface EntityTable {
  table: string;
  /** Checks a live record: flattened with its key and revision, or the quarantine reason. */
  check: (item: ChangeItem) => Checked;
  /** Every accepted record of a page in one statement: `json_each` over the rows. */
  upsert: string;
}

/** The longest `sync_quarantine.reason`. */
const MAX_REASON_LENGTH = 200;

/**
 * Why a record fails its schema, from Zod issue paths and codes only
 * (`archived: invalid_type`; `data` names the record itself): never a value,
 * since operator records carry PIN and badge hashes. That holds only while
 * every record schema has fixed keys: a `z.record` would put keys taken from
 * the data into the paths.
 */
function quarantineReason(error: z.ZodError): string {
  const reason = error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "data" : issue.path.map(String).join(".");
      return `${path}: ${issue.code}`;
    })
    .join("; ");
  return reason.slice(0, MAX_REASON_LENGTH);
}

function checked<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  item: ChangeItem,
): Checked {
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) return { reason: quarantineReason(parsed.error) };
  return { row: { ...parsed.data, id: item.id, rev: item.rev } };
}

/**
 * The `WHERE` of an upsert that keeps an older revision of a record out while
 * a newer one waits in quarantine: the insert would otherwise bring back what
 * the quarantine's fail-closed delete took away. The feed never sends an older
 * revision after a newer one, but a stale run can: a page fetched before
 * `device_forget` that lands only after a new pairing with the same host has
 * stamped `host_id` again, when `hostGuard` no longer stops it. Only for the
 * records that grant access, operators and their badges.
 */
function notQuarantinedNewer(entity: string): string {
  return (
    "WHERE NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
    `WHERE q.entity = '${entity}' AND q.id = r.value ->> 'id' AND q.rev > r.value ->> 'rev')`
  );
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
  [
    "org_profile",
    {
      table: "ref_org",
      check: (item) => checked(orgRecordSchema, item),
      // `->>` yields `gs1Prefixes` as the JSON text of the array.
      upsert:
        "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'inn', value ->> 'gln', " +
        "value ->> 'gs1Prefixes', value ->> 'timeZone', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
        "time_zone = excluded.time_zone, rev = excluded.rev " +
        "WHERE excluded.rev > ref_org.rev",
    },
  ],
  [
    "site",
    {
      table: "ref_site",
      check: (item) => checked(siteRecordSchema, item),
      upsert:
        "INSERT INTO ref_site (id, badge_salt, box_block_size, pallet_block_size, rev) " +
        "SELECT value ->> 'id', value ->> 'badgeSalt', value ->> 'boxBlockSize', " +
        "value ->> 'palletBlockSize', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET badge_salt = excluded.badge_salt, " +
        "box_block_size = excluded.box_block_size, " +
        "pallet_block_size = excluded.pallet_block_size, rev = excluded.rev " +
        "WHERE excluded.rev > ref_site.rev",
    },
  ],
  [
    "lines",
    {
      table: "ref_lines",
      // `->>` yields `archived` as 1 or 0.
      check: (item) => checked(lineRecordSchema, item),
      upsert:
        "INSERT INTO ref_lines (id, name, archived, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, " +
        "rev = excluded.rev " +
        "WHERE excluded.rev > ref_lines.rev",
    },
  ],
  [
    "operators",
    {
      table: "ref_operators",
      check: (item) => checked(operatorRecordSchema, item),
      upsert:
        "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'login', r.value ->> 'name', r.value ->> 'role', " +
        "r.value ->> 'pinPhc', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("operators") +
        " ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, " +
        "role = excluded.role, pin_phc = excluded.pin_phc, rev = excluded.rev " +
        "WHERE excluded.rev > ref_operators.rev",
    },
  ],
  [
    "operator_badges",
    {
      table: "ref_operator_badges",
      check: (item) => checked(operatorBadgeRecordSchema, item),
      upsert:
        "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'operatorId', r.value ->> 'badgePhc', " +
        "r.value ->> 'label', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("operator_badges") +
        " ON CONFLICT (id) DO UPDATE SET operator_id = excluded.operator_id, " +
        "badge_phc = excluded.badge_phc, label = excluded.label, rev = excluded.rev " +
        "WHERE excluded.rev > ref_operator_badges.rev",
    },
  ],
]);

/**
 * The version of the kept records' schemas and of the copy tables' meaning.
 * Raise it whenever either changes: the stored `entity_set` then no longer
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 3;

/**
 * This build's copies, in `sync_state.entity_set`: the feed entities it
 * keeps (derived from `ENTITIES`, so a new entity cannot update that map and
 * forget this value, or the reverse) and `SYNC_SCHEMA_VERSION`. Today:
 * `"org_profile,site,lines,operators,operator_badges;v3"`. A build that
 * keeps other entities, or reads them differently, finds another value there
 * and syncs from zero: records the old build skipped or quarantined would
 * never come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys()].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
 * Deletes the rows that the page's tombstones and quarantined records are
 * newer than: an older one (the key was created again, or the copy is
 * already newer) leaves the row alone.
 */
function deleteOlder(table: string): string {
  return (
    `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(?) AS t ` +
    `WHERE t.value ->> 'id' = ${table}.id AND t.value ->> 'rev' > ${table}.rev)`
  );
}

/**
 * The page's quarantined records in one statement: a record already
 * quarantined is replaced only by a newer revision of it, so applying a page
 * again changes nothing. `seen_at` comes as a parameter, not from SQL.
 */
const QUARANTINE =
  "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
  "SELECT value ->> 'entity', value ->> 'id', value ->> 'rev', value ->> 'reason', ? " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT (entity, id) DO UPDATE SET rev = excluded.rev, reason = excluded.reason, " +
  "seen_at = excluded.seen_at " +
  "WHERE excluded.rev > sync_quarantine.rev";

/**
 * Lifts the quarantine of every record the page accepted or deleted, in one
 * statement: only for a revision at least the quarantined one, so an older
 * record never clears a newer quarantine.
 */
const LIFT_QUARANTINE =
  "DELETE FROM sync_quarantine WHERE EXISTS (SELECT 1 FROM json_each(?) AS t " +
  "WHERE t.value ->> 'entity' = sync_quarantine.entity " +
  "AND t.value ->> 'id' = sync_quarantine.id AND t.value ->> 'rev' >= sync_quarantine.rev)";

/** Every copy, the quarantine and the sync state: the next page applied starts from zero. */
const WIPE: readonly LocalStatement[] = [
  ...[...ENTITIES.values()].map((entity) => ({ sql: `DELETE FROM ${entity.table}` })),
  { sql: "DELETE FROM sync_quarantine" },
  { sql: "DELETE FROM sync_state" },
];

const WRITE_STATE =
  "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?), ('host_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Stamps only `host_id`, with no `last_rev`: the immediate wipe for a new
 * host (`syncReferences`) must leave the copies looking unsynced, so
 * `readState` still starts the next page from zero and a stale in-flight
 * run for the old host is still caught by `hostGuard` below.
 */
const WRITE_HOST_ID =
  "INSERT INTO sync_state (key, value) VALUES ('host_id', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Aborts the batch (`changes_mismatch`) unless `sync_state.host_id` is still
 * stamped to `hostId`. Two things can make it not be, since a run's request
 * can stay in flight for up to 10 s after either happens:
 * - a re-pair repoints `host_id` to another host (`SyncScheduler.stop` does
 *   not cancel the old host's in-flight request), so its late page would
 *   otherwise commit under the old host's higher revisions and win
 *   `excluded.rev > rev` against the new host's rows — both hosts use the
 *   same ids (`'1'` for `ref_org`/`ref_site`), so it would resurrect the old
 *   host's org and site data;
 * - `device_forget`'s `clear_copies` deletes the `host_id` row along with
 *   every other row, so a page fetched before the forget and committed
 *   after the clear would otherwise find nothing to conflict with and
 *   rewrite the old pairing's copies into a device that was told to forget
 *   them.
 *
 * Every run stamps `host_id` to its own `hostId` before its first fetch: two
 * of the three branches of `syncReferences` (below) write that stamp
 * themselves (a re-pair, or this device's very first sync); the third, the
 * continuing branch, writes nothing and instead requires the stamp a
 * previous run already left to still read `hostId`, so a well-behaved run
 * always satisfies this guard. Placed first in every batch: a `DELETE FROM
 * sync_state` later in the same batch would remove the `host_id` row this
 * statement reads.
 */
function hostGuard(hostId: string): LocalStatement {
  return {
    sql: "UPDATE sync_state SET value = value WHERE key = 'host_id' AND value = ?",
    values: [hostId],
    expectedChanges: 1,
  };
}

const stateRow = z.object({ key: z.string(), value: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * `sync_quarantine`'s current size, for a successful run's own
 * `SyncResult.quarantined`. Throws if the read itself fails: a page that
 * just committed cleanly must not be reported `quarantined: 0` merely
 * because the trailing count could not be read — the run fails instead,
 * exactly as a failure earlier in the same page would.
 */
async function countQuarantined(local: LocalExecutor): Promise<number> {
  const [count] = await local.query("SELECT count(*) AS n FROM sync_quarantine", [], countRow);
  return count?.n ?? 0;
}

/**
 * `sync_quarantine`'s current size for a run that did not reach
 * `countQuarantined` above — a failed run's catch (`useHostLink`) reads it,
 * so the station and the office still show how many records are quarantined
 * after a run that never got that far, a restart with the host away
 * included. Returns `null` if the query itself fails, so a caller with
 * nothing better to show can keep whatever count it already had instead of
 * replacing it with a wrong zero; unlike `countQuarantined`, that fallback is
 * the right call here, since there is no page write for a read failure to
 * contradict.
 */
export async function readQuarantineCount(local: LocalExecutor): Promise<number | null> {
  try {
    return await countQuarantined(local);
  } catch {
    return null;
  }
}

interface StoredState {
  lastRev: number | null;
  hostId: string | null;
  entitySet: string | null;
}

async function readState(local: LocalExecutor): Promise<StoredState> {
  const rows = await local.query("SELECT key, value FROM sync_state", [], stateRow);
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  const rev = value("last_rev");
  return {
    lastRev: rev !== null && /^\d+$/.test(rev) ? Number(rev) : null,
    hostId: value("host_id"),
    entitySet: value("entity_set"),
  };
}

/**
 * One page's own statements: per entity one conditional delete for its
 * tombstones and quarantined records and one upsert for its accepted
 * records, then one quarantine upsert, one quarantine lift and the page's
 * revision. A record that fails its schema fails closed: it is not applied,
 * an older copy of it goes as if deleted, and it waits in `sync_quarantine`.
 * Entities this build does not keep are skipped, not quarantined.
 *
 * `syncReferences` prepends `hostGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 = 3E + 6
 * statements — 21 for the five kept today, and E = 8 (30) at most within the
 * shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string, seenAt: number): LocalStatement[] {
  const statements: LocalStatement[] = [];
  const quarantined: Array<{ entity: string; id: string; rev: number; reason: string }> = [];
  const settled: Array<{ entity: string; id: string; rev: number }> = [];
  for (const [entity, table] of ENTITIES) {
    const older: Array<{ id: string; rev: number }> = [];
    const rows: Array<Record<string, unknown>> = [];
    for (const item of page.items) {
      if (item.entity !== entity) continue;
      const key = { id: item.id, rev: item.rev };
      if (item.deleted) {
        older.push(key);
        settled.push({ entity, ...key });
        continue;
      }
      const record = table.check(item);
      if ("row" in record) {
        rows.push(record.row);
        settled.push({ entity, ...key });
      } else {
        older.push(key);
        quarantined.push({ entity, ...key, reason: record.reason });
      }
    }
    if (older.length > 0) {
      statements.push({ sql: deleteOlder(table.table), values: [JSON.stringify(older)] });
    }
    if (rows.length > 0) statements.push({ sql: table.upsert, values: [JSON.stringify(rows)] });
  }
  if (quarantined.length > 0) {
    statements.push({ sql: QUARANTINE, values: [seenAt, JSON.stringify(quarantined)] });
  }
  if (settled.length > 0) {
    statements.push({ sql: LIFT_QUARANTINE, values: [JSON.stringify(settled)] });
  }
  statements.push({ sql: WRITE_STATE, values: [String(page.rev), hostId, ENTITY_SET] });
  return statements;
}

/**
 * Brings the local copies up to the host's revision (stage 1 spec §5.4):
 * pages of `GET /v1/changes` from the last applied revision until `hasMore`
 * is false, each page in one `local_transaction`. Applying a page again
 * changes nothing: a row changes only for a newer revision. Stops, applying
 * nothing, when the feed comes from another host than the paired one; a
 * feed that breaks its own contract fails the run with `SyncFeedError`.
 */
export async function syncReferences({
  changes,
  local,
  hostId,
  now = () => Date.now(),
}: SyncOptions): Promise<SyncResult> {
  const stored = await readState(local);
  let since = 0;
  let wipe = false;
  if (stored.hostId !== null && stored.hostId !== hostId) {
    // Copies from a pairing with another host must not stay usable while
    // this host is out of reach. No `last_rev` is written, so the copies
    // still read as unsynced afterwards (start from zero next time too),
    // and a stale in-flight run for the old host is still caught below by
    // `hostGuard`, bound to that old host's id, once it reaches its batch.
    await local.transaction([...WIPE, { sql: WRITE_HOST_ID, values: [hostId] }]);
  } else if (
    stored.hostId === hostId &&
    stored.entitySet === ENTITY_SET &&
    stored.lastRev !== null
  ) {
    since = stored.lastRev;
  } else {
    if (stored.hostId === null) {
      // No pairing recorded yet: there are never copies without a `host_id`,
      // so there is nothing to wipe, but the stamp itself cannot wait for
      // the first page. Without it, a concurrent first sync for a different
      // host that also reads no `host_id` takes this same branch, and
      // whichever of the two pages commits first passes `hostGuard` (it
      // finds no row to compare against) while the other — even though it
      // may be the pairing that is actually current — then fails its own
      // guard against the first one's stamp. Stamping up front means every
      // ordering has a `host_id` row in place before either page can land.
      await local.transaction([{ sql: WRITE_HOST_ID, values: [hostId] }]);
    }
    // Another build's entity set, or no sync yet: start from zero and drop
    // the old copies with the first page, so a failed fetch keeps them.
    wipe = true;
  }
  let wentBack = false;
  for (;;) {
    const page = await changes(since);
    if (page.hostId !== hostId) return { kind: "other_host" };
    if (page.rev < since) {
      // The host went back (restored from a copy): rows of the lost
      // revisions would block newer edits, so start again from zero.
      if (wentBack) {
        throw new SyncFeedError(`the host went back twice in one sync: ${page.rev} < ${since}`);
      }
      wentBack = true;
      since = 0;
      wipe = true;
      continue;
    }
    if (page.hasMore && page.rev <= since) {
      // `rev >= since` is established above, so this is `rev === since`:
      // the feed claims more pages without moving past the one just read.
      // Left unchecked, this would fetch and commit the same page forever.
      throw new SyncFeedError(
        `the feed made no progress at rev ${page.rev} while claiming more pages`,
      );
    }
    const statements = pageStatements(page, hostId, now());
    const batch = wipe
      ? [hostGuard(hostId), ...WIPE, ...statements]
      : [hostGuard(hostId), ...statements];
    await local.transaction(batch);
    wipe = false;
    since = page.rev;
    if (!page.hasMore) {
      return { kind: "synced", rev: page.rev, quarantined: await countQuarantined(local) };
    }
  }
}

export interface SyncScheduler {
  /** Sync now, or once more right after the sync in progress. */
  trigger: () => void;
  /** Start no sync after this one; a sync in progress finishes on its own. */
  stop: () => void;
}

/**
 * One sync at a time. Triggers during a run ask for exactly one more run
 * after it; a failed run just ends and waits for the next trigger. `run`
 * must report its own failure (a status field, a logged error, a toast):
 * this scheduler swallows every rejection and guarantees only the
 * single-flight-plus-one-follow-up scheduling, nothing about the outcome.
 */
export function createSyncScheduler(run: () => Promise<void>): SyncScheduler {
  let running = false;
  let again = false;
  let stopped = false;
  async function loop(): Promise<void> {
    running = true;
    try {
      do {
        again = false;
        try {
          await run();
        } catch {
          // The run reports its own failure; the next trigger tries again.
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }
  return {
    trigger: () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      void loop();
    },
    stop: () => {
      stopped = true;
    },
  };
}
