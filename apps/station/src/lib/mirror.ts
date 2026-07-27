import { STATION_MIGRATIONS, type OperatorMirrorRecord } from "@markiro/db";

/** Backend-agnostic SQL surface so mirror logic is testable with node:sqlite. */
export interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Station-side mirror of the server ShiftBundleDto (Task 7). */
export interface StationBundle {
  shift: {
    id: string;
    status: string;
    mode: string;
    productId: string;
    productName: string | null;
    lineId: string | null;
    lineName: string | null;
    counterpartyId: string | null;
    counterpartyName: string | null;
    labelTemplateId: string | null;
    labelTemplateName: string | null;
    plannedQty: number | null;
    plannedDate: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    palletsEnabled: boolean;
    openedAt: string | null;
  };
  product: {
    id: string;
    gtin14: string;
    name: string;
    productGroup: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    status: string;
    defaultCounterpartyId: string | null;
    defaultLabelTemplateId: string | null;
  };
  labelTemplate: { id: string; name: string; spec: unknown } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
}

export interface ShiftMirrorRow {
  id: string;
  status: string;
  mode: string;
  counterpartyGln: string | null;
  labelTemplateSpec: string | null;
}

/** True for SQLite's "duplicate column name: x" error from a re-run ALTER. */
function isDuplicateColumnError(err: unknown): boolean {
  return /duplicate column name/i.test(err instanceof Error ? err.message : String(err));
}

export async function applyMigrations(exec: SqlExecutor): Promise<void> {
  for (const stmt of STATION_MIGRATIONS) {
    try {
      await exec.run(stmt);
    } catch (err) {
      // `CREATE TABLE IF NOT EXISTS` is idempotent; `ALTER TABLE ADD COLUMN`
      // is not, and every statement re-runs on each boot. A duplicate-column
      // error means the desired end state already holds — anything else is a
      // real failure and must surface.
      if (!isDuplicateColumnError(err)) throw err;
    }
  }
}

const b = (v: boolean) => (v ? 1 : 0);

/**
 * Idempotent upsert of a downloaded bundle into the local mirror tables.
 *
 * NOT wrapped in a transaction. `tauri-plugin-sql` pools connections (sqlx
 * `Pool::connect`, up to 10, FIFO idle queue) and can hand a different one to
 * every `exec.run` call, so a `BEGIN`/`COMMIT`/`ROLLBACK` sent as separate
 * calls does not actually group these statements — see `journal.ts`'s
 * `recordScan` doc comment for the full story. These are therefore
 * individual statements: the shift upsert, then the product upsert, then
 * `replaceOperatorsMirror`. A failure during the shift or product upsert
 * leaves that half applied until the next successful sync repairs it.
 * Operators no longer share that risk: `replaceOperatorsMirror` publishes
 * the roster atomically on its own (see its doc comment), so a failure
 * partway through it never exposes a removed or deactivated operator to
 * offline sign-in.
 */
export async function upsertBundle(exec: SqlExecutor, bundle: StationBundle): Promise<void> {
  await upsertBundleBody(exec, bundle);
}

async function upsertBundleBody(exec: SqlExecutor, bundle: StationBundle): Promise<void> {
  const s = bundle.shift;
  await exec.run(
    `INSERT INTO shift_mirror (
       id, status, mode, product_id, product_name, line_id, line_name,
       counterparty_id, counterparty_name, counterparty_gln,
       label_template_id, label_template_name, label_template_spec,
       planned_qty, planned_date, box_capacity, pallet_capacity, pallets_enabled, opened_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, mode=excluded.mode, product_id=excluded.product_id,
       product_name=excluded.product_name,
       line_id=excluded.line_id, line_name=excluded.line_name,
       counterparty_id=excluded.counterparty_id, counterparty_name=excluded.counterparty_name,
       counterparty_gln=excluded.counterparty_gln, label_template_id=excluded.label_template_id,
       label_template_name=excluded.label_template_name, label_template_spec=excluded.label_template_spec,
       planned_qty=excluded.planned_qty, planned_date=excluded.planned_date,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       pallets_enabled=excluded.pallets_enabled, opened_at=excluded.opened_at`,
    [
      s.id,
      s.status,
      s.mode,
      s.productId,
      s.productName,
      s.lineId,
      s.lineName,
      s.counterpartyId,
      s.counterpartyName,
      bundle.counterpartyGln,
      s.labelTemplateId,
      s.labelTemplateName,
      bundle.labelTemplate ? JSON.stringify(bundle.labelTemplate.spec) : null,
      s.plannedQty,
      s.plannedDate,
      s.boxCapacity,
      s.palletCapacity,
      b(s.palletsEnabled),
      s.openedAt,
    ],
  );

  const p = bundle.product;
  await exec.run(
    `INSERT INTO product_mirror (
       id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
       default_counterparty_id, default_label_template_id
     ) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       gtin14=excluded.gtin14, name=excluded.name, product_group=excluded.product_group,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       status=excluded.status, default_counterparty_id=excluded.default_counterparty_id,
       default_label_template_id=excluded.default_label_template_id`,
    [
      p.id,
      p.gtin14,
      p.name,
      p.productGroup,
      p.boxCapacity,
      p.palletCapacity,
      p.status,
      p.defaultCounterpartyId,
      p.defaultLabelTemplateId,
    ],
  );

  await replaceOperatorsMirror(exec, bundle.operators);
}

const ACTIVE_SLOT_KEY = "operators_slot";
const SLOT_TABLES = { a: "operators_mirror", b: "operators_mirror_b" } as const;
type RosterSlot = keyof typeof SLOT_TABLES;

function otherSlot(slot: RosterSlot): RosterSlot {
  return slot === "a" ? "b" : "a";
}

/**
 * The slot currently serving offline sign-in. Absent means "a", so a device
 * enrolled before the second slot existed keeps its roster on upgrade.
 *
 * A genuine query failure here is NOT caught: it must propagate rather than
 * fall back to "a". That fallback would be a confident wrong answer whenever
 * "b" is actually active — the read path would authenticate against the
 * previous generation, which by construction can still contain an operator
 * removed or deactivated in the current one, and the write path would stage
 * into the slot that is actually live.
 */
async function activeSlot(exec: SqlExecutor): Promise<RosterSlot> {
  const rows = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [ACTIVE_SLOT_KEY],
  );
  return rows[0]?.value === "b" ? "b" : "a";
}

/**
 * Serializes publishes so two overlapping refreshes can never both resolve
 * the same INACTIVE slot as their target. `App.tsx` fires `syncOperatorRoster`
 * unawaited on mount AND again on every `online` event, and `upsertBundle` is
 * a third entry point (see `journal.ts`'s doc comment for the same kind of
 * overlap observed on real devices). Without this, a second refresh that
 * starts before the first has flipped `station_meta` would resolve the same
 * target slot, race its DELETE/INSERT against the first's, and could end up
 * inserting into what has since become the LIVE slot.
 *
 * Each call's actual work (`publishOperatorsMirror`) is chained onto
 * `refreshChain`, so it does not even read `activeSlot()` until the previous
 * call has fully settled — including its `station_meta` flip.
 *
 * `refreshChain` itself always resolves (the trailing `.then(noop, noop)`): a
 * rejected refresh must not poison the queue for later callers. The
 * rejection is still delivered to the caller that issued that particular
 * refresh, via the `turn` promise returned below.
 *
 * Trade-off: because every publish now goes through this single chain, one
 * `exec.run` call that never settles (a hung `plugin:sql|execute` invoke)
 * stalls the chain forever and no roster refresh completes again for the
 * rest of the process's life — before serialization, a hung call only ever
 * blocked its own refresh. This is accepted: the alternative, letting
 * refreshes race, can publish a roster that still contains an operator who
 * was just removed server-side, which is the exact bug this file exists to
 * close. It is also not expected to bite in practice — sqlx's pool-acquire
 * fails with an error rather than hanging when it cannot get a connection.
 */
let refreshChain: Promise<void> = Promise.resolve();

/**
 * Publishes a complete roster atomically.
 *
 * The incoming operators are written into the INACTIVE slot, and only once
 * every row has landed is the active slot flipped — a single statement, which
 * is the only unit of atomicity `tauri-plugin-sql`'s connection pool gives us
 * (multi-call BEGIN/COMMIT can land on different pooled connections; see
 * `upsertBundle`). A refresh that fails partway is therefore never published:
 * the device keeps authenticating against the last complete roster instead of
 * a half-updated one, which previously left a removed or deactivated operator
 * able to sign in offline.
 *
 * A generation column on a single table cannot do this: writing the new
 * generation means upserting the operator's existing row, which moves it out
 * of the still-active generation, so an interrupted refresh would drop the
 * operators it had already rewritten.
 *
 * The table names are interpolated from `SLOT_TABLES`, a closed set of two
 * literals — never from a parameter — because SQLite has no placeholder for
 * an identifier.
 *
 * Calls are serialized by `refreshChain` (see its doc comment) so concurrent
 * refreshes never race onto the same inactive slot.
 */
export function replaceOperatorsMirror(
  exec: SqlExecutor,
  operators: OperatorMirrorRecord[],
): Promise<void> {
  const turn = refreshChain.then(() => publishOperatorsMirror(exec, operators));
  refreshChain = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

async function publishOperatorsMirror(
  exec: SqlExecutor,
  operators: OperatorMirrorRecord[],
): Promise<void> {
  const target: RosterSlot = otherSlot(await activeSlot(exec));
  const table = SLOT_TABLES[target];

  await exec.run(`DELETE FROM ${table}`);
  for (const op of operators) {
    await exec.run(
      `INSERT INTO ${table} (operator_id, name, login, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?,?)`,
      [op.operatorId, op.name, op.login, op.role, op.pinHash, op.badgeHash, b(op.active)],
    );
  }

  // The publish. Everything above this line is invisible to sign-in.
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [ACTIVE_SLOT_KEY, target],
  );

  // Best-effort: clear the generation that just went stale so a removed or
  // deactivated operator's PIN/badge hashes don't linger in the unencrypted
  // device DB for the whole inter-sync interval. The flip above already
  // succeeded and the new roster is already live, so a failure clearing the
  // old one must NOT fail this publish — the next refresh's
  // delete-before-staging cleans it up regardless.
  //
  // New failure mode this introduces: `readOperatorsMirror` is not on
  // `refreshChain`, so a sign-in that has just resolved the active slot can
  // yield the event loop and have this DELETE land before its own SELECT
  // runs, if a concurrent publish flips and then cleans up that same slot.
  // The read then sees an empty roster and the sign-in fails with a
  // spurious "wrong credentials". This is fail-closed (never authenticates
  // against a removed operator) and self-corrects on the caller's next
  // attempt, and it actually narrows the pre-existing stale-generation read
  // window rather than widening it — but it is a new user-visible failure
  // mode worth knowing about when triaging sign-in reports.
  try {
    await exec.run(`DELETE FROM ${SLOT_TABLES[otherSlot(target)]}`);
  } catch {
    // Swallowed intentionally: see comment above.
  }
}

export async function readShiftMirror(
  exec: SqlExecutor,
  id: string,
): Promise<ShiftMirrorRow | null> {
  const rows = await exec.all<{
    id: string;
    status: string;
    mode: string;
    counterparty_gln: string | null;
    label_template_spec: string | null;
  }>(
    "SELECT id, status, mode, counterparty_gln, label_template_spec FROM shift_mirror WHERE id = ?",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    counterpartyGln: r.counterparty_gln,
    labelTemplateSpec: r.label_template_spec,
  };
}

export interface ShiftContextRow {
  gtin14: string;
  productName: string;
  counterpartyName: string | null;
}

/**
 * What the work screen needs to judge scans, joined out of the mirrored
 * bundle. Returns null until `mirrorShiftBundle` has finished writing — the
 * station cannot validate a code before it knows the shift's product.
 */
export async function readShiftContext(
  exec: SqlExecutor,
  shiftId: string,
): Promise<ShiftContextRow | null> {
  const rows = await exec.all<{
    gtin14: string;
    name: string;
    counterparty_name: string | null;
  }>(
    `SELECT p.gtin14 AS gtin14, p.name AS name, s.counterparty_name AS counterparty_name
     FROM shift_mirror s JOIN product_mirror p ON p.id = s.product_id
     WHERE s.id = ?`,
    [shiftId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    gtin14: row.gtin14,
    productName: row.name,
    counterpartyName: row.counterparty_name,
  };
}

export async function readOperatorsMirror(exec: SqlExecutor): Promise<OperatorMirrorRecord[]> {
  const table = SLOT_TABLES[await activeSlot(exec)];
  const rows = await exec.all<{
    operator_id: string;
    name: string;
    login: string | null;
    role: string;
    pin_hash: string;
    badge_hash: string | null;
    active: number;
  }>(`SELECT operator_id, name, login, role, pin_hash, badge_hash, active FROM ${table}`);
  return rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    // Legacy rows (mirrored before the column existed) read as "", which never
    // matches a real personnel number; the first roster sync publishes them
    // into the other slot with a real login and deletes this stale slot.
    login: r.login ?? "",
    role: r.role,
    pinHash: r.pin_hash,
    badgeHash: r.badge_hash,
    active: r.active === 1,
  }));
}
