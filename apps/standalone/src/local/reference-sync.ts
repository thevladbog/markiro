import { z } from "zod";

import { codeReleaseRecordSchema } from "../host/disaggregation.js";
import {
  categoryTemplateDefaultSchema,
  labelTemplateRecordSchema,
  lineRecordSchema,
  operatorBadgeRecordSchema,
  operatorRecordSchema,
  orgRecordSchema,
  productRecordSchema,
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
  /**
   * This pairing (`DeviceStatus.deviceId`): the host gives every pairing a new
   * device id, a re-pair with the same host included, so the copies, and every
   * page that may write them, are bound to it as well as to the host.
   */
  deviceId: string;
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
 * the data into the paths, which is why a template's layout is one opaque
 * value (`templateSpecSchema`, a single `custom` issue).
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
 * revision after a newer one; a stale run's page could, before `pairingGuard`
 * bound every page to its pairing (plan 1f), and this stays as a second line
 * of defence for whatever else might write an older record. Operators and
 * their badges carry it, since an older record would bring back access, and
 * the catalog's copies too (products, templates, category defaults), since an
 * older layout or default must not take the place the delete emptied, and
 * the organization and the lines since plan 2a5, whose floor names them and
 * reads the organization's zone and default template. Not `site`: its salt
 * never changes after the wizard.
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
      // `->>` yields `gs1Prefixes` as the JSON text of the array, and a
      // default template an older host does not send as NULL.
      upsert:
        "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, " +
        "default_box_template_id, default_pallet_template_id, default_duplicate_template_id, " +
        "rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'inn', r.value ->> 'gln', " +
        "r.value ->> 'gs1Prefixes', r.value ->> 'timeZone', r.value ->> 'defaultBoxTemplateId', " +
        "r.value ->> 'defaultPalletTemplateId', r.value ->> 'defaultDuplicateTemplateId', " +
        "r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("org_profile") +
        " " +
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, inn = excluded.inn, " +
        "gln = excluded.gln, gs1_prefixes = excluded.gs1_prefixes, " +
        "time_zone = excluded.time_zone, " +
        "default_box_template_id = excluded.default_box_template_id, " +
        "default_pallet_template_id = excluded.default_pallet_template_id, " +
        "default_duplicate_template_id = excluded.default_duplicate_template_id, " +
        "rev = excluded.rev " +
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
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'archived', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("lines") +
        " " +
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
  [
    "products",
    {
      table: "ref_products",
      check: (item) => checked(productRecordSchema, item),
      // `->>` yields `archived` as 1 or 0 and a JSON `null` as NULL.
      upsert:
        "INSERT INTO ref_products (id, gtin14, name, print_name, chz_group_code, box_capacity, " +
        "pallet_box_capacity, shelf_life_days, default_box_template_id, " +
        "default_pallet_template_id, archived, status, photo_checksum, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'gtin14', r.value ->> 'name', " +
        "r.value ->> 'printName', r.value ->> 'chzProductGroupCode', r.value ->> 'boxCapacity', " +
        "r.value ->> 'palletBoxCapacity', r.value ->> 'shelfLifeDays', " +
        "r.value ->> 'defaultBoxTemplateId', r.value ->> 'defaultPalletTemplateId', " +
        "r.value ->> 'archived', r.value ->> 'status', r.value ->> 'photoChecksum', " +
        "r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("products") +
        " ON CONFLICT (id) DO UPDATE SET gtin14 = excluded.gtin14, name = excluded.name, " +
        "print_name = excluded.print_name, chz_group_code = excluded.chz_group_code, " +
        "box_capacity = excluded.box_capacity, " +
        "pallet_box_capacity = excluded.pallet_box_capacity, " +
        "shelf_life_days = excluded.shelf_life_days, " +
        "default_box_template_id = excluded.default_box_template_id, " +
        "default_pallet_template_id = excluded.default_pallet_template_id, " +
        "archived = excluded.archived, status = excluded.status, " +
        "photo_checksum = excluded.photo_checksum, rev = excluded.rev " +
        "WHERE excluded.rev > ref_products.rev",
    },
  ],
  [
    "label_templates",
    {
      table: "ref_templates",
      check: (item) => checked(labelTemplateRecordSchema, item),
      // `->>` yields the categories and the layout as JSON text, and `null`
      // categories (every category) as NULL.
      upsert:
        "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'name', r.value ->> 'purpose', " +
        "r.value ->> 'enabled', r.value ->> 'chzProductGroupCodes', r.value ->> 'stock', " +
        "r.value ->> 'spec', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("label_templates") +
        " ON CONFLICT (id) DO UPDATE SET name = excluded.name, purpose = excluded.purpose, " +
        "enabled = excluded.enabled, category_codes = excluded.category_codes, " +
        "stock = excluded.stock, spec = excluded.spec, rev = excluded.rev " +
        "WHERE excluded.rev > ref_templates.rev",
    },
  ],
  [
    "category_template_defaults",
    {
      table: "ref_template_defaults",
      // The feed's id, `<code>:<purpose>`, is the key.
      check: (item) => checked(categoryTemplateDefaultSchema, item),
      upsert:
        "INSERT INTO ref_template_defaults (id, chz_group_code, purpose, template_id, rev) " +
        "SELECT r.value ->> 'id', r.value ->> 'chzProductGroupCode', r.value ->> 'purpose', " +
        "r.value ->> 'templateId', r.value ->> 'rev' " +
        "FROM json_each(?) AS r " +
        notQuarantinedNewer("category_template_defaults") +
        " ON CONFLICT (id) DO UPDATE SET chz_group_code = excluded.chz_group_code, " +
        "purpose = excluded.purpose, template_id = excluded.template_id, rev = excluded.rev " +
        "WHERE excluded.rev > ref_template_defaults.rev",
    },
  ],
]);

/**
 * The version of the kept records' schemas and of the copy tables' meaning.
 * Raise it whenever either changes: the stored `entity_set` then no longer
 * matches, every device syncs from zero, and records an older build
 * quarantined or kept differently come again.
 */
const SYNC_SCHEMA_VERSION = 5;

/**
 * The feed entities this build acts on but keeps no copy of (plan ДЗГ):
 * `code_releases`, a box a document took apart, whose codes this station
 * stops counting as its own. Part of `ENTITY_SET`: a build that starts
 * acting on one syncs from zero once and meets every release it skipped.
 */
const CODE_RELEASES = "code_releases";
const ACTION_ENTITIES = [CODE_RELEASES] as const;

/** A release's box id, read once per module and not once per item. */
const releaseBoxId = z.uuid();

/**
 * This build's copies and actions, in `sync_state.entity_set`: the feed
 * entities it keeps (derived from `ENTITIES`, so a new entity cannot update
 * that map and forget this value, or the reverse), the ones it only acts on
 * (`ACTION_ENTITIES`) and `SYNC_SCHEMA_VERSION`; nine entities and `v5`
 * today (`test/reference-sync.test.ts` pins the text). A build that keeps
 * other entities, or reads them differently, finds another value there and
 * syncs from zero: records the old build skipped or quarantined would never
 * come otherwise.
 */
export const ENTITY_SET = `${[...ENTITIES.keys(), ...ACTION_ENTITIES].join(",")};v${SYNC_SCHEMA_VERSION}`;

/**
 * Deletes this pairing's codes of the boxes a page's releases name, only
 * where this station's box of that id is closed and of the named shift
 * (plan ДЗГ, Р7): the host frees codes of closed shifts only (owner
 * decision ПР-1), and an open box here is never touched. The station's copy
 * of the shift is not asked: it lags the host's (an office close while the
 * station was offline), and a release skipped because of the lag would be
 * lost for good, the feed's cursor having moved on. The same delete as the
 * station's own disassembly (`box-exceptions.ts`), by box. The host names a
 * box once, and a closed box takes no codes, so a page applied again, or
 * the whole feed from zero after a restore, deletes nothing new.
 * Parameters: host id, device id, the releases (`[{ id, shiftId }]`), host
 * id, device id.
 */
export const APPLY_CODE_RELEASES_SQL =
  "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id IN " +
  "(SELECT b.id FROM json_each(?) AS r JOIN floor_boxes AS b ON b.id = r.value ->> 'id' " +
  "WHERE +b.host_id = ? AND +b.device_id = ? AND +b.shift_id = r.value ->> 'shiftId' " +
  "AND b.closed_at IS NOT NULL)";

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
  "INSERT INTO sync_state (key, value) " +
  "VALUES ('last_rev', ?), ('host_id', ?), ('device_id', ?), ('entity_set', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Stamps only the pairing — `host_id` and `device_id` — with no `last_rev`:
 * the immediate wipe for another pairing (`syncReferences`) must leave the
 * copies looking unsynced, so `readState` still starts the next page from
 * zero and a stale in-flight run for the old pairing is still caught by
 * `pairingGuard` below.
 */
const WRITE_PAIRING =
  "INSERT INTO sync_state (key, value) VALUES ('host_id', ?), ('device_id', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/**
 * Asks the next sync to start from zero (plan РК-С: the host went back to a
 * copy, and its revision may still be above the one the copies reached): it
 * fetches from revision 0, and its first page wipes the copies in the
 * transaction that refills them, so they stay usable until then. The wipe
 * deletes this mark with the rest of `sync_state`. The value is the epoch.
 */
export const FROM_ZERO_SQL =
  "INSERT INTO sync_state (key, value) VALUES ('from_zero', ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** Makes the copies read as unsynced: `readState` then starts from zero. */
const DROP_LAST_REV = "DELETE FROM sync_state WHERE key = 'last_rev'";

/**
 * Aborts the batch (`changes_mismatch`) unless `sync_state` is still stamped
 * to this run's pairing: `host_id` to `hostId` and `device_id` to `deviceId`,
 * both rows touched. Three things can make it not be, since a run's request
 * can stay in flight for up to 10 s after any of them happens:
 * - a re-pair repoints `host_id` to another host (`SyncScheduler.stop` does
 *   not cancel the old host's in-flight request), so its late page would
 *   otherwise commit under the old host's higher revisions and win
 *   `excluded.rev > rev` against the new host's rows — both hosts use the
 *   same ids (`'1'` for `ref_org`/`ref_site`), so it would resurrect the old
 *   host's org and site data;
 * - `device_forget`'s `clear_copies` deletes the `host_id` and `device_id`
 *   rows along with every other row, so a page fetched before the forget and
 *   committed after the clear would otherwise find nothing to conflict with
 *   and rewrite the old pairing's copies into a device that was told to
 *   forget them;
 * - a forget followed by a new pairing with the same host stamps `host_id`
 *   to the same value again, but `device_id` to the new pairing's: the old
 *   pairing's late page would otherwise pass, bring back a record a
 *   tombstone of the new run deleted (a turned-off operator, a revoked
 *   badge) and move `last_rev` back. The station's sign-in reads these
 *   copies (plan 1f), so this guard is its precondition.
 *
 * Every run stamps its pairing before its first fetch: two of the three
 * branches of `syncReferences` (below) write that stamp themselves (another
 * pairing, or no complete stamp yet); the third, the continuing branch,
 * writes nothing and instead requires the stamp a previous run already left
 * to still read this pairing, so a well-behaved run always satisfies this
 * guard. Placed first in every batch: a `DELETE FROM sync_state` later in the
 * same batch would remove the rows this statement reads.
 */
function pairingGuard(hostId: string, deviceId: string): LocalStatement {
  return {
    sql:
      "UPDATE sync_state SET value = value " +
      "WHERE (key = 'host_id' AND value = ?) OR (key = 'device_id' AND value = ?)",
    values: [hostId, deviceId],
    expectedChanges: 2,
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
  deviceId: string | null;
  entitySet: string | null;
  /** `FROM_ZERO_SQL` asked the next run to start from zero. */
  fromZero: boolean;
}

async function readState(local: LocalExecutor): Promise<StoredState> {
  const rows = await local.query("SELECT key, value FROM sync_state", [], stateRow);
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  const rev = value("last_rev");
  return {
    lastRev: rev !== null && /^\d+$/.test(rev) ? Number(rev) : null,
    hostId: value("host_id"),
    deviceId: value("device_id"),
    entitySet: value("entity_set"),
    fromZero: value("from_zero") !== null,
  };
}

/** A pairing: the host and the device id it gave this device (`DeviceStatus`). */
export interface Pairing {
  hostId: string;
  deviceId: string;
}

/**
 * Whether the copies are this pairing's: a run for this host and this device
 * id, with this build's entity set, has begun to fill them (a page has been
 * applied: `last_rev` is written on every page). Not whether they are
 * complete — an interrupted first sync of several pages reads ready with
 * partial copies, and sign-in then fails closed on the records it does not
 * find — and not whether they are fresh (the host may have been away since);
 * the station reads nothing else (offline first). Before the first sync of a
 * pairing, after a forget, after a wipe for another pairing and while a
 * build with another entity set has not yet applied its first page, the
 * answer is no.
 */
export async function copiesReady(local: LocalExecutor, pairing: Pairing): Promise<boolean> {
  const stored = await readState(local);
  return (
    stored.hostId === pairing.hostId &&
    stored.deviceId === pairing.deviceId &&
    stored.entitySet === ENTITY_SET &&
    stored.lastRev !== null
  );
}

/**
 * One page's own statements: per entity one conditional delete for its
 * tombstones and quarantined records and one upsert for its accepted
 * records, then one quarantine upsert, one quarantine lift and the page's
 * revision. A record that fails its schema fails closed: it is not applied,
 * an older copy of it goes as if deleted, and it waits in `sync_quarantine`.
 * Entities this build does not keep are skipped, not quarantined. A code
 * release (plan ДЗГ) is acted on, not kept: one statement per page, and an
 * invalid one is quarantined like any record, so the code stays a local
 * duplicate (fail closed) and the status bar counts it.
 *
 * `syncReferences` prepends `pairingGuard` and, when starting over, `WIPE`: for
 * E kept entities a batch holds at most 1 + (E + 2) + 2E + 3 + 1 (the
 * releases) = 3E + 7 statements — 31 for the eight kept today, the most
 * within the shell's 32: a ninth kept entity would need 34 (the next one must
 * take the way of `ACTION_ENTITIES`, which costs one statement for all). A
 * revision larger than a page's byte bound still comes whole, as one JSON
 * parameter per entity: the shell bounds SQL text and the number of values,
 * not a value's size.
 */
function pageStatements(page: ChangesResponse, pairing: Pairing, seenAt: number): LocalStatement[] {
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
  // The feed entities this build acts on without a copy (`ACTION_ENTITIES`).
  const releases: Array<{ id: string; shiftId: string }> = [];
  for (const item of page.items) {
    if (item.entity !== CODE_RELEASES) continue;
    const key = { id: item.id, rev: item.rev };
    // The host never deletes a release; a tombstone would only settle.
    if (item.deleted) {
      settled.push({ entity: item.entity, ...key });
      continue;
    }
    const record = codeReleaseRecordSchema.safeParse(item.data);
    const id = releaseBoxId.safeParse(item.id);
    if (!record.success) {
      quarantined.push({ entity: item.entity, ...key, reason: quarantineReason(record.error) });
    } else if (!id.success) {
      quarantined.push({ entity: item.entity, ...key, reason: "id: invalid_format" });
    } else {
      releases.push({ id: item.id, shiftId: record.data.shiftId });
      settled.push({ entity: item.entity, ...key });
    }
  }
  if (releases.length > 0) {
    statements.push({
      sql: APPLY_CODE_RELEASES_SQL,
      values: [
        pairing.hostId,
        pairing.deviceId,
        JSON.stringify(releases),
        pairing.hostId,
        pairing.deviceId,
      ],
    });
  }
  if (quarantined.length > 0) {
    statements.push({ sql: QUARANTINE, values: [seenAt, JSON.stringify(quarantined)] });
  }
  if (settled.length > 0) {
    statements.push({ sql: LIFT_QUARANTINE, values: [JSON.stringify(settled)] });
  }
  statements.push({
    sql: WRITE_STATE,
    values: [String(page.rev), pairing.hostId, pairing.deviceId, ENTITY_SET],
  });
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
  deviceId,
  now = () => Date.now(),
}: SyncOptions): Promise<SyncResult> {
  const pairing: Pairing = { hostId, deviceId };
  const stamp: LocalStatement = { sql: WRITE_PAIRING, values: [hostId, deviceId] };
  const stored = await readState(local);
  let since = 0;
  let wipe = false;
  if (
    (stored.hostId !== null && stored.hostId !== hostId) ||
    (stored.deviceId !== null && stored.deviceId !== deviceId)
  ) {
    // Copies from another pairing — with another host, or an earlier one
    // with this host — must not stay usable while this host is out of
    // reach. No `last_rev` is written, so the copies still read as unsynced
    // afterwards (start from zero next time too), and a stale in-flight run
    // for the old pairing is still caught below by `pairingGuard`, bound to
    // that pairing, once it reaches its batch.
    await local.transaction([...WIPE, stamp]);
  } else if (
    stored.hostId === hostId &&
    stored.deviceId === deviceId &&
    stored.entitySet === ENTITY_SET &&
    stored.lastRev !== null
  ) {
    // A restore of the host asks for the whole feed again (`FROM_ZERO_SQL`):
    // the first page wipes the copies as it refills them.
    since = stored.fromZero ? 0 : stored.lastRev;
    wipe = stored.fromZero;
  } else {
    if (stored.hostId === null || stored.deviceId === null) {
      // No complete stamp yet — this device's very first sync, or a state
      // an older build left with `host_id` alone — and the stamp cannot
      // wait for the first page. Without it, a concurrent first sync for a
      // different pairing that also reads no stamp takes this same branch,
      // and whichever of the two pages commits first passes `pairingGuard`
      // (it finds no rows to compare against) while the other — even though
      // it may be the pairing that is actually current — then fails its own
      // guard against the first one's stamp. Stamping up front means every
      // ordering has both rows in place before either page can land. The
      // older build's `last_rev` goes with it: copies nobody can tie to this
      // pairing must read as unsynced (`copiesReady`) until the first page
      // replaces them, and the next run must not continue from them.
      await local.transaction([stamp, { sql: DROP_LAST_REV }]);
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
    const statements = pageStatements(page, pairing, now());
    const guard = pairingGuard(hostId, deviceId);
    const batch = wipe ? [guard, ...WIPE, ...statements] : [guard, ...statements];
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
