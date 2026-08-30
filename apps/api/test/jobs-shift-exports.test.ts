import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import type { JobWithMetadata } from "pg-boss";
import {
  BUILD_INVENTORY_DOCUMENT_QUEUE,
  BUILD_SHIFT_EXPORT_QUEUE,
  PgBossService,
} from "../src/jobs/jobs.module";
import type { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import type { JournalService } from "../src/modules/integrations/journal.service";
import type { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import type { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import type { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import type { InventoryDocumentRunnerService } from "../src/modules/inventories/inventory-document-runner.service";
import type { SignerScheduler } from "../src/modules/signer-agents/signer-scheduler.service";
import type { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import type { ChzExportRunnerService } from "../src/modules/chz-exports/chz-export-runner.service";
import type { ChzCodeStatusIngestService } from "../src/modules/chz-code-statuses/chz-code-status-ingest.service";
import type { ChzCodeStatusRefreshService } from "../src/modules/chz-code-statuses/chz-code-status-refresh.service";

interface ShiftExportJobData {
  exportId: string;
}

type ShiftExportHandler = (jobs: JobWithMetadata<ShiftExportJobData>[]) => Promise<void>;
type InventoryDocumentHandler = (jobs: JobWithMetadata<{ runId: string }>[]) => Promise<void>;

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

function exportJob(
  id: string,
  exportId: string,
  retryCount: number,
  retryLimit: number,
): JobWithMetadata<ShiftExportJobData> {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    id,
    name: BUILD_SHIFT_EXPORT_QUEUE,
    data: { exportId },
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
  let shiftExportHandler: ShiftExportHandler | undefined;
  let inventoryDocumentHandler: InventoryDocumentHandler | undefined;
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async (_name?: string) => undefined),
    work: vi.fn(
      async (
        name: string,
        optionsOrHandler: object | ShiftExportHandler,
        handler?: ShiftExportHandler,
      ) => {
        workerIndex += 1;
        if (name === BUILD_SHIFT_EXPORT_QUEUE && handler) shiftExportHandler = handler;
        if (name === BUILD_INVENTORY_DOCUMENT_QUEUE && handler) {
          inventoryDocumentHandler = handler as unknown as InventoryDocumentHandler;
        }
        return `worker-${workerIndex}`;
      },
    ),
    send: vi.fn(async () => "shift-export-job-id" as string | null),
    // `checkReady`'s probe ignores the result; `assertChzExportQueuePolicy`
    // (jobs.module.ts) needs a row reporting the expected "stately" policy
    // so `onModuleInit` doesn't throw on the boot-time policy check.
    getDb: vi.fn(() => ({ executeSql: vi.fn(async () => ({ rows: [{ policy: "stately" }] })) })),
    getWipData: vi.fn(() => []),
    getShiftExportHandler: () => shiftExportHandler,
    getInventoryDocumentHandler: () => inventoryDocumentHandler,
  };
  return boss;
}

function serviceWith(boss: ReturnType<typeof fakeBoss>) {
  pgBossMock.instances.push(boss);
  // `.orderBy().limit()` (shift export / inventory document reconciliation)
  // and `.groupBy().orderBy().limit()` (chz export reconciliation) both
  // resolve to no rows.
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const groupBy = vi.fn(() => ({ orderBy }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ orderBy, groupBy })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => ({ rowCount: 0 })),
    })),
  } as unknown as MarkiroDb.Db;
  const runner = {
    run: vi.fn(async () => undefined),
  } as unknown as ShiftExportRunnerService;
  const inventoryRunner = {
    run: vi.fn(async () => undefined),
  } as unknown as InventoryDocumentRunnerService;
  const chzExportRunner = {
    run: vi.fn(async () => ({ finished: true })),
  } as unknown as ChzExportRunnerService;
  const chzCodeStatusIngest = {
    run: vi.fn(async () => ({ inserted: 0, watermark: null, caughtUp: true })),
  } as unknown as ChzCodeStatusIngestService;
  const chzCodeStatusRefresh = {
    run: vi.fn(async () => ({ batches: 0, updated: 0, caughtUp: true })),
  } as unknown as ChzCodeStatusRefreshService;
  return {
    runner,
    service: new PgBossService(
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
      runner,
      inventoryRunner,
      { run: vi.fn(async () => undefined) } satisfies SignerScheduler,
      chzExportRunner,
      chzCodeStatusIngest,
      chzCodeStatusRefresh,
    ),
    inventoryRunner,
  };
}

describe("PgBossService shift export queue", () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  it("registers a request-driven retry queue and forwards pg-boss attempt metadata", async () => {
    const boss = fakeBoss();
    const { service, runner } = serviceWith(boss);

    await service.onModuleInit();

    expect(boss.createQueue).toHaveBeenCalledWith(BUILD_SHIFT_EXPORT_QUEUE, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    expect(boss.work).toHaveBeenCalledWith(
      BUILD_SHIFT_EXPORT_QUEUE,
      { includeMetadata: true },
      expect.any(Function),
    );
    expect(boss.schedule.mock.calls.map(([queue]) => queue)).not.toContain(
      BUILD_SHIFT_EXPORT_QUEUE,
    );

    const handler = boss.getShiftExportHandler();
    expect(handler).toBeDefined();
    await handler?.([exportJob("job-1", "export-1", 0, 5), exportJob("job-2", "export-2", 3, 5)]);

    expect(runner.run).toHaveBeenNthCalledWith(1, "export-1", {
      retryCount: 0,
      retryLimit: 5,
    });
    expect(runner.run).toHaveBeenNthCalledWith(2, "export-2", {
      retryCount: 3,
      retryLimit: 5,
    });
  });

  it("enqueues a shift export and returns the pg-boss job id", async () => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await service.onModuleInit();

    await expect(service.enqueueShiftExport("export-1")).resolves.toBe("shift-export-job-id");
    expect(boss.send).toHaveBeenCalledWith(BUILD_SHIFT_EXPORT_QUEUE, {
      exportId: "export-1",
    });
  });

  it("rejects an enqueue when pg-boss does not return a job id", async () => {
    const boss = fakeBoss();
    boss.send.mockResolvedValueOnce(null);
    const { service } = serviceWith(boss);
    await service.onModuleInit();

    await expect(service.enqueueShiftExport("export-1")).rejects.toThrow(
      "shift export enqueue failed",
    );
  });

  it("registers, reconciles, and dispatches the inventory document queue", async () => {
    const boss = fakeBoss();
    const { service, inventoryRunner } = serviceWith(boss);
    await service.onModuleInit();

    expect(boss.createQueue).toHaveBeenCalledWith(BUILD_INVENTORY_DOCUMENT_QUEUE, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    const handler = boss.getInventoryDocumentHandler();
    expect(handler).toBeDefined();
    await handler?.([{ ...exportJob("job-inventory", "unused", 2, 5), data: { runId: "run-1" } }]);
    expect(inventoryRunner.run).toHaveBeenCalledWith("run-1", {
      retryCount: 2,
      retryLimit: 5,
    });
    await expect(service.enqueueInventoryDocumentRun("run-2")).resolves.toBe("shift-export-job-id");
    expect(boss.send).toHaveBeenCalledWith(BUILD_INVENTORY_DOCUMENT_QUEUE, { runId: "run-2" });
  });
});
