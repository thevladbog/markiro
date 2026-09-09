import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import type { JobWithMetadata } from "pg-boss";
import { Test } from "@nestjs/testing";
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
import {
  CATALOG_QUEUES,
  CATALOG_REPAIR_QUEUE,
  NationalCatalogJobsService,
} from "../src/modules/national-catalog/national-catalog-jobs.service";
import type { CatalogJob } from "../src/modules/national-catalog/national-catalog-job-repository";
import { NationalCatalogImportController } from "../src/modules/national-catalog/national-catalog-import.controller";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

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
  const catalogHandlers = new Map<string, ShiftExportHandler>();
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
        optionsOrHandler: { includeMetadata?: boolean } | ShiftExportHandler,
        handler?: ShiftExportHandler,
      ) => {
        workerIndex += 1;
        if (name === BUILD_SHIFT_EXPORT_QUEUE && handler) shiftExportHandler = handler;
        if (name === BUILD_INVENTORY_DOCUMENT_QUEUE && handler) {
          inventoryDocumentHandler = handler as unknown as InventoryDocumentHandler;
        }
        if (typeof optionsOrHandler === "function") catalogHandlers.set(name, optionsOrHandler);
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
    getCatalogHandler: (name: string) => {
      const handler = catalogHandlers.get(name);
      if (!handler) throw new Error(`Missing handler: ${name}`);
      return handler;
    },
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
  const where = vi.fn(() => ({ orderBy, groupBy }));
  const distinctWhere = vi.fn(async () => []);
  const distinctFrom = vi.fn(() => ({ where: distinctWhere }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where,
      })),
    })),
    selectDistinct: vi.fn(() => ({ from: distinctFrom })),
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
  const catalogResume = vi.fn<() => Promise<void>>(async () => undefined);
  const catalogClaim = vi.fn<() => Promise<CatalogJob[]>>(async () => []);
  const catalogJobs = new NationalCatalogJobsService(
    { claim: catalogClaim },
    { resume: catalogResume, releaseExpired: async () => 0 },
    { resumePreparation: async () => undefined },
    { resume: async () => undefined },
    { resume: async () => undefined, apply: async () => undefined, releaseExpired: async () => 0 },
    { resume: async () => undefined },
  );
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
      undefined,
      undefined,
      undefined,
      catalogJobs,
    ),
    inventoryRunner,
    catalogJobs,
    catalogResume,
    catalogClaim,
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

describe("PgBossService immediate National Catalog wake", () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  it("enqueues a coalesced repair wake and preserves the minute recovery schedule", async () => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await service.onModuleInit();
    boss.send.mockClear();

    await service.wakeNationalCatalog();

    expect(boss.send).toHaveBeenCalledExactlyOnceWith(CATALOG_REPAIR_QUEUE, {});
    expect(boss.createQueue).toHaveBeenCalledWith(CATALOG_REPAIR_QUEUE, {
      policy: "stately",
      retryLimit: 0,
    });
    expect(boss.schedule).toHaveBeenCalledWith(CATALOG_REPAIR_QUEUE, "* * * * *");
  });

  it("keeps wake best-effort when unavailable, deduplicated, or rejected by the queue", async () => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await expect(service.wakeNationalCatalog()).resolves.toBeUndefined();
    expect(boss.send).not.toHaveBeenCalled();
    await service.onModuleInit();
    boss.send.mockResolvedValueOnce(null);
    await expect(service.wakeNationalCatalog()).resolves.toBeUndefined();
    boss.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(service.wakeNationalCatalog()).resolves.toBeUndefined();
    await service.onModuleDestroy();
    boss.send.mockClear();
    await expect(service.wakeNationalCatalog()).resolves.toBeUndefined();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("wakes only after a successful durable worker step settles", async () => {
    const boss = fakeBoss();
    const { service, catalogJobs } = serviceWith(boss);
    let commit = () => {};
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const execute = vi.spyOn(catalogJobs, "execute").mockImplementation(() => committed);
    await service.onModuleInit();
    boss.send.mockClear();
    const job = exportJob("catalog-job", "unused", 0, 0);
    const working = boss.getCatalogHandler(CATALOG_QUEUES.enumerate)([job]);
    expect(execute).toHaveBeenCalledWith(job.data);
    expect(boss.send).not.toHaveBeenCalled();

    commit();
    await working;
    expect(boss.send).toHaveBeenCalledExactlyOnceWith(CATALOG_REPAIR_QUEUE, {});

    boss.send.mockClear();
    execute.mockRejectedValueOnce(new Error("database failure"));
    await expect(boss.getCatalogHandler(CATALOG_QUEUES.prepare)([job])).rejects.toThrow(
      "database failure",
    );
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("acknowledges a finished step even if its follow-up wake fails and never loops empty repair", async () => {
    const boss = fakeBoss();
    const { service, catalogJobs, catalogClaim } = serviceWith(boss);
    vi.spyOn(catalogJobs, "execute").mockResolvedValue(undefined);
    await service.onModuleInit();
    boss.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(
      boss.getCatalogHandler(CATALOG_QUEUES.candidate)([exportJob("catalog-job", "unused", 0, 0)]),
    ).resolves.toBeUndefined();
    expect(boss.send).toHaveBeenCalledWith(CATALOG_REPAIR_QUEUE, {});

    boss.send.mockClear();
    await boss.getCatalogHandler(CATALOG_REPAIR_QUEUE)([]);
    expect(catalogClaim).toHaveBeenCalledExactlyOnceWith(100);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("returns the committed HTTP result after a failed wake and later dispatches its durable intent", async () => {
    const boss = fakeBoss();
    const { service, catalogClaim } = serviceWith(boss);
    await service.onModuleInit();
    const saved = { id: "00000000-0000-4000-8000-000000000001" };
    let commit: (value: typeof saved) => void = () => {};
    const committed = new Promise<typeof saved>((resolve) => {
      commit = resolve;
    });
    const module = await Test.createTestingModule({
      controllers: [NationalCatalogImportController],
      providers: [
        { provide: PgBossService, useValue: service },
        { provide: NationalCatalogImportService, useValue: { start: () => committed } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    try {
      boss.send.mockClear();
      boss.send.mockRejectedValueOnce(new Error("queue unavailable"));
      const response = module
        .get(NationalCatalogImportController)
        .start({ tenantId: "tenant", userId: "user" } as RequestWithTenant, {
          mode: "own_catalog",
        });
      expect(boss.send).not.toHaveBeenCalled();
      commit(saved);
      await expect(response).resolves.toBe(saved);
      expect(boss.send).toHaveBeenCalledExactlyOnceWith(CATALOG_REPAIR_QUEUE, {});

      const durable: CatalogJob = {
        kind: "enumerate",
        tenantId: "tenant",
        sessionId: saved.id,
        workId: saved.id,
        stepId: "00000000-0000-4000-8000-000000000002",
      };
      catalogClaim.mockResolvedValueOnce([durable]);
      boss.send.mockClear();
      await boss.getCatalogHandler(CATALOG_REPAIR_QUEUE)([]);
      expect(boss.send).toHaveBeenCalledExactlyOnceWith(CATALOG_QUEUES.enumerate, durable, {
        singletonKey: `enumerate:tenant:${saved.id}:${durable.stepId}`,
      });
    } finally {
      await module.close();
    }
  });
});
