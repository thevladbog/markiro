import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";

import { PgBossService, RUN_CHZ_EXPORT_QUEUE } from "../src/jobs/jobs.module";
import type { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import type { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import type { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import type { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import type { InventoryDocumentRunnerService } from "../src/modules/inventories/inventory-document-runner.service";
import type { SignerScheduler } from "../src/modules/signer-agents/signer-scheduler.service";
import type { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import { ChzExportRunnerService } from "../src/modules/chz-exports/chz-export-runner.service";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { TrueApiClient } from "../src/modules/chz-exports/true-api.client";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import type { InventoriesService } from "../src/modules/inventories/inventories.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);
const GTIN = "04600000000015";

interface ChzExportJobData {
  tenantId: string;
  inventoryId: string;
  pass?: number;
}

type ChzExportHandler = (jobs: JobWithMetadata<ChzExportJobData>[]) => Promise<void>;

const pgBossMock = vi.hoisted(() => ({
  instances: [] as unknown[],
}));

vi.mock("pg-boss", () => ({
  PgBoss: vi.fn(function PgBossMock() {
    const instance = pgBossMock.instances.shift();
    if (!instance) throw new Error("missing fake pg-boss instance");
    return instance;
  }),
}));

vi.mock("@markiro/db", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkiroDb>();
  return {
    ...actual,
    ensurePartitions: vi.fn(async () => []),
  };
});

function chzExportJob(
  data: ChzExportJobData,
  retryCount = 0,
  retryLimit = 5,
): JobWithMetadata<ChzExportJobData> {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    id: randomUUID(),
    name: RUN_CHZ_EXPORT_QUEUE,
    data,
    priority: 0,
    state: "active",
    retryLimit,
    retryCount,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 900,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    expireInSeconds: 900,
    deleteAfterSeconds: 604_800,
    createdOn: now,
    completedOn: null,
    keepUntil: now,
    policy: "standard",
    heartbeatOn: null,
    heartbeatSeconds: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: "",
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
    signal: AbortSignal.abort(),
  };
}

function fakeBoss() {
  let workerIndex = 0;
  let chzExportHandler: ChzExportHandler | undefined;
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async (_name?: string) => undefined),
    work: vi.fn(
      async (
        name: string,
        optionsOrHandler: object | ChzExportHandler,
        handler?: ChzExportHandler,
      ) => {
        workerIndex += 1;
        if (name === RUN_CHZ_EXPORT_QUEUE && handler) chzExportHandler = handler;
        return `worker-${workerIndex}`;
      },
    ),
    send: vi.fn(
      async (_name?: string, _data?: unknown, _options?: unknown) => "job-id" as string | null,
    ),
    getDb: vi.fn(() => ({ executeSql: vi.fn(async () => undefined) })),
    getWipData: vi.fn(() => []),
    getChzExportHandler: () => chzExportHandler,
  };
  return boss;
}

/** Every `.select()` chain onModuleInit touches resolves to no rows. */
function emptyDb(): Db {
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const groupBy = vi.fn(() => ({ orderBy }));
  const where = vi.fn(() => ({ orderBy, groupBy }));
  const from = vi.fn(() => ({ where }));
  return {
    select: vi.fn(() => ({ from })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ rowCount: 0 })) })),
  } as unknown as Db;
}

/**
 * Only the grouped (`.groupBy()`) chain -- `reconcileUnfinishedChzExports` --
 * resolves to `rows`. The ungrouped chains other reconciliation passes use
 * (`reconcileQueuedShiftExports`, `reconcileQueuedInventoryDocumentRuns`)
 * keep resolving to no rows, same as `emptyDb()`.
 */
function dbWithChzReconcileRows(rows: { tenantId: string; inventoryId: string }[]): Db {
  const limitEmpty = vi.fn(async () => []);
  const orderByEmpty = vi.fn(() => ({ limit: limitEmpty }));
  const limitRows = vi.fn(async () => rows);
  const orderByRows = vi.fn(() => ({ limit: limitRows }));
  const groupBy = vi.fn(() => ({ orderBy: orderByRows }));
  const where = vi.fn(() => ({ orderBy: orderByEmpty, groupBy }));
  const from = vi.fn(() => ({ where }));
  return {
    select: vi.fn(() => ({ from })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ rowCount: 0 })) })),
  } as unknown as Db;
}

function serviceWith(
  boss: ReturnType<typeof fakeBoss>,
  chzExportRunner: ChzExportRunnerService,
  db: Db = emptyDb(),
) {
  pgBossMock.instances.push(boss);
  return new PgBossService(
    db,
    "postgres://unused",
    { prune: vi.fn(async () => undefined) } as unknown as JournalService,
    { sweepExpired: vi.fn(async () => undefined) } as unknown as ExchangeSessionService,
    {
      dispatchOutbox: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      processDelivery: vi.fn(async () => undefined),
    } as unknown as MailJobsService,
    { prune: vi.fn(async () => undefined) } as unknown as MailRetentionService,
    { run: vi.fn(async () => undefined) } as unknown as SubscriptionStatusJob,
    { run: vi.fn(async () => undefined) } as unknown as ShiftExportRunnerService,
    { run: vi.fn(async () => undefined) } as unknown as InventoryDocumentRunnerService,
    { run: vi.fn(async () => undefined) } satisfies SignerScheduler,
    chzExportRunner,
  );
}

describe("PgBossService run-chz-export queue", () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  it("registers a request-driven retry queue for run-chz-export", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: true })),
    } as unknown as ChzExportRunnerService;
    const service = serviceWith(boss, runner);

    await service.onModuleInit();

    expect(boss.createQueue).toHaveBeenCalledWith(RUN_CHZ_EXPORT_QUEUE, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    expect(boss.work).toHaveBeenCalledWith(
      RUN_CHZ_EXPORT_QUEUE,
      { includeMetadata: true },
      expect.any(Function),
    );
    expect(boss.schedule.mock.calls.map(([queue]) => queue)).not.toContain(RUN_CHZ_EXPORT_QUEUE);
  });

  it("defaults a job with no pass field to pass 0 and hands the runner a 240-pass budget", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: false })),
    } as unknown as ChzExportRunnerService;
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    const handler = boss.getChzExportHandler();
    expect(handler).toBeDefined();

    await handler?.([chzExportJob({ tenantId: "tenant-1", inventoryId: "inventory-1" })]);

    expect(runner.run).toHaveBeenCalledWith("tenant-1", "inventory-1", {
      retryCount: 0,
      retryLimit: 240,
    });
  });

  it("re-enqueues the same order with a delay and an incremented pass while any run is unfinished", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: false })),
    } as unknown as ChzExportRunnerService;
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    const handler = boss.getChzExportHandler();
    boss.send.mockClear();

    await handler?.([chzExportJob({ tenantId: "tenant-1", inventoryId: "inventory-1", pass: 3 })]);

    expect(runner.run).toHaveBeenCalledWith("tenant-1", "inventory-1", {
      retryCount: 3,
      retryLimit: 240,
    });
    expect(boss.send).toHaveBeenCalledWith(
      RUN_CHZ_EXPORT_QUEUE,
      { tenantId: "tenant-1", inventoryId: "inventory-1", pass: 4 },
      expect.objectContaining({ startAfter: 30 }),
    );
  });

  it(
    "stops re-enqueueing once the order is finished, including an order whose six runs " +
      "were already terminal before this pass (ChzExportsService.order/retry enqueue unconditionally)",
    async () => {
      const boss = fakeBoss();
      const runner = {
        run: vi.fn(async () => ({ finished: true })),
      } as unknown as ChzExportRunnerService;
      const service = serviceWith(boss, runner);
      await service.onModuleInit();
      const handler = boss.getChzExportHandler();
      boss.send.mockClear();

      await handler?.([chzExportJob({ tenantId: "tenant-1", inventoryId: "inventory-1" })]);

      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(boss.send).not.toHaveBeenCalled();
    },
  );

  it("advances the pass counter up to the cap, then stops once the runner reports the budget spent", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: false })),
    } as unknown as ChzExportRunnerService;
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    const handler = boss.getChzExportHandler();

    boss.send.mockClear();
    await handler?.([
      chzExportJob({ tenantId: "tenant-1", inventoryId: "inventory-1", pass: 239 }),
    ]);
    expect(runner.run).toHaveBeenCalledWith("tenant-1", "inventory-1", {
      retryCount: 239,
      retryLimit: 240,
    });
    expect(boss.send).toHaveBeenCalledWith(
      RUN_CHZ_EXPORT_QUEUE,
      { tenantId: "tenant-1", inventoryId: "inventory-1", pass: 240 },
      expect.objectContaining({ startAfter: 30 }),
    );

    // Once the runner itself reports the budget exhausted -- exactly what
    // `ChzExportRunnerService.giveUpOnToken` does when `retryCount >=
    // retryLimit` (exercised for real in the DB-backed suite below) -- the
    // worker must not manufacture a 241st pass.
    runner.run = vi.fn(async () => ({ finished: true }));
    boss.send.mockClear();
    await handler?.([
      chzExportJob({ tenantId: "tenant-1", inventoryId: "inventory-1", pass: 240 }),
    ]);
    expect(runner.run).toHaveBeenCalledWith("tenant-1", "inventory-1", {
      retryCount: 240,
      retryLimit: 240,
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("enqueues a chz export order without a pass field, returning the pg-boss job id", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: true })),
    } as unknown as ChzExportRunnerService;
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    boss.send.mockClear();

    await expect(service.enqueueChzExportOrder("tenant-1", "inventory-1")).resolves.toBe(
      "job-id",
    );
    expect(boss.send).toHaveBeenCalledWith(RUN_CHZ_EXPORT_QUEUE, {
      tenantId: "tenant-1",
      inventoryId: "inventory-1",
    });
  });

  it("re-enqueues every order left with a non-terminal run at boot, one job per order not per run", async () => {
    const boss = fakeBoss();
    const runner = {
      run: vi.fn(async () => ({ finished: true })),
    } as unknown as ChzExportRunnerService;
    // Two orders each still have at least one non-terminal run -- a fully
    // imported order (six terminal rows) never appears here because the
    // `state in ('queued', 'ordered', 'ready')` filter in
    // `reconcileUnfinishedChzExports` excludes it before grouping.
    const rows = [
      { tenantId: "tenant-1", inventoryId: "inventory-a" },
      { tenantId: "tenant-1", inventoryId: "inventory-b" },
    ];
    const service = serviceWith(boss, runner, dbWithChzReconcileRows(rows));

    await service.onModuleInit();

    const chzCalls = boss.send.mock.calls.filter(([queue]) => queue === RUN_CHZ_EXPORT_QUEUE);
    expect(chzCalls.map(([, data]) => data)).toEqual([
      { tenantId: "tenant-1", inventoryId: "inventory-a" },
      { tenantId: "tenant-1", inventoryId: "inventory-b" },
    ]);
  });
});

/**
 * The amendment's actual concern: `startAfter` re-enqueues create a fresh
 * pg-boss job every pass, so `job.retryCount`/`job.retryLimit` reset to zero
 * each time and cannot bound how many passes an order gets. An order whose
 * six runs are all still `queued` for a tenant that never configures a ChZ
 * token never reaches the runner's own `orderedAt` deadline (it needs a run
 * that reached `ordered`) or its `attempts` cap (incremented only on a claim,
 * which happens after the token check) -- so without a pass budget it would
 * re-enqueue forever. This drives the real `ChzExportRunnerService` (Task 5)
 * through the real captured `jobs.module.ts` handler to prove the two
 * compose: the pass number actually advances across re-enqueues, and once it
 * reaches `MAX_EXPORT_PASSES` (240) the runner's `giveUpOnToken` fails every
 * queued run instead of asking for a 241st pass.
 */
describe.skipIf(!ready)("PgBossService run-chz-export queue: pass budget (amendment)", () => {
  const databaseName = `markiro_chz_export_job_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;

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

  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  /** Never configuring `CHZ_TOKEN_ENCRYPTION_KEY` is the simplest "no token" fixture. */
  function realChzExportRunner(runnerDb: Db): ChzExportRunnerService {
    const crypto = new ChzCryptoService(undefined);
    const tokens = new ChzTokenService(runnerDb, crypto);
    // Never invoked: the token check returns "unconfigured" before any order
    // context lookup or True API call happens.
    const client = new TrueApiClient();
    const inventories = {} as InventoriesService;
    const journal = new JournalService(runnerDb);
    return new ChzExportRunnerService(runnerDb, tokens, client, inventories, journal);
  }

  it(
    "advances the pass counter across re-enqueues and fails a tokenless all-queued order once the budget is spent",
    async () => {
      const tenantId = await createOrganization(db);
      const actorUserId = randomUUID();
      const productId = randomUUID();
      const lineId = randomUUID();
      const inventoryId = randomUUID();

      await db.insert(schema.user).values({
        id: actorUserId,
        name: "Export job fixture operator",
        email: `${randomUUID()}@example.invalid`,
        emailVerified: false,
      });
      await db.insert(schema.products).values({
        id: productId,
        tenantId,
        gtin14: GTIN,
        name: "Export job fixture product",
      });
      await db
        .insert(schema.lines)
        .values({ id: lineId, tenantId, name: "Export job fixture line" });
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
        createdByUserId: actorUserId,
      });
      await db.insert(schema.chzExportRuns).values(
        INVENTORY_CHZ_STATUSES.map((status) => ({
          tenantId,
          inventoryId,
          status,
          state: "queued" as const,
          orderedByUserId: actorUserId,
        })),
      );

      const boss = fakeBoss();
      // PgBossService's own `db` only backs its boot reconciliation queries,
      // never the runner's own state -- an empty mock here keeps this test
      // from also exercising boot reconciliation noise for this order.
      const service = serviceWith(boss, realChzExportRunner(db), emptyDb());
      await service.onModuleInit();
      const handler = boss.getChzExportHandler();
      expect(handler).toBeDefined();

      // Pass 0: no token was ever configured, but the budget (240) is not
      // spent yet, so the order re-enqueues for another pass.
      boss.send.mockClear();
      await handler?.([chzExportJob({ tenantId, inventoryId })]);
      expect(boss.send).toHaveBeenCalledWith(
        RUN_CHZ_EXPORT_QUEUE,
        { tenantId, inventoryId, pass: 1 },
        expect.objectContaining({ startAfter: 30 }),
      );

      // Pass 239: one pass short of the cap, still re-enqueues.
      boss.send.mockClear();
      await handler?.([chzExportJob({ tenantId, inventoryId, pass: 239 })]);
      expect(boss.send).toHaveBeenCalledWith(
        RUN_CHZ_EXPORT_QUEUE,
        { tenantId, inventoryId, pass: 240 },
        expect.objectContaining({ startAfter: 30 }),
      );

      // Pass 240: `retryCount` (240) now meets `retryLimit` (240,
      // `MAX_EXPORT_PASSES`), so `giveUpOnToken` fails every still-queued run
      // instead of asking for a 241st pass -- the job wiring stops for good.
      boss.send.mockClear();
      await handler?.([chzExportJob({ tenantId, inventoryId, pass: 240 })]);
      expect(boss.send).not.toHaveBeenCalled();

      const rows = await db
        .select()
        .from(schema.chzExportRuns)
        .where(
          and(
            eq(schema.chzExportRuns.tenantId, tenantId),
            eq(schema.chzExportRuns.inventoryId, inventoryId),
          ),
        );
      expect(rows).toHaveLength(6);
      expect(
        rows.every((row) => row.state === "failed" && row.errorCode === "CHZ_TOKEN_UNAVAILABLE"),
      ).toBe(true);
    },
    30_000,
  );
});
