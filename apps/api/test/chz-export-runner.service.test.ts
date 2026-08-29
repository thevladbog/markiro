import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

import { ChzExportRunnerService } from "../src/modules/chz-exports/chz-export-runner.service";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import type { TrueApiClient } from "../src/modules/chz-exports/true-api.client";
import type {
  DispenserResult,
  DispenserTaskSummary,
} from "../src/modules/chz-exports/true-api.types";
import type { JournalService } from "../src/modules/integrations/journal.service";
import type { InventoriesService } from "../src/modules/inventories/inventories.service";
import type { InventoryImportDto } from "../src/modules/inventories/dto";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);
const GTIN = "04600000000015";
const TEST_TOKEN = "eyJhbGciOiJub25lIn0.super-secret-true-api-token";
const PRODUCT_GROUP_CODE = 8;
const STALE_CLAIM = 600_000;

interface FakeCall {
  op: "createDispenserTask" | "listDispenserTasks" | "listDispenserResults" | "download";
  chzStatus?: string;
  taskIds?: string[];
  resultId?: string;
  productGroupCode?: number;
}

interface FakeClientConfig {
  createTaskId?: (status: InventoryChzStatus) => string;
  existingTasks?: DispenserTaskSummary[];
  results?: DispenserResult[];
  file?: Uint8Array;
  rejectStatus?: InventoryChzStatus;
  rejection?: { code: string; message: string };
  /** `createDispenserTask` returns `unavailable` for this status instead of creating a task. */
  unavailableStatus?: InventoryChzStatus;
  /** `createDispenserTask` returns `unauthorized` for this status instead of creating a task. */
  unauthorizedStatus?: InventoryChzStatus;
  /** `listDispenserResults` returns this status instead of `ok` with `results`. */
  resultsStatus?: "rejected" | "unavailable";
}

interface FakeClient {
  client: TrueApiClient;
  calls: FakeCall[];
}

/**
 * The real client is covered by its own suite; what needs testing here is the
 * state machine, so the transport is a fake that records every call.
 */
function fakeClient(config: FakeClientConfig = {}): FakeClient {
  const calls: FakeCall[] = [];
  const client = {
    createDispenserTask: vi.fn(
      async (_auth: unknown, input: { chzStatus: string; productGroupCode: number }) => {
        calls.push({
          op: "createDispenserTask",
          chzStatus: input.chzStatus,
          productGroupCode: input.productGroupCode,
        });
        if (config.rejectStatus !== undefined && input.chzStatus === config.rejectStatus) {
          return {
            status: "rejected" as const,
            code: config.rejection?.code ?? "400",
            message: config.rejection?.message ?? "",
          };
        }
        if (
          config.unavailableStatus !== undefined &&
          input.chzStatus === config.unavailableStatus
        ) {
          return { status: "unavailable" as const };
        }
        if (
          config.unauthorizedStatus !== undefined &&
          input.chzStatus === config.unauthorizedStatus
        ) {
          return { status: "unauthorized" as const };
        }
        const taskId = (config.createTaskId ?? ((status: string) => `task-${status}`))(
          input.chzStatus as InventoryChzStatus,
        );
        return { status: "ok" as const, value: { taskId } };
      },
    ),
    listDispenserTasks: vi.fn(async (_auth: unknown, productGroupCode: number) => {
      calls.push({ op: "listDispenserTasks", productGroupCode });
      return { status: "ok" as const, value: config.existingTasks ?? [] };
    }),
    listDispenserResults: vi.fn(async (_auth: unknown, taskIds: string[]) => {
      calls.push({ op: "listDispenserResults", taskIds: [...taskIds] });
      if (config.resultsStatus === "rejected") {
        return { status: "rejected" as const, code: "400", message: "" };
      }
      if (config.resultsStatus === "unavailable") {
        return { status: "unavailable" as const };
      }
      return { status: "ok" as const, value: config.results ?? [] };
    }),
    downloadDispenserResult: vi.fn(async (_auth: unknown, resultId: string) => {
      calls.push({ op: "download", resultId });
      return { status: "ok" as const, value: config.file ?? new Uint8Array([0x50, 0x4b]) };
    }),
  };
  return { client: client as unknown as TrueApiClient, calls };
}

describe.skipIf(!ready)("ChzExportRunnerService", () => {
  const databaseName = `markiro_chz_export_runner_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;

  let tenantId: string;
  let orderedByUserId: string;
  let productId: string;
  let inventoryId: string;

  let tokens: { getActiveToken: ReturnType<typeof vi.fn> };
  let journal: { append: ReturnType<typeof vi.fn> };
  let importEvidence: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = await createOrganization(db);
    orderedByUserId = randomUUID();
    productId = randomUUID();
    inventoryId = randomUUID();
    const lineId = randomUUID();

    await db.insert(schema.user).values({
      id: orderedByUserId,
      name: "Runner fixture operator",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.orgProfiles).values({ tenantId, inn: "7707083893" });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Runner fixture product",
      chzProductGroupCode: PRODUCT_GROUP_CODE,
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Runner fixture line" });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: orderedByUserId,
    });

    tokens = {
      getActiveToken: vi.fn().mockResolvedValue({
        status: "ok",
        auth: { baseUrl: "https://true-api.invalid", token: TEST_TOKEN },
      }),
    };
    journal = { append: vi.fn().mockResolvedValue(undefined) };
    // The real import writes an `inventory_imports` row, and `chz_export_runs`
    // has a foreign key to it, so the fake writes one too -- an `importId` that
    // does not exist would be rejected by the database, not by an assertion.
    importEvidence = vi.fn(
      async (
        _tenantId: string,
        actorUserId: string,
        _inventoryId: string,
        declaredStatus: InventoryChzStatus,
      ): Promise<InventoryImportDto> => {
        const importId = randomUUID();
        const sha256 = randomBytes(32).toString("hex");
        await db.insert(schema.inventoryImports).values({
          id: importId,
          tenantId,
          inventoryId,
          declaredStatus,
          fileName: `${declaredStatus.toLowerCase()}.zip`,
          containerKind: "zip",
          byteSize: 5,
          sha256,
          objectKey: `tenants/${tenantId}/chz-exports/${importId}.zip`,
          parsedStatus: declaredStatus,
          includedGtin14: GTIN,
          parseOutcome: "succeeded",
          createdByUserId: actorUserId,
        });
        return {
          id: importId,
          declaredStatus,
          parsedStatus: declaredStatus,
          result: "succeeded",
          rowCount: 1,
          errorCount: 0,
          duplicateCount: 0,
          sha256,
          diagnostics: [],
        };
      },
    );
  });

  function runnerWith(client: TrueApiClient): ChzExportRunnerService {
    return new ChzExportRunnerService(
      db,
      tokens as unknown as ChzTokenService,
      client,
      { importEvidence } as unknown as InventoriesService,
      journal as unknown as JournalService,
    );
  }

  async function seedRuns(options: {
    state: "queued" | "ordered";
    taskIdFor?: (status: InventoryChzStatus) => string;
    claimedAtFor?: (status: InventoryChzStatus) => Date | null;
    orderedAtFor?: (status: InventoryChzStatus) => Date;
    attemptsFor?: (status: InventoryChzStatus) => number;
  }): Promise<void> {
    for (const status of INVENTORY_CHZ_STATUSES) {
      const taskId = options.taskIdFor ? options.taskIdFor(status) : null;
      await db.insert(schema.chzExportRuns).values({
        tenantId,
        inventoryId,
        status,
        state: options.state,
        dispenserTaskId: options.state === "ordered" ? (taskId ?? `task-${status}`) : taskId,
        orderedByUserId,
        claimedAt: options.claimedAtFor ? options.claimedAtFor(status) : null,
        attempts: options.attemptsFor ? options.attemptsFor(status) : 0,
        ...(options.state === "ordered"
          ? { orderedAt: options.orderedAtFor ? options.orderedAtFor(status) : new Date() }
          : {}),
      });
    }
  }

  async function runsFor(
    id: string,
    status?: InventoryChzStatus,
  ): Promise<(typeof schema.chzExportRuns.$inferSelect)[]> {
    return db
      .select()
      .from(schema.chzExportRuns)
      .where(
        status
          ? and(eq(schema.chzExportRuns.inventoryId, id), eq(schema.chzExportRuns.status, status))
          : eq(schema.chzExportRuns.inventoryId, id),
      );
  }

  it("creates a task per queued run and moves it to ordered", async () => {
    await seedRuns({ state: "queued" });
    const { client, calls } = fakeClient({ createTaskId: (status) => `task-${status}` });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const rows = await runsFor(inventoryId);
    expect(rows.every((row) => row.state === "ordered")).toBe(true);
    expect(rows.map((row) => row.dispenserTaskId).sort()).toEqual(
      INVENTORY_CHZ_STATUSES.map((status) => `task-${status}`).sort(),
    );
    // Exactly one batch poll for the whole order. Polling each task separately
    // would be 6 requests per pass against `GET dispenser/tasks/{id}`'s limit of
    // 5 per minute -- the design would fail on its own traffic.
    expect(calls.filter((call) => call.op === "listDispenserResults")).toHaveLength(1);
  });

  it("fails a run at the creation-attempt cap without calling createDispenserTask", async () => {
    await seedRuns({ state: "queued", attemptsFor: (status) => (status === "EMITTED" ? 10 : 0) });
    const { client, calls } = fakeClient();
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [emitted] = await runsFor(inventoryId, "EMITTED");
    expect(emitted).toMatchObject({
      state: "failed",
      errorCode: "CHZ_CREATE_ATTEMPTS_EXHAUSTED",
      attempts: 10,
    });
    expect(
      calls.filter((call) => call.op === "createDispenserTask" && call.chzStatus === "EMITTED"),
    ).toHaveLength(0);
    // The other five statuses are unaffected by one status's exhausted cap.
    const others = (await runsFor(inventoryId)).filter((row) => row.status !== "EMITTED");
    expect(others.every((row) => row.state === "ordered")).toBe(true);
  });

  it("polls all six tasks in one batch request", async () => {
    await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
    const { client, calls } = fakeClient({ results: [] });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const poll = calls.find((call) => call.op === "listDispenserResults")!;
    expect([...(poll.taskIds ?? [])].sort()).toEqual(
      INVENTORY_CHZ_STATUSES.map((status) => `task-${status}`).sort(),
    );
  });

  it("leaves ordered runs untouched and the order unfinished on an unavailable batch poll", async () => {
    await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient({ resultsStatus: "unavailable" });
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 0,
      retryLimit: 5,
    });
    // A batch poll that fails says nothing about any individual task, so every
    // run stays exactly as it was -- not failed, not readvanced.
    expect(outcome).toEqual({ finished: false });
    expect((await runsFor(inventoryId)).every((row) => row.state === "ordered")).toBe(true);
    warn.mockRestore();
  });

  it("fails an order whose orderedAt is older than the deadline with CHZ_TASK_TIMED_OUT", async () => {
    const staleOrderedAt = new Date(Date.now() - 7 * 60 * 60_000); // past MAX_ORDER_WAIT_MS (6h)
    await seedRuns({
      state: "ordered",
      taskIdFor: (status) => `task-${status}`,
      orderedAtFor: (status) => (status === "EMITTED" ? staleOrderedAt : new Date()),
    });
    const { client, calls } = fakeClient({ results: [] });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [emitted] = await runsFor(inventoryId, "EMITTED");
    expect(emitted).toMatchObject({ state: "failed", errorCode: "CHZ_TASK_TIMED_OUT" });
    // The timed-out task is excluded from the batch poll -- it is already
    // decided, not still awaiting an answer.
    const poll = calls.find((call) => call.op === "listDispenserResults")!;
    expect(poll.taskIds).not.toContain("task-EMITTED");
    const others = (await runsFor(inventoryId)).filter((row) => row.status !== "EMITTED");
    expect(others.every((row) => row.state === "ordered")).toBe(true);
  });

  it("fails a ready run whose orderedAt is older than the deadline with CHZ_TASK_TIMED_OUT", async () => {
    const staleOrderedAt = new Date(Date.now() - 7 * 60 * 60_000); // past MAX_ORDER_WAIT_MS (6h)
    await seedRuns({
      state: "ordered",
      taskIdFor: (status) => `task-${status}`,
      orderedAtFor: (status) => (status === "EMITTED" ? staleOrderedAt : new Date()),
    });
    // `markReady` preserves `orderedAt`, so a run that reached `ready` and then
    // never became downloadable (`downloadDispenserResult` returning
    // `unavailable` forever) is still anchored on the same timestamp the
    // `ordered` deadline uses.
    await db
      .update(schema.chzExportRuns)
      .set({ state: "ready", resultId: "r1" })
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "EMITTED"),
        ),
      );
    const { client } = fakeClient({ results: [] });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [emitted] = await runsFor(inventoryId, "EMITTED");
    expect(emitted).toMatchObject({ state: "failed", errorCode: "CHZ_TASK_TIMED_OUT" });
    // The other five statuses stay ordered -- one status's deadline does not
    // disturb the rest of the order.
    const others = (await runsFor(inventoryId)).filter((row) => row.status !== "EMITTED");
    expect(others.every((row) => row.state === "ordered")).toBe(true);
  });

  it("terminates an order stuck without a token once orderedAt passes the deadline", async () => {
    // All six runs ordered and stuck long enough to be past the deadline, and
    // the tenant's signing agent never comes back (its certificate expiring is
    // routine). Before the fix, the timeout sweep lived inside `pollOrderedRuns`,
    // which a tokenless pass never reaches -- `getActiveToken` fails, nothing is
    // `queued` for `giveUpOnToken` to fail, and the order would report
    // `finished: false` forever. The sweep must reach these runs before the
    // token is ever requested.
    const staleOrderedAt = new Date(Date.now() - 7 * 60 * 60_000); // past MAX_ORDER_WAIT_MS (6h)
    await seedRuns({
      state: "ordered",
      taskIdFor: (status) => `task-${status}`,
      orderedAtFor: () => staleOrderedAt,
    });
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });
    const { client, calls } = fakeClient();
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 0,
      retryLimit: 5,
    });

    expect(outcome).toEqual({ finished: true });
    // The deadline needs only `orderedAt`, never a token: the token was never
    // even asked for.
    expect(tokens.getActiveToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    const rows = await runsFor(inventoryId);
    expect(rows.every((row) => row.state === "failed")).toBe(true);
    expect(rows.every((row) => row.errorCode === "CHZ_TASK_TIMED_OUT")).toBe(true);
  });

  it("hands the downloaded archive to importEvidence untouched and as a .zip", async () => {
    await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99]);
    const { client } = fakeClient({
      results: [{ taskId: "task-EMITTED", resultId: "r1", status: "COMPLETED" }],
      file: archive,
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    expect(importEvidence).toHaveBeenCalledTimes(1);
    const [, actorUserId, , declaredStatus, file] = importEvidence.mock.calls[0]!;
    expect(actorUserId).toBe(orderedByUserId);
    expect(declaredStatus).toBe("EMITTED");
    expect(file.originalName.endsWith(".zip")).toBe(true);
    expect(file.originalName).toBe("chz-emitted-task-EMITTED.zip");
    expect(file.mimeType).toBe("application/zip");
    // The parser already handles a one-CSV zip; re-packing or unpacking here
    // would be a second code path to the same invariant.
    expect(Array.from(file.bytes as Buffer)).toEqual(Array.from(archive));

    const [row] = await runsFor(inventoryId, "EMITTED");
    expect(row).toMatchObject({ state: "imported", completedAt: expect.any(Date) });
    expect(row!.importId).not.toBeNull();
  });

  it("fails a run whose ЧЗ task came back in a failed state", async () => {
    await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
    const { client } = fakeClient({
      results: [{ taskId: "task-RETIRED", resultId: null, status: "FAILED" }],
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [retired] = await runsFor(inventoryId, "RETIRED");
    expect(retired).toMatchObject({
      state: "failed",
      errorCode: "CHZ_TASK_FAILED",
      // `failed` keeps the task id: it is what an operator quotes to support.
      dispenserTaskId: "task-RETIRED",
      completedAt: expect.any(Date),
    });
    const others = (await runsFor(inventoryId)).filter((row) => row.status !== "RETIRED");
    expect(others.every((row) => row.state === "ordered")).toBe(true);
  });

  it("fails the run with the parser's own code when the import comes back failed", async () => {
    await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
    importEvidence.mockResolvedValue({
      id: randomUUID(),
      declaredStatus: "EMITTED",
      parsedStatus: null,
      result: "failed",
      rowCount: 0,
      errorCount: 1,
      duplicateCount: 0,
      sha256: "0".repeat(64),
      diagnostics: [{ code: "CHZ_ZIP_MEMBER_COUNT" }],
    });
    const { client } = fakeClient({
      results: [{ taskId: "task-EMITTED", resultId: "r1", status: "COMPLETED" }],
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [row] = await runsFor(inventoryId, "EMITTED");
    expect(row).toMatchObject({ state: "failed", errorCode: "CHZ_ZIP_MEMBER_COUNT" });
  });

  it("fails one status terminally without disturbing the other five", async () => {
    await seedRuns({ state: "queued" });
    const { client } = fakeClient({
      rejectStatus: "RETIRED",
      rejection: { code: "400", message: "no active contract" },
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [retired] = await runsFor(inventoryId, "RETIRED");
    expect(retired).toMatchObject({
      state: "failed",
      errorCode: "CHZ_TASK_REJECTED",
      errorMessage: "no active contract",
    });
    const others = (await runsFor(inventoryId)).filter((row) => row.status !== "RETIRED");
    expect(others.every((row) => row.state === "ordered")).toBe(true);
  });

  it("resumes an in-flight order instead of paying for a second task", async () => {
    await seedRuns({ state: "ordered", taskIdFor: () => "task-existing" });
    const { client, calls } = fakeClient({ results: [] });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
    expect(calls.filter((call) => call.op === "createDispenserTask")).toHaveLength(0);
  });

  it("reconciles a lost create response against the task list rather than re-creating", async () => {
    // A run claimed long enough ago to be stale, still queued, no task id. Only
    // EMITTED is in that state, which is what makes the pairing unambiguous --
    // the ЧЗ task list carries no report filter, so a task can only be adopted
    // when exactly one run is waiting for exactly one orphan.
    await seedRuns({
      state: "queued",
      claimedAtFor: (status) => (status === "EMITTED" ? new Date(Date.now() - STALE_CLAIM) : null),
    });
    const { client, calls } = fakeClient({
      existingTasks: [{ taskId: "task-orphan", status: "PREPARATION", createdAt: null }],
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [row] = await runsFor(inventoryId, "EMITTED");
    expect(row).toMatchObject({ state: "ordered", dispenserTaskId: "task-orphan" });
    expect(
      calls.filter((call) => call.op === "createDispenserTask" && call.chzStatus === "EMITTED"),
    ).toHaveLength(0);
  });

  it("never adopts a task whose id came back empty", async () => {
    await seedRuns({
      state: "queued",
      claimedAtFor: (status) => (status === "EMITTED" ? new Date(Date.now() - STALE_CLAIM) : null),
    });
    // `listDispenserTasks` yields "" for a row whose id was missing or not a
    // string. An empty id is malformed, never "the task this run is waiting
    // for" -- adopting it would write a task id that can never be polled.
    const { client, calls } = fakeClient({
      existingTasks: [{ taskId: "", status: "PREPARATION", createdAt: null }],
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [row] = await runsFor(inventoryId, "EMITTED");
    expect(row).toMatchObject({ state: "ordered", dispenserTaskId: "task-EMITTED" });
    expect(
      calls.filter((call) => call.op === "createDispenserTask" && call.chzStatus === "EMITTED"),
    ).toHaveLength(1);
  });

  it("leaves a run queued, not failed, when task creation is unavailable", async () => {
    await seedRuns({ state: "queued" });
    const { client } = fakeClient({ unavailableStatus: "EMITTED" });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    const [row] = await runsFor(inventoryId, "EMITTED");
    // `unavailable` (including a 429) is a wait, not a refusal: the run stays
    // queued for the next pass to claim again rather than being failed.
    expect(row).toMatchObject({ state: "queued", errorCode: null });
    const others = (await runsFor(inventoryId)).filter((run) => run.status !== "EMITTED");
    expect(others.every((run) => run.state === "ordered")).toBe(true);
  });

  it("refuses adoption when two runs are simultaneously awaiting a task id", async () => {
    // Two runs claimed long enough ago to be stale, both still queued with no
    // task id. The pairing is no longer forced, so adoption must refuse rather
    // than guess which orphan belongs to which run -- `listDispenserTasks` is
    // not even called.
    await seedRuns({
      state: "queued",
      claimedAtFor: (status) =>
        status === "EMITTED" || status === "RETIRED" ? new Date(Date.now() - STALE_CLAIM) : null,
    });
    const { client, calls } = fakeClient({
      existingTasks: [{ taskId: "task-orphan", status: "PREPARATION", createdAt: null }],
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

    expect(calls.filter((call) => call.op === "listDispenserTasks")).toHaveLength(0);
    const [emitted] = await runsFor(inventoryId, "EMITTED");
    const [retired] = await runsFor(inventoryId, "RETIRED");
    // Each pays for its own new task instead of one adopting the orphan --
    // the honest cost of a rule too narrow to arbitrate between two claimants.
    expect(emitted).toMatchObject({ state: "ordered", dispenserTaskId: "task-EMITTED" });
    expect(retired).toMatchObject({ state: "ordered", dispenserTaskId: "task-RETIRED" });
  });

  it("keeps runs non-terminal and reports unfinished when a token is unavailable", async () => {
    await seedRuns({ state: "queued" });
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient();
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 0,
      retryLimit: 5,
    });
    expect(outcome).toEqual({ finished: false });
    expect((await runsFor(inventoryId)).every((row) => row.state === "queued")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("unwinds through the token path on a mid-pass unauthorized", async () => {
    await seedRuns({ state: "queued" });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient({ unauthorizedStatus: "EMITTED" });
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 0,
      retryLimit: 5,
    });
    // A 401/403 anywhere in the pass is the same condition as a token that
    // failed to load: the job retries rather than failing runs outright.
    expect(outcome).toEqual({ finished: false });
    const [emitted] = await runsFor(inventoryId, "EMITTED");
    expect(emitted).toMatchObject({ state: "queued", errorCode: null });
    warn.mockRestore();
  });

  it("fails the remaining runs when the attempt budget is exhausted", async () => {
    await seedRuns({ state: "queued" });
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });
    const { client } = fakeClient();
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 5,
      retryLimit: 5,
    });
    expect(outcome).toEqual({ finished: true });
    const rows = await runsFor(inventoryId);
    expect(rows.every((row) => row.state === "failed")).toBe(true);
    expect(rows.every((row) => row.errorCode === "CHZ_TOKEN_UNAVAILABLE")).toBe(true);
  });

  it("leaves ordered and ready runs alone when the token budget is exhausted", async () => {
    // Five runs already ordered (ЧЗ-side work already paid for), one still
    // queued. An exhausted token budget must not throw the five in-flight
    // tasks away -- only the queued run, which cannot make progress without a
    // token at all, is failed.
    await seedRuns({
      state: "ordered",
      taskIdFor: (status) => `task-${status}`,
    });
    await db
      .update(schema.chzExportRuns)
      .set({
        state: "queued",
        dispenserTaskId: null,
        resultId: null,
        importId: null,
        errorCode: null,
        completedAt: null,
        orderedAt: null,
      })
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "EMITTED"),
        ),
      );
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });
    const { client } = fakeClient();
    const outcome = await runnerWith(client).run(tenantId, inventoryId, {
      retryCount: 5,
      retryLimit: 5,
    });
    expect(outcome).toEqual({ finished: false });
    const [emitted] = await runsFor(inventoryId, "EMITTED");
    expect(emitted).toMatchObject({ state: "failed", errorCode: "CHZ_TOKEN_UNAVAILABLE" });
    const others = (await runsFor(inventoryId)).filter((run) => run.status !== "EMITTED");
    expect(others.every((run) => run.state === "ordered")).toBe(true);
  });

  it("reports finished without spending a request once every run is terminal", async () => {
    await seedRuns({ state: "queued" });
    const { client, calls } = fakeClient();
    const runner = runnerWith(client);
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });
    await runner.run(tenantId, inventoryId, { retryCount: 5, retryLimit: 5 });

    tokens.getActiveToken.mockClear();
    const outcome = await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
    expect(outcome).toEqual({ finished: true });
    expect(tokens.getActiveToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("never writes the token into the journal", async () => {
    await seedRuns({ state: "queued" });
    const { client } = fakeClient({
      rejectStatus: "RETIRED",
      rejection: { code: "400", message: "no active contract" },
    });
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
    expect(journal.append).toHaveBeenCalled();
    const journalled = JSON.stringify(journal.append.mock.calls);
    expect(journalled).not.toContain(TEST_TOKEN);
  });

  it("keeps ordering the rest of the pass when a journal append fails", async () => {
    await seedRuns({ state: "queued" });
    journal.append.mockRejectedValue(new Error("journal is down"));
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { client } = fakeClient();
    await runnerWith(client).run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
    // Six orders placed, six journal appends refused, six lines logged and the
    // order still complete: audit noise is not a reason to abandon a pass.
    expect((await runsFor(inventoryId)).every((row) => row.state === "ordered")).toBe(true);
    expect(logged).toHaveBeenCalledTimes(INVENTORY_CHZ_STATUSES.length);
    logged.mockRestore();
  });
});
