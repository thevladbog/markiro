import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import { buildSscc, INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const GTIN = "04680089900383";
const SOURCE = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"), "utf8");
const [INTRODUCED_FILTER = "", HEADER = ""] = SOURCE.split(/\r?\n/);
if (INTRODUCED_FILTER.length === 0 || HEADER.length === 0) {
  throw new Error("Expected inventory CSV fixture header");
}

type Agent = ReturnType<typeof request.agent>;
type ImportSelection = Record<InventoryChzStatus, string>;

interface SourceRow {
  serial: string;
  state?: string;
  productionDate?: string;
  parentSscc?: string;
  gtin?: string;
  km?: string;
}

interface SnapshotBody {
  id: string;
  inventoryId: string;
  revision: number;
  combinedDigest: string;
  fixedAt: string;
  inputs: ImportSelection;
  counts: {
    emitted: number;
    introduced: number;
    applied: number;
    retired: number;
    writtenOff: number;
    disaggregation: number;
    protected: number;
    expected: number;
    packages: number;
    loose: number;
  };
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function filterLine(status: InventoryChzStatus, gtin = GTIN): string {
  return INTRODUCED_FILTER.replace("INTRODUCED", status).replaceAll(GTIN, gtin);
}

function sourceRow(status: InventoryChzStatus, row: SourceRow): string {
  const cells = Array.from({ length: 35 }, () => "");
  const gtin = row.gtin ?? GTIN;
  cells[0] = row.km ?? `01${gtin}21${row.serial}`;
  cells[1] = gtin;
  cells[5] = row.parentSscc ?? "";
  cells[15] = status;
  cells[16] = row.state ?? "";
  cells[19] = "UNIT";
  cells[27] = row.productionDate ?? "";
  return cells.map(csvCell).join(",");
}

function exportBytes(
  status: InventoryChzStatus,
  rows: readonly SourceRow[] = [],
  options: { gtin?: string; emptyMarker?: string } = {},
): Buffer {
  const lines = [filterLine(status, options.gtin), HEADER];
  if (rows.length === 0) {
    lines.push("errors", options.emptyMarker ?? "5: Коды маркировки не найдены");
  } else {
    lines.push(...rows.map((row) => sourceRow(status, row)));
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

function selectionBody(imports: ImportSelection) {
  return { imports };
}

describe.skipIf(!ready)("inventory immutable snapshot fixation e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  const objects = new Map<string, Buffer>();
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    putVerified: vi.fn(async (key: string, body: Buffer, _contentType: string, sha256: string) => {
      objects.set(key, Buffer.from(body));
      return { byteSize: body.byteLength, sha256 };
    }),
    get: vi.fn(async (key: string, options?: { maxBytes?: number }) => {
      const body = objects.get(key);
      if (body === undefined) {
        throw Object.assign(new Error("missing synthetic object"), { name: "NoSuchKey" });
      }
      const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
      if (body.byteLength > maxBytes) throw new Error("synthetic private-read limit exceeded");
      return { body: Buffer.from(body), contentType: "text/csv" };
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    objects.clear();
    vi.clearAllMocks();
  });

  async function seedPreparation(agent: Agent) {
    const tenantId = await signUpAndActivate(agent);
    return { tenantId, ...(await seedInventory(agent, tenantId)) };
  }

  async function seedInventory(
    agent: Agent,
    tenantId: string,
    existing?: { productId: string; lineId: string },
  ) {
    const productId = existing?.productId ?? randomUUID();
    const lineId = existing?.lineId ?? randomUUID();
    if (existing === undefined) {
      await db.insert(schema.products).values({
        id: productId,
        tenantId,
        gtin14: GTIN,
        name: "Snapshot Water",
        status: "active",
      });
      await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Snapshot line" });
    }
    const created = await agent
      .post("/inventories")
      .send({
        productId,
        lineId,
        mode: "check",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
      })
      .expect(201);
    return { inventoryId: created.body.id as string, productId, lineId };
  }

  async function uploadImport(
    agent: Agent,
    inventoryId: string,
    status: InventoryChzStatus,
    bytes: Buffer,
    expectedStatus = 201,
  ): Promise<string> {
    const response = await agent
      .post(`/inventories/${inventoryId}/imports/${status}`)
      .attach("file", bytes, { filename: `${status.toLowerCase()}.csv`, contentType: "text/csv" })
      .expect(expectedStatus);
    return response.body.id as string;
  }

  async function uploadSelection(
    agent: Agent,
    inventoryId: string,
    rows: Partial<Record<InventoryChzStatus, readonly SourceRow[]>> = {},
  ): Promise<ImportSelection> {
    const entries = await Promise.all(
      INVENTORY_CHZ_STATUSES.map(async (status) => {
        const id = await uploadImport(
          agent,
          inventoryId,
          status,
          exportBytes(status, rows[status]),
        );
        return [status, id] as const;
      }),
    );
    return Object.fromEntries(entries) as ImportSelection;
  }

  async function importRow(importId: string) {
    const [row] = await db
      .select()
      .from(schema.inventoryImports)
      .where(eq(schema.inventoryImports.id, importId))
      .limit(1);
    if (!row) throw new Error("Expected inventory import fixture");
    return row;
  }

  async function actorUserId(tenantId: string): Promise<string> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory actor fixture");
    return member.userId;
  }

  it("materializes six selected inputs, canonical rows, inclusive counts, parent membership, and a durable sanitized audit", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedPreparation(agent);
    const parentA = buildSscc(0, "4600682", 1);
    const parentB = buildSscc(0, "4600682", 2);
    const imports = await uploadSelection(agent, inventoryId, {
      EMITTED: [{ serial: "EMITTED-001" }],
      INTRODUCED: [
        { serial: "PROTECTED-001", state: "MOVING_BY_UD", parentSscc: parentA },
        { serial: "FROM-001", productionDate: "2026-08-01", parentSscc: parentA },
        { serial: "TO-001", productionDate: "2026-08-31", parentSscc: parentB },
        { serial: "OUTSIDE-001", productionDate: "2026-07-31" },
      ],
    });

    const response = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(201);
    const snapshot = response.body as SnapshotBody;

    expect(snapshot).toEqual({
      id: expect.any(String),
      inventoryId,
      revision: 1,
      combinedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      fixedAt: expect.any(String),
      inputs: imports,
      counts: {
        emitted: 1,
        introduced: 4,
        applied: 0,
        retired: 0,
        writtenOff: 0,
        disaggregation: 0,
        protected: 1,
        expected: 2,
        packages: 2,
        loose: 2,
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/objectKey|fileName|canonicalRaw|SYNTHETIC/i);
    expect(storage.get).toHaveBeenCalledTimes(6);
    expect(
      storage.get.mock.calls.every(([, options]) => options?.maxBytes === 8 * 1024 * 1024),
    ).toBe(true);

    const [storedSnapshot] = await db
      .select()
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.id, snapshot.id),
        ),
      );
    expect(storedSnapshot).toMatchObject({
      inventoryId,
      combinedDigest: snapshot.combinedDigest,
      emittedCount: 1,
      introducedCount: 4,
      protectedCount: 1,
      expectedCount: 2,
      packageCount: 2,
      looseCount: 2,
    });
    const links = await db
      .select({
        status: schema.inventorySnapshotInputs.status,
        importId: schema.inventorySnapshotInputs.importId,
      })
      .from(schema.inventorySnapshotInputs)
      .where(eq(schema.inventorySnapshotInputs.snapshotId, snapshot.id));
    expect(Object.fromEntries(links.map((link) => [link.status, link.importId]))).toEqual(imports);

    const rows = await db
      .select({
        canonicalRaw: schema.inventorySnapshotCodes.canonicalRaw,
        sourceStatus: schema.inventorySnapshotCodes.sourceStatus,
        sourceState: schema.inventorySnapshotCodes.sourceState,
        sourceProductionDate: schema.inventorySnapshotCodes.sourceProductionDate,
        parentSscc: schema.inventorySnapshotCodes.parentSscc,
        expected: schema.inventorySnapshotCodes.expected,
        protected: schema.inventorySnapshotCodes.protected,
      })
      .from(schema.inventorySnapshotCodes)
      .where(eq(schema.inventorySnapshotCodes.snapshotId, snapshot.id));
    expect(rows).toHaveLength(5);
    expect(rows).toContainEqual({
      canonicalRaw: `01${GTIN}21PROTECTED-001`,
      sourceStatus: "INTRODUCED",
      sourceState: "MOVING_BY_UD",
      sourceProductionDate: null,
      parentSscc: parentA,
      expected: false,
      protected: true,
    });
    expect(
      rows
        .filter((row) => row.expected)
        .map((row) => row.sourceProductionDate)
        .sort(),
    ).toEqual(["2026-08-01", "2026-08-31"]);

    const [inventory] = await db
      .select({
        status: schema.inventories.status,
        activeSnapshotId: schema.inventories.activeSnapshotId,
      })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(inventory).toEqual({ status: "ready", activeSnapshotId: snapshot.id });

    const [audit] = await db
      .select({
        organizationId: schema.tenantAuditEvents.organizationId,
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.snapshot.fixed"),
          eq(schema.tenantAuditEvents.targetId, inventoryId),
        ),
      );
    const actorId = await actorUserId(tenantId);
    expect(audit).toEqual({
      organizationId: tenantId,
      actorUserId: actorId,
      action: "inventory.snapshot.fixed",
      outcome: "success",
      targetType: "inventory",
      targetId: inventoryId,
      after: {
        tenantId,
        actorUserId: actorId,
        inventoryId,
        snapshotId: snapshot.id,
        combinedDigest: snapshot.combinedDigest,
        inputs: imports,
        counts: snapshot.counts,
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /objectKey|fileName|canonicalRaw|21PROTECTED|credential/i,
    );
  });

  it("rejects missing, extra, and duplicate status slots before fixation", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const imports = await uploadSelection(agent, inventoryId);
    const missing = Object.fromEntries(
      Object.entries(imports).filter(([status]) => status !== "DISAGGREGATION"),
    );

    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send({ imports: missing })
      .expect(400);
    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send({ imports: { ...imports, UNKNOWN: randomUUID() } })
      .expect(400);
    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send({ imports: { ...imports, APPLIED: imports.EMITTED } })
      .expect(400);
  });

  it("permits selecting an older successful import after a newer failed attempt", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const imports = await uploadSelection(agent, inventoryId);
    const failedId = await uploadImport(
      agent,
      inventoryId,
      "INTRODUCED",
      exportBytes("EMITTED"),
      422,
    );

    const response = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(201);
    expect(response.body.inputs.INTRODUCED).toBe(imports.INTRODUCED);
    expect(response.body.inputs.INTRODUCED).not.toBe(failedId);
  });

  it("rejects failed, wrong-status, and wrong-inventory selected imports", async () => {
    const agent = request.agent(app!.getHttpServer());
    const first = await seedPreparation(agent);
    const imports = await uploadSelection(agent, first.inventoryId);
    const failedId = await uploadImport(
      agent,
      first.inventoryId,
      "INTRODUCED",
      exportBytes("EMITTED"),
      422,
    );
    await agent
      .post(`/inventories/${first.inventoryId}/snapshots`)
      .send(selectionBody({ ...imports, INTRODUCED: failedId }))
      .expect(422, { code: "INVENTORY_SNAPSHOT_IMPORT_INVALID" });
    await agent
      .post(`/inventories/${first.inventoryId}/snapshots`)
      .send(
        selectionBody({
          ...imports,
          EMITTED: imports.APPLIED,
          APPLIED: imports.EMITTED,
        }),
      )
      .expect(422, { code: "INVENTORY_SNAPSHOT_IMPORT_INVALID" });

    const second = await seedInventory(agent, first.tenantId, {
      productId: first.productId,
      lineId: first.lineId,
    });
    const secondImports = await uploadSelection(agent, second.inventoryId);
    await agent
      .post(`/inventories/${first.inventoryId}/snapshots`)
      .send(selectionBody({ ...imports, RETIRED: secondImports.RETIRED }))
      .expect(422, { code: "INVENTORY_SNAPSHOT_IMPORT_INVALID" });
  });

  it("denies cross-tenant fixation and rejects malformed inventory ids before storage reads", async () => {
    const owner = request.agent(app!.getHttpServer());
    const owned = await seedPreparation(owner);
    const imports = await uploadSelection(owner, owned.inventoryId);
    const other = request.agent(app!.getHttpServer());
    await seedPreparation(other);

    await other
      .post(`/inventories/${owned.inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(404);
    await other.post("/inventories/not-a-uuid/snapshots").send(selectionBody(imports)).expect(400);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("rejects duplicates within one selected import without deleting source evidence", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedPreparation(agent);
    const duplicate = { serial: "DUPLICATE-001", productionDate: "2026-08-10" };
    const imports = await uploadSelection(agent, inventoryId, {
      INTRODUCED: [duplicate, duplicate],
    });
    const objectKeys = [...objects.keys()].sort();

    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(422, { code: "INVENTORY_SNAPSHOT_DUPLICATE_CODE" });
    expect([...objects.keys()].sort()).toEqual(objectKeys);
    const snapshots = await db
      .select({ id: schema.inventorySnapshots.id })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
        ),
      );
    expect(snapshots).toEqual([]);
  });

  it("rejects one canonical code selected across two statuses", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const same = { serial: "CROSS-STATUS-001" };
    const imports = await uploadSelection(agent, inventoryId, {
      EMITTED: [same],
      RETIRED: [same],
    });

    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(422, { code: "INVENTORY_SNAPSHOT_DUPLICATE_CODE" });
  });

  it("rejects an unprotected INTRODUCED code with no production date", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const imports = await uploadSelection(agent, inventoryId, {
      INTRODUCED: [{ serial: "MISSING-DATE-001" }],
    });

    await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(422, { code: "INVENTORY_SNAPSHOT_PRODUCTION_DATE_REQUIRED" });
  });

  it("preserves 48 distinct parent memberships across 288 expected members", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const rows = Array.from({ length: 48 }, (_, parentIndex) => {
      const parentSscc = buildSscc(0, "4600682", parentIndex + 1);
      return Array.from({ length: 6 }, (_, memberIndex) => ({
        serial: `P${String(parentIndex + 1).padStart(2, "0")}-M${memberIndex + 1}`,
        productionDate: "2026-08-15",
        parentSscc,
      }));
    }).flat();
    const imports = await uploadSelection(agent, inventoryId, { INTRODUCED: rows });

    const response = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(201);
    expect(response.body.counts).toMatchObject({
      introduced: 288,
      expected: 288,
      packages: 48,
      loose: 0,
    });
    const membership = await db.execute(sql`
      select count(*)::integer as members,
             count(distinct parent_sscc)::integer as parents
      from inventory_snapshot_codes
      where snapshot_id = ${response.body.id as string}
    `);
    expect(membership.rows).toEqual([{ members: 288, parents: 48 }]);
  });

  it("rejects missing objects, changed bytes, and changed stored parse facts with sanitized failure audits", async () => {
    const cases = ["missing", "digest", "facts"] as const;
    for (const failure of cases) {
      const agent = request.agent(app!.getHttpServer());
      const { tenantId, inventoryId } = await seedPreparation(agent);
      const imports = await uploadSelection(agent, inventoryId);
      const introduced = await importRow(imports.INTRODUCED);
      if (failure === "missing") objects.delete(introduced.objectKey);
      if (failure === "digest") {
        const changed = Buffer.from(objects.get(introduced.objectKey)!);
        changed[0] = changed[0] === 0x22 ? 0x23 : 0x22;
        objects.set(introduced.objectKey, changed);
      }
      if (failure === "facts") {
        await db
          .update(schema.inventoryImports)
          .set({ rowCount: introduced.rowCount + 1 })
          .where(
            and(
              eq(schema.inventoryImports.tenantId, tenantId),
              eq(schema.inventoryImports.id, introduced.id),
            ),
          );
      }

      const expectedCode =
        failure === "missing"
          ? "INVENTORY_SNAPSHOT_OBJECT_UNAVAILABLE"
          : "INVENTORY_SNAPSHOT_EVIDENCE_MISMATCH";
      const response = await agent
        .post(`/inventories/${inventoryId}/snapshots`)
        .send(selectionBody(imports))
        .expect(422, { code: expectedCode });
      expect(JSON.stringify(response.body)).not.toMatch(/objectKey|fileName|tenants\/|Код/i);
      const [audit] = await db
        .select({
          outcome: schema.tenantAuditEvents.outcome,
          after: schema.tenantAuditEvents.after,
        })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            eq(schema.tenantAuditEvents.action, "inventory.snapshot.fixed"),
            eq(schema.tenantAuditEvents.targetId, inventoryId),
          ),
        )
        .orderBy(sql`${schema.tenantAuditEvents.createdAt} desc`)
        .limit(1);
      const actorId = await actorUserId(tenantId);
      expect(audit).toEqual({
        outcome: "failure",
        after: {
          tenantId,
          actorUserId: actorId,
          inventoryId,
          inputs: imports,
          errorCode: expectedCode,
        },
      });
      expect(JSON.stringify(audit)).not.toMatch(
        /objectKey|fileName|tenants\/|canonicalRaw|credential/i,
      );
    }
  });

  it("re-runs the parser and rejects wrong GTIN, KM, parent, and impossible-date originals", async () => {
    const cases: Array<{ label: string; row: SourceRow }> = [
      { label: "gtin", row: { serial: "WRONG-GTIN", gtin: "04680089900390" } },
      { label: "km", row: { serial: "IGNORED", km: "not-a-km" } },
      { label: "parent", row: { serial: "WRONG-PARENT", parentSscc: "123" } },
      { label: "date", row: { serial: "WRONG-DATE", productionDate: "2026-02-31" } },
    ];
    for (const testCase of cases) {
      const agent = request.agent(app!.getHttpServer());
      const { tenantId, inventoryId } = await seedPreparation(agent);
      const imports = await uploadSelection(agent, inventoryId);
      const introduced = await importRow(imports.INTRODUCED);
      const changed = exportBytes("INTRODUCED", [testCase.row], {
        gtin: testCase.label === "gtin" ? "04680089900390" : GTIN,
      });
      const digest = createHash("sha256").update(changed).digest("hex");
      const changedObjectKey = `tenants/${tenantId}/inventories/${inventoryId}/imports/INTRODUCED/${digest}.csv`;
      objects.delete(introduced.objectKey);
      objects.set(changedObjectKey, changed);
      await db
        .update(schema.inventoryImports)
        .set({
          byteSize: changed.byteLength,
          sha256: digest,
          objectKey: changedObjectKey,
          rowCount: 1,
        })
        .where(
          and(
            eq(schema.inventoryImports.tenantId, tenantId),
            eq(schema.inventoryImports.id, introduced.id),
          ),
        );

      await agent
        .post(`/inventories/${inventoryId}/snapshots`)
        .send(selectionBody(imports))
        .expect(422, { code: "INVENTORY_SNAPSHOT_SOURCE_INVALID" });
    }
  });

  it("returns one snapshot for concurrent identical selections and conflicts on a different set", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedPreparation(agent);
    const imports = await uploadSelection(agent, inventoryId);
    const [first, second] = await Promise.all([
      agent.post(`/inventories/${inventoryId}/snapshots`).send(selectionBody(imports)),
      agent.post(`/inventories/${inventoryId}/snapshots`).send(selectionBody(imports)),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.id).toBe(second.body.id);
    const stored = await db
      .select({ id: schema.inventorySnapshots.id })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
        ),
      );
    expect(stored).toEqual([{ id: first.body.id }]);

    const otherAgent = request.agent(app!.getHttpServer());
    const other = await seedPreparation(otherAgent);
    const selectionA = await uploadSelection(otherAgent, other.inventoryId);
    const alternativeApplied = await uploadImport(
      otherAgent,
      other.inventoryId,
      "APPLIED",
      exportBytes("APPLIED", [], {
        emptyMarker: "5: Коды маркировки по критериям отбора не найдены",
      }),
    );
    const selectionB = { ...selectionA, APPLIED: alternativeApplied };
    const raced = await Promise.all([
      otherAgent
        .post(`/inventories/${other.inventoryId}/snapshots`)
        .send(selectionBody(selectionA)),
      otherAgent
        .post(`/inventories/${other.inventoryId}/snapshots`)
        .send(selectionBody(selectionB)),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(raced.find((response) => response.status === 409)?.body).toEqual({
      code: "INVENTORY_SNAPSHOT_ALREADY_FIXED",
    });
  });

  it("keeps the active snapshot immutable when a later upload is attempted", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedPreparation(agent);
    const imports = await uploadSelection(agent, inventoryId);
    const fixed = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(201);

    await uploadImport(
      agent,
      inventoryId,
      "APPLIED",
      exportBytes("APPLIED", [], {
        emptyMarker: "5: Коды маркировки по критериям отбора не найдены",
      }),
      409,
    );
    const repeated = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send(selectionBody(imports))
      .expect(201);
    expect(repeated.body).toEqual(fixed.body);
  });

  it("rolls back all chunks and the active pointer when a later code insert fails", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedPreparation(agent);
    const rows = Array.from({ length: 260 }, (_, index) => ({
      serial: `CHUNK-${String(index + 1).padStart(4, "0")}`,
      productionDate: "2026-08-15",
    }));
    const imports = await uploadSelection(agent, inventoryId, { INTRODUCED: rows });
    const [sourceObjectKey] = objects.keys();
    expect(sourceObjectKey).toBeDefined();
    await db.execute(
      sql.raw(`
      create or replace function inventory_snapshot_chunk_failure() returns trigger
      language plpgsql as $$
      begin
        if new.serial = 'CHUNK-0251' then
          raise exception 'injected snapshot chunk failure';
        end if;
        return new;
      end;
      $$;
      create trigger inventory_snapshot_chunk_failure_trigger
      before insert on inventory_snapshot_codes
      for each row execute function inventory_snapshot_chunk_failure();
    `),
    );
    const errorLogger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    let failedResponse: request.Response | undefined;
    try {
      failedResponse = await agent
        .post(`/inventories/${inventoryId}/snapshots`)
        .send(selectionBody(imports))
        .expect(500);
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists inventory_snapshot_chunk_failure_trigger on inventory_snapshot_codes;
        drop function if exists inventory_snapshot_chunk_failure();
      `),
      );
    }
    const loggedErrors = errorLogger.mock.calls
      .flat()
      .map((value) =>
        value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : JSON.stringify(value),
      )
      .join("\n");
    errorLogger.mockRestore();
    expect(failedResponse?.body).toEqual({ code: "INVENTORY_SNAPSHOT_FIXATION_FAILED" });
    expect(`${JSON.stringify(failedResponse?.body)}\n${loggedErrors}`).not.toMatch(
      new RegExp(`CHUNK-0251|params:|${sourceObjectKey ?? "object-key-missing"}`, "i"),
    );

    const snapshots = await db
      .select({ id: schema.inventorySnapshots.id })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
        ),
      );
    const [inventory] = await db
      .select({
        status: schema.inventories.status,
        activeSnapshotId: schema.inventories.activeSnapshotId,
      })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(snapshots).toEqual([]);
    expect(inventory).toEqual({ status: "preparing", activeSnapshotId: null });
    expect(objects.size).toBe(6);
    const [audit] = await db
      .select({ outcome: schema.tenantAuditEvents.outcome, after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.snapshot.fixed"),
          eq(schema.tenantAuditEvents.targetId, inventoryId),
        ),
      );
    expect(audit).toEqual({
      outcome: "failure",
      after: {
        tenantId,
        actorUserId: await actorUserId(tenantId),
        inventoryId,
        inputs: imports,
        errorCode: "INVENTORY_SNAPSHOT_FIXATION_FAILED",
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/canonicalRaw|CHUNK-0251|objectKey|fileName/i);
  });
});
