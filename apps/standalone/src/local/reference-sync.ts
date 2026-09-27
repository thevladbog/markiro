import { z } from "zod";

import {
  lineRecordSchema,
  orgRecordSchema,
  siteRecordSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";

export type SyncResult = { kind: "synced"; rev: number } | { kind: "other_host" };

export interface SyncOptions {
  /** `GET /v1/changes?since=<rev>` (`HostApi.getChanges`). */
  changes: (since: number) => Promise<ChangesResponse>;
  local: LocalExecutor;
  /** The host this device is paired with (`DeviceStatus.hostId`). */
  hostId: string;
}

interface EntityTable {
  table: string;
  /** Checks a live record and flattens it, with its key and revision, for `upsert`. */
  row: (item: ChangeItem) => Record<string, unknown>;
  /** Every live record of a page in one statement: `json_each` over the rows. */
  upsert: string;
}

/** A live record's `data`, or an error that leaves the whole page unapplied. */
function checked<T>(schema: z.ZodType<T>, item: ChangeItem): T {
  const parsed = schema.safeParse(item.data);
  if (!parsed.success) {
    throw new Error(`unreadable ${item.entity} record ${item.id}: ${parsed.error.message}`);
  }
  return parsed.data;
}

const ENTITIES: ReadonlyMap<string, EntityTable> = new Map([
  [
    "org_profile",
    {
      table: "ref_org",
      row: (item) => ({ ...checked(orgRecordSchema, item), id: item.id, rev: item.rev }),
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
      row: (item) => ({ ...checked(siteRecordSchema, item), id: item.id, rev: item.rev }),
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
      row: (item) => ({ ...checked(lineRecordSchema, item), id: item.id, rev: item.rev }),
      upsert:
        "INSERT INTO ref_lines (id, name, archived, rev) " +
        "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
        "FROM json_each(?) WHERE true " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, " +
        "rev = excluded.rev " +
        "WHERE excluded.rev > ref_lines.rev",
    },
  ],
]);

/**
 * The feed entities this build keeps, in `sync_state.entity_set`: derived
 * from `ENTITIES` so a new entity cannot update that map and forget this
 * one (or the reverse). Today: `"org_profile,site,lines"`. A build that
 * keeps more (plans 1d and 1e) finds another value there and syncs from
 * zero: the old build skipped those entities, so their records would never
 * come otherwise.
 */
export const ENTITY_SET = [...ENTITIES.keys()].join(",");

/**
 * Deletes the rows that tombstones of the page are newer than: a tombstone
 * older than a row (the key was created again) leaves it alone.
 */
function tombstoneDelete(table: string): string {
  return (
    `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(?) AS t ` +
    `WHERE t.value ->> 'id' = ${table}.id AND t.value ->> 'rev' > ${table}.rev)`
  );
}

/** Every copy and the sync state: the next page applied starts from zero. */
const WIPE: readonly LocalStatement[] = [
  ...[...ENTITIES.values()].map((entity) => ({ sql: `DELETE FROM ${entity.table}` })),
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
 * Aborts the batch (`changes_mismatch`) if another run has already
 * repointed `sync_state.host_id` away from `hostId` since this run read it.
 * A device can be re-paired while a run's request to the old host is still
 * in flight (up to 10 s); `SyncScheduler.stop` does not cancel that request,
 * so its page can arrive after a new run already wiped and restamped
 * `host_id` for the new host. Without this guard, that late page would
 * commit under the old host's higher revisions and win `excluded.rev > rev`
 * against the new host's rows — both hosts use the same ids (`'1'` for
 * `ref_org`/`ref_site`), so it would resurrect the old host's org and site
 * data. Placed first in every batch: a `DELETE FROM sync_state` later in
 * the same batch would remove the `host_id` row this statement reads.
 */
function hostGuard(hostId: string): LocalStatement {
  return {
    sql: "UPDATE sync_state SET value = value WHERE key = 'host_id' AND value <> ?",
    values: [hostId],
    expectedChanges: 0,
  };
}

const stateRow = z.object({ key: z.string(), value: z.string() });

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
 * One page's own statements: per entity a conditional delete for its
 * tombstones and one upsert for its live records, then the page's revision.
 * Records are checked before anything is written. Entities this build does
 * not keep are skipped. At most two statements per entity plus one: 7
 * today. `syncReferences` prepends `hostGuard` and, when starting over,
 * `WIPE`: guard (1) + wipe (4) + this (7) is 12, within the shell's 32.
 */
function pageStatements(page: ChangesResponse, hostId: string): LocalStatement[] {
  const statements: LocalStatement[] = [];
  for (const [entity, table] of ENTITIES) {
    const items = page.items.filter((item) => item.entity === entity);
    const tombstones = items.filter((item) => item.deleted).map(({ id, rev }) => ({ id, rev }));
    const live = items.filter((item) => !item.deleted).map((item) => table.row(item));
    if (tombstones.length > 0) {
      statements.push({ sql: tombstoneDelete(table.table), values: [JSON.stringify(tombstones)] });
    }
    if (live.length > 0) statements.push({ sql: table.upsert, values: [JSON.stringify(live)] });
  }
  statements.push({ sql: WRITE_STATE, values: [String(page.rev), hostId, ENTITY_SET] });
  return statements;
}

/**
 * Brings the local copies up to the host's revision (stage 1 spec §5.4):
 * pages of `GET /v1/changes` from the last applied revision until `hasMore`
 * is false, each page in one `local_transaction`. Applying a page again
 * changes nothing: a row changes only for a newer revision. Stops, applying
 * nothing, when the feed comes from another host than the paired one.
 */
export async function syncReferences({ changes, local, hostId }: SyncOptions): Promise<SyncResult> {
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
  } else if (stored.entitySet === ENTITY_SET && stored.lastRev !== null) {
    since = stored.lastRev;
  } else {
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
      if (wentBack) throw new Error(`the host went back twice in one sync: ${page.rev} < ${since}`);
      wentBack = true;
      since = 0;
      wipe = true;
      continue;
    }
    if (page.hasMore && page.rev <= since) {
      // `rev >= since` is established above, so this is `rev === since`:
      // the feed claims more pages without moving past the one just read.
      // Left unchecked, this would fetch and commit the same page forever.
      throw new Error(`the feed made no progress at rev ${page.rev} while claiming more pages`);
    }
    const statements = pageStatements(page, hostId);
    const batch = wipe
      ? [hostGuard(hostId), ...WIPE, ...statements]
      : [hostGuard(hostId), ...statements];
    await local.transaction(batch);
    wipe = false;
    since = page.rev;
    if (!page.hasMore) return { kind: "synced", rev: page.rev };
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
