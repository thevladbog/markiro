import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { buildChzKmOrderBody } from "@markiro/domain";

import { PgBossService, RUN_CHZ_KM_ORDER_QUEUE } from "../src/jobs/jobs.module";
import type { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import type { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import type { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import type { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import type { InventoryDocumentRunnerService } from "../src/modules/inventories/inventory-document-runner.service";
import type { SignerScheduler } from "../src/modules/signer-agents/signer-scheduler.service";
import type { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import type { ChzExportRunnerService } from "../src/modules/chz-exports/chz-export-runner.service";
import type { ChzCodeStatusIngestService } from "../src/modules/chz-code-statuses/chz-code-status-ingest.service";
import type { ChzCodeStatusRefreshService } from "../src/modules/chz-code-statuses/chz-code-status-refresh.service";
import { ChzKmOrderRunnerService } from "../src/modules/chz-km-orders/chz-km-order-runner.service";
import { ChzOmsTokenService } from "../src/modules/chz-km-orders/chz-oms-token.service";
import { OmsClient } from "../src/modules/chz-km-orders/oms.client";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);
const GTIN = "04607034690014";
// `chz_product_groups` (migration 0099) seeds code 15 as alias "beer";
// `CHZ_UNIT_TEMPLATE_ID_BY_GROUP.beer` (packages/domain) is 18.
const BEER_GROUP_CODE = 15;
const BEER_TEMPLATE_ID = 18;

interface ChzKmOrderJobData {
  tenantId: string;
  orderId: string;
  pass?: number;
}

type ChzKmOrderHandler = (jobs: JobWithMetadata<ChzKmOrderJobData>[]) => Promise<void>;

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

function chzKmOrderJob(
  data: ChzKmOrderJobData,
  retryCount = 0,
  retryLimit = 5,
): JobWithMetadata<ChzKmOrderJobData> {
  const now = new Date("2026-09-19T12:00:00.000Z");
  return {
    id: randomUUID(),
    name: RUN_CHZ_KM_ORDER_QUEUE,
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
    policy: "stately",
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
  let chzKmOrderHandler: ChzKmOrderHandler | undefined;
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async (_name?: string) => undefined),
    unschedule: vi.fn(async (_name?: string) => undefined),
    work: vi.fn(
      async (
        name: string,
        optionsOrHandler: object | ChzKmOrderHandler,
        handler?: ChzKmOrderHandler,
      ) => {
        workerIndex += 1;
        if (name === RUN_CHZ_KM_ORDER_QUEUE && handler) chzKmOrderHandler = handler;
        return `worker-${workerIndex}`;
      },
    ),
    send: vi.fn(
      async (_name?: string, _data?: unknown, _options?: unknown) => "job-id" as string | null,
    ),
    // `checkReady`'s probe ignores the result; the boot-time queue-policy
    // assertions in jobs.module.ts need a row reporting the expected
    // "stately" policy so `onModuleInit` doesn't throw. The parameters are
    // declared (even though this default ignores them) so a test below can
    // answer per queue name.
    getDb: vi.fn(() => ({
      executeSql: vi.fn(async (_sql: string, _values?: unknown[]) => ({
        rows: [{ policy: "stately" }],
      })),
    })),
    getWipData: vi.fn(() => []),
    getChzKmOrderHandler: () => chzKmOrderHandler,
  };
  return boss;
}

/**
 * pg-boss's own `stately` dedup, modelled: one `created` job per
 * `(queue, singletonKey)`, a second `send` resolving to `null` instead of
 * inserting. `chz-export-queue-policy.integration.test.ts` proves the real
 * package behaves this way (for `run-chz-km-order` too); this stands in for
 * it in a suite that mocks `pg-boss` wholesale.
 */
function dedupingSend(boss: ReturnType<typeof fakeBoss>): void {
  const taken = new Set<string>();
  boss.send.mockImplementation(async (name?: string, _data?: unknown, options?: unknown) => {
    const key = (options as { singletonKey?: string } | undefined)?.singletonKey;
    if (key === undefined) return "job-id";
    const slot = `${name ?? ""}:${key}`;
    if (taken.has(slot)) return null;
    taken.add(slot);
    return "job-id";
  });
}

/** Every `.select()` chain onModuleInit touches resolves to no rows. */
function emptyDb(): Db {
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const groupBy = vi.fn(() => ({ orderBy }));
  const where = vi.fn(() => ({ orderBy, groupBy }));
  const from = vi.fn(() => ({ where }));
  const distinctWhere = vi.fn(async () => []);
  const distinctFrom = vi.fn(() => ({ where: distinctWhere }));
  return {
    select: vi.fn(() => ({ from })),
    selectDistinct: vi.fn(() => ({ from: distinctFrom })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ rowCount: 0 })) })),
  } as unknown as Db;
}

/**
 * The ungrouped `.where().orderBy().limit()` chain --
 * `reconcileUnfinishedChzKmOrders` -- resolves to `rows`. The other
 * reconciliation passes that share that chain shape (shift exports,
 * inventory documents) see the same rows, so every assertion below filters
 * `boss.send` by queue name.
 */
function dbWithKmReconcileRows(rows: { tenantId: string; id: string }[]): Db {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const limitEmpty = vi.fn(async () => []);
  const orderByEmpty = vi.fn(() => ({ limit: limitEmpty }));
  const groupBy = vi.fn(() => ({ orderBy: orderByEmpty }));
  const where = vi.fn(() => ({ orderBy, groupBy }));
  const from = vi.fn(() => ({ where }));
  const distinctWhere = vi.fn(async () => []);
  const distinctFrom = vi.fn(() => ({ where: distinctWhere }));
  return {
    select: vi.fn(() => ({ from })),
    selectDistinct: vi.fn(() => ({ from: distinctFrom })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ rowCount: 0 })) })),
  } as unknown as Db;
}

function serviceWith(
  boss: ReturnType<typeof fakeBoss>,
  chzKmOrderRunner: ChzKmOrderRunnerService,
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
    { run: vi.fn(async () => ({ finished: true })) } as unknown as ChzExportRunnerService,
    {
      run: vi.fn(async () => ({ inserted: 0, watermark: null, caughtUp: true })),
    } as unknown as ChzCodeStatusIngestService,
    {
      run: vi.fn(async () => ({ batches: 0, updated: 0, caughtUp: true })),
    } as unknown as ChzCodeStatusRefreshService,
    chzKmOrderRunner,
  );
}

/** A runner whose every pass returns `outcome`, with nothing behind it. */
function fakeRunner(
  outcomes: { finished: boolean; retryAfterSeconds: number }[],
): ChzKmOrderRunnerService {
  const queue = [...outcomes];
  const last = outcomes.at(-1) ?? { finished: true, retryAfterSeconds: 0 };
  return {
    run: vi.fn(async () => queue.shift() ?? last),
    abandonAfterJobRetriesExhausted: vi.fn(async () => undefined),
  } as unknown as ChzKmOrderRunnerService;
}

describe("PgBossService run-chz-km-order queue", () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  it("registers a request-driven retry queue for run-chz-km-order", async () => {
    const boss = fakeBoss();
    const service = serviceWith(boss, fakeRunner([{ finished: true, retryAfterSeconds: 0 }]));

    await service.onModuleInit();

    expect(boss.createQueue).toHaveBeenCalledWith(RUN_CHZ_KM_ORDER_QUEUE, {
      policy: "stately",
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    expect(boss.work).toHaveBeenCalledWith(
      RUN_CHZ_KM_ORDER_QUEUE,
      { includeMetadata: true },
      expect.any(Function),
    );
    // Request-driven, like run-chz-export: an order enqueues its own chain.
    expect(boss.schedule.mock.calls.map(([queue]) => queue)).not.toContain(RUN_CHZ_KM_ORDER_QUEUE);
  });

  it(
    "fails boot when run-chz-km-order's actual queue policy is not stately -- createQueue is a " +
      "no-op on an existing queue, so this is the only thing that can catch a stale policy",
    async () => {
      const boss = fakeBoss();
      boss.getDb = vi.fn(() => ({
        executeSql: vi.fn(async (_sql: string, values?: unknown[]) => ({
          rows: [
            {
              policy:
                (values as string[] | undefined)?.[0] === RUN_CHZ_KM_ORDER_QUEUE
                  ? "standard"
                  : "stately",
            },
          ],
        })),
      }));
      const service = serviceWith(boss, fakeRunner([{ finished: true, retryAfterSeconds: 0 }]));

      await expect(service.onModuleInit()).rejects.toThrow(
        /run-chz-km-order queue policy is "standard", expected "stately"/,
      );
      expect(boss.stop).toHaveBeenCalledWith({ graceful: false });
    },
  );

  it("defaults a job with no pass field to pass 0 and hands the runner a 5760-pass budget", async () => {
    const boss = fakeBoss();
    const runner = fakeRunner([{ finished: false, retryAfterSeconds: 30 }]);
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    const handler = boss.getChzKmOrderHandler();
    expect(handler).toBeDefined();

    await handler?.([chzKmOrderJob({ tenantId: "tenant-1", orderId: "order-1" })]);

    expect(runner.run).toHaveBeenCalledWith("tenant-1", "order-1", {
      retryCount: 0,
      retryLimit: 5760,
    });
  });

  it("re-enqueues the same order with an incremented pass until the runner reports it finished", async () => {
    const boss = fakeBoss();
    const runner = fakeRunner([
      { finished: false, retryAfterSeconds: 7 },
      { finished: true, retryAfterSeconds: 0 },
    ]);
    const service = serviceWith(boss, runner);
    await service.onModuleInit();
    const handler = boss.getChzKmOrderHandler();

    // Pass 3 is unfinished: a successor job for pass 4 is sent, keyed on the
    // order so the chain can never fork. `retryAfterSeconds: 7` is below the
    // queue's own 30-second floor (`MAX_KM_ORDER_PASSES` is 48 hours AT that
    // floor), so the floor is what lands -- honouring 7 would burn the pass
    // budget four times faster than the order's deadline.
    boss.send.mockClear();
    await handler?.([chzKmOrderJob({ tenantId: "tenant-1", orderId: "order-1", pass: 3 })]);
    expect(runner.run).toHaveBeenCalledWith("tenant-1", "order-1", {
      retryCount: 3,
      retryLimit: 5760,
    });
    expect(boss.send).toHaveBeenCalledWith(
      RUN_CHZ_KM_ORDER_QUEUE,
      { tenantId: "tenant-1", orderId: "order-1", pass: 4 },
      expect.objectContaining({ startAfter: 30, singletonKey: "tenant-1:order-1" }),
    );

    // Pass 4 finishes the order: nothing is re-enqueued.
    boss.send.mockClear();
    await handler?.([chzKmOrderJob({ tenantId: "tenant-1", orderId: "order-1", pass: 4 })]);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("waits out a delay longer than the floor when the runner asks for one", async () => {
    const boss = fakeBoss();
    // 300s is what the runner asks for after invalidating a token and
    // requesting a refresh from the tenant's signer agent.
    const service = serviceWith(boss, fakeRunner([{ finished: false, retryAfterSeconds: 300 }]));
    await service.onModuleInit();
    const handler = boss.getChzKmOrderHandler();
    boss.send.mockClear();

    await handler?.([chzKmOrderJob({ tenantId: "tenant-1", orderId: "order-1" })]);

    expect(boss.send).toHaveBeenCalledWith(
      RUN_CHZ_KM_ORDER_QUEUE,
      { tenantId: "tenant-1", orderId: "order-1", pass: 1 },
      expect.objectContaining({ startAfter: 300, singletonKey: "tenant-1:order-1" }),
    );
  });

  it("enqueues a km order without a pass field, returning the pg-boss job id", async () => {
    const boss = fakeBoss();
    const service = serviceWith(boss, fakeRunner([{ finished: true, retryAfterSeconds: 0 }]));
    await service.onModuleInit();
    boss.send.mockClear();

    await expect(service.enqueueChzKmOrder("tenant-1", "order-1")).resolves.toBe("job-id");
    expect(boss.send).toHaveBeenCalledWith(
      RUN_CHZ_KM_ORDER_QUEUE,
      { tenantId: "tenant-1", orderId: "order-1" },
      { singletonKey: "tenant-1:order-1" },
    );
  });

  it("enqueues at most one job per order: a second enqueue for the same order is deduped, not a failure", async () => {
    const boss = fakeBoss();
    const service = serviceWith(boss, fakeRunner([{ finished: true, retryAfterSeconds: 0 }]));
    await service.onModuleInit();
    dedupingSend(boss);

    // `ChzKmOrdersService.create` and `.retry` both enqueue unconditionally.
    // Exactly one job may be in flight per order: the runner's block-storing
    // fence turns a concurrent second pass into codes drawn from Chestny
    // ZNAK and stored nowhere.
    const first = await service.enqueueChzKmOrder("tenant-1", "order-1");
    const second = await service.enqueueChzKmOrder("tenant-1", "order-1");
    const other = await service.enqueueChzKmOrder("tenant-1", "order-2");

    expect(first).toBe("job-id");
    expect(second).toBeNull();
    expect(other).toBe("job-id");
  });

  it("re-enqueues every order left non-terminal at boot, keyed so a survivor's chain wins", async () => {
    const boss = fakeBoss();
    const rows = [
      { tenantId: "tenant-1", id: "order-a" },
      { tenantId: "tenant-2", id: "order-b" },
    ];
    const service = serviceWith(
      boss,
      fakeRunner([{ finished: true, retryAfterSeconds: 0 }]),
      dbWithKmReconcileRows(rows),
    );

    await service.onModuleInit();

    const kmCalls = boss.send.mock.calls.filter(([queue]) => queue === RUN_CHZ_KM_ORDER_QUEUE);
    expect(kmCalls.map(([, data]) => data)).toEqual([
      { tenantId: "tenant-1", orderId: "order-a" },
      { tenantId: "tenant-2", orderId: "order-b" },
    ]);
    expect(
      kmCalls.map(([, , options]) => (options as { singletonKey?: string }).singletonKey),
    ).toEqual(["tenant-1:order-a", "tenant-2:order-b"]);
  });

  it("does not treat a deduped boot reconciliation send as a reconciliation failure", async () => {
    const boss = fakeBoss();
    const rows = [
      { tenantId: "tenant-1", id: "order-a" },
      { tenantId: "tenant-1", id: "order-b" },
    ];
    const service = serviceWith(
      boss,
      fakeRunner([{ finished: true, retryAfterSeconds: 0 }]),
      dbWithKmReconcileRows(rows),
    );
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    // order-a's previous chain survived the restart as a `created` job, so
    // pg-boss deduped this send rather than starting a second chain.
    boss.send.mockImplementation(async (name?: string, data?: unknown) => {
      if (
        name === RUN_CHZ_KM_ORDER_QUEUE &&
        (data as { orderId?: string } | undefined)?.orderId === "order-a"
      ) {
        return null;
      }
      return "job-id";
    });

    await service.onModuleInit();

    const kmErrors = errorSpy.mock.calls.filter(([message]) =>
      String(message).includes("chz km order reconciliation failed"),
    );
    expect(kmErrors).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

/**
 * `run()` rethrows anything it cannot classify, and a thrown pass sends no
 * `startAfter` successor -- so once pg-boss's own retry budget for the job is
 * spent, nothing would ever advance the order again: it would sit
 * non-terminal, invisible to `ChzKmOrdersService.retry()` (which requires
 * `state = 'failed'`) and reachable only by boot reconciliation. This drives
 * the real captured handler with a real `ChzKmOrderRunnerService` so
 * `abandonAfterJobRetriesExhausted` really writes to Postgres.
 */
describe.skipIf(!ready)("PgBossService run-chz-km-order queue: job retries exhausted", () => {
  const databaseName = `markiro_chz_km_order_job_${randomUUID().replaceAll("-", "_")}`;
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

  /** A real service, so the abandon path's DB write is exercised for real. */
  function throwingRunner(runnerDb: Db): ChzKmOrderRunnerService {
    const crypto = new ChzCryptoService(randomBytes(32));
    const runner = new ChzKmOrderRunnerService(
      runnerDb,
      new ChzOmsTokenService(runnerDb, crypto),
      // Never invoked: `run` is forced to reject before any СУЗ call.
      new OmsClient(),
      crypto,
      new JournalService(runnerDb),
    );
    vi.spyOn(runner, "run").mockRejectedValue(new Error("persistent СУЗ failure"));
    return runner;
  }

  async function seedOrder(): Promise<{ tenantId: string; orderId: string }> {
    const tenantId = await createOrganization(db);
    const userId = randomUUID();
    const productId = randomUUID();
    const orderId = randomUUID();

    await db.insert(schema.user).values({
      id: userId,
      name: "KM order job fixture operator",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "KM order job fixture product",
      chzProductGroupCode: BEER_GROUP_CODE,
    });
    await db.insert(schema.chzKmOrders).values({
      id: orderId,
      tenantId,
      productId,
      gtin14: GTIN,
      productGroupAlias: "beer",
      productGroupCode: BEER_GROUP_CODE,
      templateId: BEER_TEMPLATE_ID,
      quantity: 5,
      state: "created",
      requestBody: buildChzKmOrderBody({
        productGroupAlias: "beer",
        gtin14: GTIN,
        quantity: 5,
        templateId: BEER_TEMPLATE_ID,
        productionOrderId: orderId,
      }),
      createdByUserId: userId,
      deadlineAt: new Date(Date.now() + 48 * 3600_000),
    });
    return { tenantId, orderId };
  }

  it("fails the order once the job's own retry budget is exhausted, but rethrows while budget remains", async () => {
    const { tenantId, orderId } = await seedOrder();
    const runner = throwingRunner(db);
    const boss = fakeBoss();
    const service = serviceWith(boss, runner, emptyDb());
    await service.onModuleInit();
    const handler = boss.getChzKmOrderHandler();
    expect(handler).toBeDefined();

    async function order() {
      const [row] = await db
        .select()
        .from(schema.chzKmOrders)
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
      if (!row) throw new Error("fixture order vanished");
      return row;
    }

    // Inside pg-boss's own retry budget: the error must propagate so its
    // retry/backoff applies, and the order must stay untouched.
    boss.send.mockClear();
    await expect(handler?.([chzKmOrderJob({ tenantId, orderId }, 2, 5)])).rejects.toThrow(
      "persistent СУЗ failure",
    );
    expect(boss.send).not.toHaveBeenCalled();
    expect((await order()).state).toBe("created");

    // Budget spent (this was pg-boss's last attempt): no successor retry can
    // catch a rethrow, so the handler must resolve and end the order.
    boss.send.mockClear();
    await expect(handler?.([chzKmOrderJob({ tenantId, orderId }, 5, 5)])).resolves.toBeUndefined();
    expect(boss.send).not.toHaveBeenCalled();

    const abandoned = await order();
    expect(abandoned.state).toBe("failed");
    expect(abandoned.errorCode).toBe("CHZ_JOB_RETRIES_EXHAUSTED");
  }, 30_000);
});
