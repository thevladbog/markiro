import { describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  ShiftExportSourceError,
  ShiftExportSourceService,
} from "../src/modules/shift-exports/shift-export-source.service";

const SNAPSHOT_STARTED_AT = new Date("2026-08-13T12:34:56.789Z");
/** The GISMT document's `operation_date_time`: when the shift actually closed. */
const SHIFT_CLOSED_AT = new Date("2026-08-13T11:00:00.000Z");
const FLAT = { boxMode: "flat", extension: "txt" } as const;
const BOXES = { boxMode: "boxes", extension: "txt" } as const;
const XML_BOXES = { boxMode: "boxes", extension: "xml" } as const;
const PALLETS = { boxMode: "pallets", extension: "txt" } as const;
const XML_PALLET_BOXES = { boxMode: "pallet_boxes", extension: "xml" } as const;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

interface ShiftRow {
  tenantId: string;
  shiftId: string;
  status: "planned" | "active" | "closed";
  productionDate: string | null;
  plannedDate: string | null;
  productName: string | null;
  numberMonthKey: string;
  numberSeq: number;
  createdFrom: "admin" | "station";
  closedAt: Date | null;
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
  palletId: string | null;
  codeHash: string;
  displacedAt: Date | null;
  removedAt: Date | null;
}

interface PalletRow {
  tenantId: string;
  shiftId: string;
  id: string;
  sscc: string | null;
  closedAt: Date | null;
}

interface Fixture {
  shifts?: ShiftRow[];
  /** The joined `organization` + `org_profiles` row the GISMT XML formats load. */
  organizations?: { id: string; name: string | null; inn: string | null }[];
  registry?: RegistryRow[];
  codeHistory?: CodeHistoryRow[];
  memberships?: BoxMembershipRow[];
  pallets?: PalletRow[];
  snapshotStartedAt?: Date | string;
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
    if (table === schema.organization) return fixture.organizations ?? [];
    if (table === schema.boxItems) return fixture.memberships ?? [];
    if (table === schema.pallets) return fixture.pallets ?? [];
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
    execute: async () => ({
      rows: [{ sourceSnapshotStartedAt: fixture.snapshotStartedAt ?? SNAPSHOT_STARTED_AT }],
    }),
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
    productionDate: null,
    plannedDate: "2026-08-13",
    productName: "Вода газированная",
    numberMonthKey: "AUG26",
    numberSeq: 7,
    createdFrom: "admin",
    closedAt: SHIFT_CLOSED_AT,
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
    palletId: null,
    codeHash,
    displacedAt: null,
    removedAt: null,
    ...overrides,
  };
}

function palletRow(
  id: string,
  sscc: string | null,
  closedAt: Date | null,
  overrides: Partial<PalletRow> = {},
): PalletRow {
  return { tenantId: "tenant-1", shiftId: "shift-1", id, sscc, closedAt, ...overrides };
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

    const snapshot = await new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT);

    expect(snapshot).toEqual({
      sourceSnapshotStartedAt: SNAPSHOT_STARTED_AT,
      productName: "Вода газированная",
      shiftDate: "2026-08-13",
      shiftNumber: "AUG26-007",
      shiftClosedAt: SHIFT_CLOSED_AT,
      // A flat TXT export embeds no participant identity, so neither is loaded.
      organizationInn: null,
      organizationName: null,
      openPalletSuppressedBoxCount: 0,
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

  it("normalizes the raw timestamp string returned by the production Drizzle query", async () => {
    const fake = fakeDb({
      shifts: [closedShift()],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
      snapshotStartedAt: "2026-08-14 16:45:53.789006+03",
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
    ).resolves.toMatchObject({
      sourceSnapshotStartedAt: new Date("2026-08-14T13:45:53.789Z"),
    });
  });

  it("does not reveal a shift belonging to another tenant", async () => {
    const fake = fakeDb({ shifts: [] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
      "SHIFT_NOT_CLOSED",
    );
  });

  it.each([
    ["planned", "SHIFT_NOT_CLOSED"],
    ["active", "SHIFT_NOT_CLOSED"],
  ] as const)("rejects a %s shift", async (status, expectedCode) => {
    const fake = fakeDb({ shifts: [closedShift({ status })] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
      expectedCode,
    );
  });

  it("uses the declared production date instead of the planned date in exports", async () => {
    const fake = fakeDb({
      shifts: [closedShift({ productionDate: "2026-08-20", plannedDate: "2026-08-21" })],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
    ).resolves.toMatchObject({ shiftDate: "2026-08-20" });
  });

  it("falls back to the planned date when a closed shift has no declared production date", async () => {
    const fake = fakeDb({
      shifts: [closedShift({ productionDate: null, plannedDate: "2026-08-21" })],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
    ).resolves.toMatchObject({ shiftDate: "2026-08-21" });
  });

  it("rejects a closed shift without a declared or planned date", async () => {
    const fake = fakeDb({
      shifts: [closedShift({ productionDate: null, plannedDate: null })],
    });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
      "SHIFT_DATE_MISSING",
    );
  });

  it("rejects a closed shift without authoritative codes", async () => {
    const fake = fakeDb({ shifts: [closedShift()] });

    await expectSourceError(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
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
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", FLAT),
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
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", BOXES),
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
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", BOXES),
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
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", BOXES),
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
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", BOXES),
      "BOX_COVERAGE_INCOMPLETE",
    );
  });

  it("loads the organization INN for the GISMT XML format", async () => {
    const fake = fakeDb({
      shifts: [closedShift()],
      organizations: [{ id: "tenant-1", name: "ООО «Пивоварня»", inn: " 9705119097 " }],
      registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
      codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
      memberships: [membership("box-1", "100000000000000001", HASH_A)],
    });

    await expect(
      new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", XML_BOXES),
    ).resolves.toMatchObject({ organizationInn: "9705119097" });
  });

  const incompleteOrganizations: {
    label: string;
    organizations: NonNullable<Fixture["organizations"]>;
    code: ShiftExportSourceError["code"];
  }[] = [
    { label: "no organization row", organizations: [], code: "ORG_INN_MISSING" },
    {
      label: "blank INN",
      organizations: [{ id: "tenant-1", name: "ООО «Пивоварня»", inn: "   " }],
      code: "ORG_INN_MISSING",
    },
    {
      label: "null INN",
      organizations: [{ id: "tenant-1", name: "ООО «Пивоварня»", inn: null }],
      code: "ORG_INN_MISSING",
    },
    {
      // `org_name` is as required by the XSD as `LP_TIN`; a nameless tenant
      // must be told so rather than handed a document the portal rejects.
      label: "blank name",
      organizations: [{ id: "tenant-1", name: "  ", inn: "9705119097" }],
      code: "ORG_NAME_MISSING",
    },
  ];

  it.each(incompleteOrganizations)(
    "rejects the GISMT XML format with $label",
    async ({ organizations, code }) => {
      const fake = fakeDb({
        shifts: [closedShift()],
        organizations,
        registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
        codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
        memberships: [membership("box-1", "100000000000000001", HASH_A)],
      });

      await expectSourceError(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", XML_BOXES),
        code,
      );
    },
  );

  describe("pallets grouping", () => {
    it("groups eligible boxes by pallet_id, ordering pallets by closed_at and loose boxes after them", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [
          registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
          registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
          registryRow(HASH_C, "2026-08-13T10:00:02.000Z"),
        ],
        codeHistory: [
          codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
          codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
          codeRow(HASH_C, "2026-08-13T10:00:02.000Z", "code-c"),
        ],
        // box-late stands on the pallet that closed LATER, but the box
        // itself sorts first by sscc -- the pallet's own closed_at decides
        // group order, not the boxes' sscc.
        memberships: [
          membership("box-early", "100000000000000001", HASH_A, { palletId: "pallet-early" }),
          membership("box-late", "200000000000000002", HASH_B, { palletId: "pallet-late" }),
          membership("box-loose", "300000000000000003", HASH_C),
        ],
        pallets: [
          palletRow("pallet-late", "400000000000000004", new Date("2026-08-13T11:00:00.000Z")),
          palletRow("pallet-early", "500000000000000005", new Date("2026-08-13T10:30:00.000Z")),
        ],
      });

      await expect(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
      ).resolves.toMatchObject({
        source: {
          mode: "pallets",
          pallets: [
            {
              sscc: "500000000000000005",
              boxes: [{ sscc: "100000000000000001", codes: ["code-a"] }],
            },
            {
              sscc: "400000000000000004",
              boxes: [{ sscc: "200000000000000002", codes: ["code-b"] }],
            },
          ],
          looseBoxes: [{ sscc: "300000000000000003", codes: ["code-c"] }],
        },
      });
    });

    it("sorts a pallet's own boxes by SSCC", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [
          registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
          registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
        ],
        codeHistory: [
          codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
          codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
        ],
        memberships: [
          membership("box-z", "900000000000000009", HASH_B, { palletId: "pallet-1" }),
          membership("box-a", "100000000000000001", HASH_A, { palletId: "pallet-1" }),
        ],
        pallets: [palletRow("pallet-1", "500000000000000005", new Date())],
      });

      await expect(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
      ).resolves.toMatchObject({
        source: {
          mode: "pallets",
          pallets: [
            {
              sscc: "500000000000000005",
              boxes: [
                { sscc: "100000000000000001", codes: ["code-a"] },
                { sscc: "900000000000000009", codes: ["code-b"] },
              ],
            },
          ],
        },
      });
    });

    it("breaks a closed_at tie between two pallets by SSCC, regardless of row arrival order", async () => {
      const tiedClosedAt = new Date("2026-08-13T11:00:00.000Z");
      const palletA = palletRow("pallet-a", "100000000000000001", tiedClosedAt);
      const palletZ = palletRow("pallet-z", "900000000000000009", tiedClosedAt);
      const membershipA = membership("box-a", "200000000000000002", HASH_A, {
        palletId: "pallet-a",
      });
      const membershipZ = membership("box-z", "300000000000000003", HASH_B, {
        palletId: "pallet-z",
      });
      const registry = [
        registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
        registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
      ];
      const codeHistory = [
        codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
        codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
      ];
      const expectedPalletOrder = [
        {
          sscc: "100000000000000001",
          boxes: [{ sscc: "200000000000000002", codes: ["code-a"] }],
        },
        {
          sscc: "900000000000000009",
          boxes: [{ sscc: "300000000000000003", codes: ["code-b"] }],
        },
      ];

      // Same logical shift, but the underlying box rows arrive in the
      // OPPOSITE order -- an unordered SQL join can legitimately return
      // either order across runs. Without a tiebreaker, output order would
      // follow arrival order (via `groups`' insertion order surviving a
      // stable sort on a tied key); with the fix, both arrival orders must
      // render the identical, SSCC-ordered result.
      const arrivalOrders = [
        [membershipZ, membershipA],
        [membershipA, membershipZ],
      ];

      for (const memberships of arrivalOrders) {
        const fake = fakeDb({
          shifts: [closedShift()],
          registry,
          codeHistory,
          memberships,
          pallets: [palletZ, palletA],
        });

        await expect(
          new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
        ).resolves.toMatchObject({
          source: { mode: "pallets", pallets: expectedPalletOrder },
        });
      }
    });

    it("counts boxes suppressed by a still-open pallet, but not boxes with no pallet at all", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [
          registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
          registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
          registryRow(HASH_C, "2026-08-13T10:00:02.000Z"),
        ],
        codeHistory: [
          codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
          codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
          codeRow(HASH_C, "2026-08-13T10:00:02.000Z", "code-c"),
        ],
        memberships: [
          membership("box-closed", "100000000000000001", HASH_A, { palletId: "pallet-closed" }),
          membership("box-open-pallet", "200000000000000002", HASH_B, {
            palletId: "pallet-open",
          }),
          membership("box-no-pallet", "300000000000000003", HASH_C),
        ],
        pallets: [
          palletRow("pallet-closed", "500000000000000005", new Date("2026-08-13T11:00:00.000Z")),
          palletRow("pallet-open", null, null),
        ],
      });

      await expect(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
      ).resolves.toMatchObject({
        openPalletSuppressedBoxCount: 1,
        source: {
          mode: "pallets",
          looseBoxes: [
            { sscc: "200000000000000002", codes: ["code-b"] },
            { sscc: "300000000000000003", codes: ["code-c"] },
          ],
        },
      });
    });

    it.each([
      ["a pallet that has not closed yet (no SSCC)", palletRow("pallet-2", null, null)],
      ["a pallet id that no longer resolves", undefined],
      [
        "a pallet id that belongs to another tenant",
        {
          tenantId: "tenant-2",
          shiftId: "shift-1",
          id: "pallet-2",
          sscc: "600000000000000006",
          closedAt: new Date(),
        },
      ],
    ])("treats a box on %s as loose rather than as a pallet group", async (_case, otherPallet) => {
      // A genuine closed pallet (pallet-1) is present too, so the export
      // succeeds; only box-2's own group resolution is under test.
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [
          registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
          registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
        ],
        codeHistory: [
          codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
          codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
        ],
        memberships: [
          membership("box-1", "100000000000000001", HASH_A, { palletId: "pallet-1" }),
          membership("box-2", "200000000000000002", HASH_B, { palletId: "pallet-2" }),
        ],
        pallets: [
          palletRow("pallet-1", "500000000000000005", new Date()),
          ...(otherPallet ? [otherPallet] : []),
        ],
      });

      await expect(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
      ).resolves.toMatchObject({
        source: {
          mode: "pallets",
          pallets: [
            {
              sscc: "500000000000000005",
              boxes: [{ sscc: "100000000000000001", codes: ["code-a"] }],
            },
          ],
          looseBoxes: [{ sscc: "200000000000000002", codes: ["code-b"] }],
        },
      });
    });

    it("rejects a pallets-mode export when every eligible box is loose", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
        codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
        memberships: [membership("box-1", "100000000000000001", HASH_A)],
      });

      await expectSourceError(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
        "SHIFT_HAS_NO_PALLETS",
      );
    });

    it("loads the pallet → boxes formats from the same pallets source, INN included for XML", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        organizations: [{ id: "tenant-1", name: "ООО «Пивоварня»", inn: "9705119097" }],
        registry: [
          registryRow(HASH_A, "2026-08-13T10:00:00.000Z"),
          registryRow(HASH_B, "2026-08-13T10:00:01.000Z"),
        ],
        codeHistory: [
          codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a"),
          codeRow(HASH_B, "2026-08-13T10:00:01.000Z", "code-b"),
        ],
        memberships: [
          membership("box-1", "100000000000000001", HASH_A, { palletId: "pallet-1" }),
          membership("box-loose", "300000000000000003", HASH_B),
        ],
        pallets: [palletRow("pallet-1", "500000000000000005", new Date())],
      });

      await expect(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", XML_PALLET_BOXES),
      ).resolves.toMatchObject({
        organizationInn: "9705119097",
        source: {
          mode: "pallets",
          pallets: [
            {
              sscc: "500000000000000005",
              boxes: [{ sscc: "100000000000000001", codes: ["code-a"] }],
            },
          ],
          looseBoxes: [{ sscc: "300000000000000003", codes: ["code-b"] }],
        },
      });

      const loose = fakeDb({
        shifts: [closedShift()],
        organizations: [{ id: "tenant-1", name: "ООО «Пивоварня»", inn: "9705119097" }],
        registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
        codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
        memberships: [membership("box-1", "100000000000000001", HASH_A)],
      });
      await expectSourceError(
        new ShiftExportSourceService(loose.db).load("tenant-1", "shift-1", XML_PALLET_BOXES),
        "SHIFT_HAS_NO_PALLETS",
      );
    });

    it("still fails closed for incomplete box coverage in pallets mode", async () => {
      const fake = fakeDb({
        shifts: [closedShift()],
        registry: [registryRow(HASH_A, "2026-08-13T10:00:00.000Z")],
        codeHistory: [codeRow(HASH_A, "2026-08-13T10:00:00.000Z", "code-a")],
        memberships: [
          membership("box-1", "100000000000000001", HASH_A, { disassembledAt: new Date() }),
        ],
      });

      await expectSourceError(
        new ShiftExportSourceService(fake.db).load("tenant-1", "shift-1", PALLETS),
        "BOX_COVERAGE_INCOMPLETE",
      );
    });
  });
});
