import assert from "node:assert/strict";
import type { createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";

const kinds = ["receiving", "transformation", "shipping"] as const;
const tables = kinds.map((kind) => `${kind}_counters`);
const prefixes: Record<string, string> = {
  receiving: "REC",
  transformation: "TRN",
  shipping: "SHP",
};
const counts: Record<string, number> = { receiving: 2, transformation: 1, shipping: 1 };
export type CounterRow = {
  table: string;
  key: string;
  body: { tenant_id: string; year: number; sequence: number; [key: string]: unknown };
};
export type NewRootEvidence = {
  kind: string;
  id: string;
  tenant_id: string;
  event_number: string;
  event_id: string | null;
  event_tenant_id: string | null;
  event_type: string | null;
  root_event_id: string | null;
  original_event_number: string | null;
  revision: number | null;
  created_at: string | null;
  time_zone: string | null;
};
type RootIdentity = Pick<NewRootEvidence, "kind" | "id" | "tenant_id" | "event_number">;
type CounterBaseline = { counters: CounterRow[]; roots: RootIdentity[] };
type Queryable = Pick<ReturnType<typeof createDb>["pool"], "query">;
const counterKey = (tenant: string, year: number) => `[${JSON.stringify(tenant)}, ${year}]`;
const identity = (row: CounterRow) => `${row.table}:${row.key}`;

function validateCounters(rows: readonly CounterRow[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    assert(tables.includes(row.table), "Unknown counter table");
    assert(
      typeof row.body.tenant_id === "string" && row.body.tenant_id.length > 0,
      "Invalid tenant",
    );
    assert(
      Number.isInteger(row.body.year) && row.body.year >= 1 && row.body.year <= 9999,
      "Invalid counter year",
    );
    assert(
      Number.isSafeInteger(row.body.sequence) && row.body.sequence > 0,
      "Invalid counter sequence",
    );
    assert.equal(row.key, counterKey(row.body.tenant_id, row.body.year), "Counter PK mismatch");
    assert(!seen.has(identity(row)), "Duplicate counter key");
    seen.add(identity(row));
  }
}

function allocationYear(root: NewRootEvidence): number {
  assert(typeof root.created_at === "string", "Missing allocation instant");
  const match =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      root.created_at,
    );
  assert(match, "Invalid or ambiguous allocation instant");
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  assert(
    Number.isFinite(date.getTime()) && date.toISOString().startsWith(`${match[1]}T`),
    "Invalid allocation date",
  );
  const instant = new Date(root.created_at);
  assert(Number.isFinite(instant.getTime()), "Invalid allocation instant");
  assert(
    typeof root.time_zone === "string" && root.time_zone.length > 0,
    "Missing allocation timezone",
  );
  const year = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: root.time_zone, year: "numeric" }).format(instant),
  );
  assert(Number.isInteger(year) && year >= 1 && year <= 9999, "Invalid allocation year");
  return year;
}

/** Before facts + independently collected original allocations; no observed after sequence. */
export function expectedCounterTransition(
  before: readonly CounterRow[],
  newRoots: readonly NewRootEvidence[],
  tenantId: string,
): CounterRow[] {
  validateCounters(before);
  assert(typeof tenantId === "string" && tenantId.length > 0, "Invalid expected tenant");
  assert.equal(newRoots.length, 4, "Expected exactly four new roots");
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const groups = new Map<string, { table: string; year: number; suffixes: number[] }>();
  for (const kind of kinds)
    assert.equal(
      newRoots.filter((root) => root.kind === kind).length,
      counts[kind],
      `Unexpected ${kind} root count`,
    );
  for (const root of newRoots) {
    assert(Object.hasOwn(prefixes, root.kind), "Unknown root kind");
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(root.id),
      "Invalid root ID",
    );
    assert(!ids.has(root.id), "Duplicate root ID");
    ids.add(root.id);
    assert.equal(root.tenant_id, tenantId, "Foreign new root");
    assert.equal(root.event_tenant_id, tenantId, "Foreign original event");
    assert.equal(root.event_id, root.id, "Missing original event identity");
    assert.equal(root.root_event_id, root.id, "Wrong original root pointer");
    assert.equal(root.event_type, root.kind, "Wrong original event kind");
    assert.equal(root.revision, 1, "Expected original revision 1");
    assert.equal(root.original_event_number, root.event_number, "Original number mismatch");
    assert(!numbers.has(root.event_number), "Duplicate root number");
    numbers.add(root.event_number);
    const year = allocationYear(root);
    const match = /^(REC|TRN|SHP)-(\d{2})-(\d{4,})$/.exec(root.event_number);
    assert(match, "Invalid allocation number");
    const suffix = Number(match[3]);
    assert(Number.isSafeInteger(suffix) && suffix > 0, "Invalid allocation suffix");
    assert.equal(
      root.event_number,
      `${prefixes[root.kind]}-${String(year).slice(-2).padStart(2, "0")}-${String(suffix).padStart(4, "0")}`,
      "Allocation year, prefix or formatting mismatch",
    );
    const table = `${root.kind}_counters`;
    const key = `${table}:${counterKey(tenantId, year)}`;
    const group = groups.get(key) ?? { table, year, suffixes: [] };
    group.suffixes.push(suffix);
    groups.set(key, group);
  }
  const expected = structuredClone([...before]);
  for (const [key, group] of groups) {
    let row = expected.find((value) => identity(value) === key);
    const oldSequence = row?.body.sequence ?? 0;
    const suffixes = [...group.suffixes].sort((a, b) => a - b);
    assert.deepEqual(
      suffixes,
      Array.from({ length: suffixes.length }, (_, index) => oldSequence + index + 1),
      "Allocations must be contiguous after the saved sequence",
    );
    if (!row) {
      row = {
        table: group.table,
        key: counterKey(tenantId, group.year),
        body: { tenant_id: tenantId, year: group.year, sequence: 0 },
      };
      expected.push(row);
    }
    row.body.sequence = oldSequence + suffixes.length;
  }
  validateCounters(expected);
  return expected;
}

/** Relation ordering is immaterial; every actual row, key and body field is compared. */
export function assertCounterTransition(
  before: readonly CounterRow[],
  newRoots: readonly NewRootEvidence[],
  tenantId: string,
  after: readonly CounterRow[],
): CounterRow[] {
  const expected = expectedCounterTransition(before, newRoots, tenantId);
  validateCounters(after);
  const ordered = (rows: readonly CounterRow[]) =>
    [...rows].sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0));
  assert.deepEqual(
    ordered(after),
    ordered(expected),
    "Whole counter state differs from exact allocations",
  );
  return expected;
}

const rootRelation = kinds
  .map((kind) => `SELECT '${kind}' AS kind,id,tenant_id,event_number FROM ${kind}_event_roots`)
  .join(" UNION ALL ");
async function readCounters(pool: Queryable): Promise<CounterRow[]> {
  const rows: CounterRow[] = [];
  for (const table of tables) {
    const result = await pool.query<{ key: string; body: CounterRow["body"] }>(
      `SELECT jsonb_build_array(tenant_id,year)::text AS key,to_jsonb(t) AS body FROM ${table} t ORDER BY key`,
    );
    rows.push(...result.rows.map((row) => ({ table, ...row })));
  }
  validateCounters(rows);
  return rows;
}
export async function captureCounterPreservation(pool: Queryable): Promise<CounterBaseline> {
  return {
    counters: await readCounters(pool),
    roots: (await pool.query<RootIdentity>(rootRelation)).rows,
  };
}

export async function checkCounterPreservation(
  pool: Queryable,
  before: CounterBaseline,
  tenantId: string,
): Promise<Map<string, string>> {
  const oldIds = new Set(before.roots.map((root) => root.id));
  assert.equal(oldIds.size, before.roots.length, "Duplicate saved root ID");
  // LEFT JOIN keeps missing originals visible. No tenant filter can hide foreign new roots.
  const roots = (
    await pool.query<NewRootEvidence>(
      `WITH roots AS (${rootRelation}) SELECT r.*,e.id AS event_id,e.tenant_id AS event_tenant_id,e.type AS event_type,e.root_event_id,e.event_number AS original_event_number,e.revision,to_jsonb(e)->>'created_at' AS created_at,e.time_zone FROM roots r LEFT JOIN traceability_events e ON e.id=r.id AND e.tenant_id=r.tenant_id`,
    )
  ).rows;
  const ids = new Set(roots.map((root) => root.id));
  assert.equal(ids.size, roots.length, "Duplicate observed root ID");
  for (const old of before.roots) {
    const current = roots.find((root) => root.id === old.id);
    assert(current, "Missing preexisting root");
    assert.deepEqual(
      {
        kind: current.kind,
        id: current.id,
        tenant_id: current.tenant_id,
        event_number: current.event_number,
      },
      old,
      "Preexisting root identity changed",
    );
  }
  const expected = assertCounterTransition(
    before.counters,
    roots.filter((root) => !oldIds.has(root.id)),
    tenantId,
    await readCounters(pool),
  );
  const digests = new Map<string, string>();
  for (const table of tables) {
    const rows = before.counters
      .filter((row) => row.table === table)
      .map((old) => {
        const next = expected.find((row) => identity(row) === identity(old));
        assert(next, "Missing expected counter PK");
        return { key: old.key, body: next.body };
      });
    digests.set(table, canonicalExportDigest(rows));
  }
  return digests;
}
