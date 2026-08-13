import { describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  ShiftExportSourceError,
  ShiftExportSourceService,
} from "../src/modules/shift-exports/shift-export-source.service";

const SNAPSHOT_STARTED_AT = new Date("2026-08-13T12:34:56.789Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

interface ShiftRow {
  tenantId: string;
  shiftId: string;
  status: "planned" | "active" | "closed";
  plannedDate: string | null;
  productName: string | null;
}

interface RegistryRow {
  tenantId: string;
  codeHash: string;
  shiftId: string;
  scannedAt: Date;
}

interface CodeHistoryRow extends RegistryRow {
  canonicalRaw: string;
}

interface BoxMembershipRow {
  tenantId: string;
  shiftId: string;
  boxId: string;
  sscc: string | null;
  closedAt: Date | null;
  disassembledAt: Date | null;
  codeHash: string;
  displacedAt: Date | null;
  removedAt: Date | null;
}

interface Fixture {
  shifts?: ShiftRow[];
  registry?: RegistryRow[];
  codeHistory?: CodeHistoryRow[];
  memberships?: BoxMembershipRow[];
}

interface JoinLog {
  table: unknown;
  condition: unknown;
}

interface QueryLog {
  from: unknown;
  joins: JoinLog[];
  where: unknown[];
}

interface FakeDbResult {
  db: Db;
  transactionOptions: unknown[];
  queries: QueryLog[];
}

interface QueryNode extends PromiseLike<unknown[]> {
  innerJoin(table: unknown, condition: unknown): QueryNode;
  leftJoin(table: unknown, condition: unknown): QueryNode;
  where(condition: unknown): QueryNode;
  orderBy(...columns: unknown[]): QueryNode;
  limit(value: number): QueryNode;
}

function fakeDb(fixture: Fixture): FakeDbResult {
  const transactionOptions: unknown[] = [];
  const queries: QueryLog[] = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.shifts) return fixture.shifts ?? [];
    if (table === schema.boxItems) return fixture.memberships ?? [];
    if (table === schema.codeRegistry) {
      return (fixture.registry ?? []).flatMap((owner) =>
        (fixture.codeHistory ?? [])
          .filter(
            (history) =>
              history.tenantId === owner.tenantId &&
              history.codeHash === owner.codeHash &&
              history.shiftId === owner.shiftId &&
              history.scannedAt.getTime() === owner.scannedAt.getTime(),
          )
          .map((history) => ({
            tenantId: owner.tenantId,
            shiftId: owner.shiftId,
            codeHash: owner.codeHash,
            scannedAt: owner.scannedAt,
            canonicalRaw: history.canonicalRaw,
          })),
      );
    }
    return [];
  };

  const select = () => ({
    from: (table: unknown): QueryNode => {
      const log: QueryLog = { from: table, joins: [], where: [] };
      queries.push(log);
      const rows = Promise.resolve(rowsFor(table));
      const node: QueryNode = {
        innerJoin: (joinTable, condition) => {
          log.joins.push({ table: joinTable, condition });
          return node;
        },
        leftJoin: (joinTable, condition) => {
          log.joins.push({ table: joinTable, condition });
          return node;
        },
        where: (condition) => {
          log.where.push(condition);
          return node;
        },
        orderBy: () => node,
        limit: () => node,
        then: rows.then.bind(rows),
      };
      return node;
    },
  });

  const tx = {
    select,
    execute: async () => ({ rows: [{ sourceSnapshotStartedAt: SNAPSHOT_STARTED_AT }] }),
  };
  const db = {
    transaction: async (
      run: (transaction: typeof tx) => Promise<unknown>,
      options: unknown,
    ): Promise<unknown> => {
      transactionOptions.push(options);
      return run(tx);
    },
  } as unknown as Db;

  return { db, transactionOptions, queries };
}

function closedShift(overrides: Partial<ShiftRow> = {}): ShiftRow {
  return {
    tenantId: "tenant-1",
    shiftId: "shift-1",
    status: "closed",
    plannedDate: "2026-08-13",
    productName: "Вода газированная",
    ...overrides,
  };
}

function registryRow(codeHash: string, scannedAt: string): RegistryRow {
  return {
    tenantId: "tenant-1",
    shiftId: "shift-1",
    codeHash,
    scannedAt: new Date(scannedAt),
  };
}

function codeRow(
  codeHash: string,
  scannedAt: string,
  canonicalRaw: string,
  overrides: Partial<CodeHistoryRow> = {},
): CodeHistoryRow {
  return { ...registryRow(codeHash, scannedAt), canonicalRaw, ...overrides };
}

function membership(
  boxId: string,
  sscc: string | null,
  codeHash: string,
  overrides: Partial<BoxMembershipRow> = {},
): BoxMembershipRow {
  return {
    tenantId: "tenant-1",
    shiftId: "shift-1",
    boxId,
    sscc,
    closedAt: new Date("2026-08-13T12:00:00.000Z"),
    disassembledAt: null,
    codeHash,
    displacedAt: null,
    removedAt: null,
    ...overrides,
  };
}

function sqlText(fragment: unknown): string {
  const wrapper = fragment as { getSQL(): SQL };
  return new PgDialect().sqlToQuery(wrapper.getSQL()).sql;
}

async function expectSourceError(
  promise: Promise<unknown>,
  code: ShiftExportSourceError["code"],
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ShiftExportSourceError);
  expect(error).toMatchObject({ code });
}

describe("ShiftExportSourceService", () => {
  it("loads the tenant-scoped authoritative duplicate winner in deterministic flat order", async () => {
    const first = registryRow(HASH_A, "2026-08-13T10:00:00.000Z");
    const second = registryRow(HASH_B, "2026-08-13T10:00:00.000Z");
    const third = registryRow(HASH_C, "2026-08-13T10:00:01.000Z");
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [third, second, first, { ...first, tenantId: "tenant-2" }],
      codeHistory: [
        codeRow(HASH_A, "2026-08-13T10:05:00.000Z", "losing-later-history"),
        codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
        codeRow(HASH_B, "2026-08-13T10:00:00.000Z", "code-b"),
        codeRow(HASH_C, "2026-08-13T10:00:01.000Z", "code-c"),
        codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "other-tenant-code", {
          tenantId: "tenant-2",
        }),
      ],
    });

    const snapshot = await new ShiftExportSourceService(fake.db).load(
      "tenant-1",
      "shift-1",
      "flat",
    );

    expect(snapshot).toEqual({
      sourceSnapshotStartedAt: SNAPSHOT_STARTED_AT,
      productName: "Вода газированная",
      shiftDate: "2026-08-13",
      source: { mode: "flat", codes: ["code-a", "code-b", "code-c"] },
    });
    expect(fake.transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);

    const shiftQuery = fake.queries.find((query) => query.from === schema.shifts);
    expect(shiftQuery).toBeDefined();
    expect(sqlText(shiftQuery!.where[0])).toContain(
      '"shifts"."tenant_id" = $1 and "shifts"."id" = $2',
    );

    const codeQuery = fake.queries.find((query) => query.from === schema.codeRegistry);
    const historyJoin = codeQuery?.joins.find((join) => join.table === schema.codes);
    expect(historyJoin).toBeDefined();
    expect(sqlText(historyJoin!.condition)).toBe(
      '("code_registry"."tenant_id" = "codes"."tenant_id" and "code_registry"."code_hash" = "codes"."code_hash" and "code_registry"."shift_id" = "codes"."shift_id" and "code_registry"."scanned_at" = "codes"."scanned_at")',
    );
  });

  it("does not reveal a shift belonging to another tenant", async () => {
    const fake = fakeDb({ shifts: [] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "flat"),
      "SHIFT_NOT_CLOSED",
    );
  });

  it.each([
    ["planned", "SHIFT_NOT_CLOSED"],
    ["active", "SHIFT_NOT_CLOSED"],
  ] as const)("rejects a %s shift", async (status, expectedCode) => {
    const fake = fakeDb({ shifts: [closedShift({ status })] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "flat"),
      expectedCode,
    );
  });

  it("rejects a closed shift without a planned date", async () => {
    const fake = fakeDb({ shifts: [closedShift({ plannedDate: null })] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "flat"),
      "SHIFT_DATE_MISSING",
    );
  });

  it("rejects a closed shift without authoritative codes", async () => {
    const fake = fakeDb({ shifts: [closedShift()] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "flat"),
      "SHIFT_HAS_NO_CODES",
    );
  });

  it("uses the safe product fallback", async () => {
    const fake = fakeDb({
      shifts: [closedShift({ productName: null })],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "flat"),
    ).resolves.toMatchObject({ productName: "Продукция" });
  });

  it("orders boxes by SSCC and their canonical items by authoritative scan time then hash", async () => {
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [
        registryRow(HASH_C, "2026-08-13T10:00:02.000Z"),
        registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
        registryRow(HASH_B, "2026-08-13T10:00:00.000Z"),
      ],
      codeHistory: [
        codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
        codeRow(HASH_B, "2026-08-13T10:00:00.000Z", "code-b"),
        codeRow(HASH_C, "2026-08-13T10:00:02.000Z", "code-c"),
      ],
      memberships: [
        membership("box-z", "200000000000000002", HASH_C),
        membership("box-a", "100000000000000001", HASH_B),
        membership("box-a", "100000000000000001", HASH_A),
      ],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "boxes"),
    ).resolves.toMatchObject({
      source: {
        mode: "boxes",
        boxes: [
          { sscc: "100000000000000001", codes: ["code-a", "code-b"] },
          { sscc: "200000000000000002", codes: ["code-c"] },
        ],
      },
    });
  });

  it("ignores historical excluded memberships when current eligible coverage is exact", async () => {
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
      memberships: [
        membership("old-box", "100000000000000001", HASH_A, {
          displacedAt: new Date("2026-08-13T10:01:00.000Z"),
        }),
        membership("current-box", "200000000000000002", HASH_A),
      ],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "boxes"),
    ).resolves.toMatchObject({
      source: {
        mode: "boxes",
        boxes: [{ sscc: "200000000000000002", codes: ["code-a"] }],
      },
    });
  });

  it.each([
    ["removed item", membership("box-1", "100000000000000001", HASH_A, { removedAt: new Date() })],
    [
      "displaced item",
      membership("box-1", "100000000000000001", HASH_A, { displacedAt: new Date() }),
    ],
    [
      "disassembled box",
      membership("box-1", "100000000000000001", HASH_A, { disassembledAt: new Date() }),
    ],
    ["open box", membership("box-1", "100000000000000001", HASH_A, { closedAt: null })],
    ["box without SSCC", membership("box-1", null, HASH_A)],
  ])("fails closed for an authoritative code in a %s", async (_case, row) => {
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
      memberships: [row],
    });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "boxes"),
      "BOX_COVERAGE_INCOMPLETE",
    );
  });

  it.each([
    ["missing membership", []],
    [
      "extra membership",
      [
        membership("box-1", "100000000000000001", HASH_A),
        membership("box-1", "100000000000000001", HASH_B),
      ],
    ],
    [
      "duplicate membership",
      [
        membership("box-1", "100000000000000001", HASH_A),
        membership("box-2", "200000000000000002", HASH_A),
      ],
    ],
  ])("fails closed for %s", async (_case, memberships) => {
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
      memberships,
    });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", "boxes"),
      "BOX_COVERAGE_INCOMPLETE",
    );
  });
});
