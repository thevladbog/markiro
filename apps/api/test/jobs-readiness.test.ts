import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import type { WipData, WorkerState } from "pg-boss";
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
import type { SignerSchedulerService } from "../src/modules/signer-agents/signer-scheduler.service";
import type { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";

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

const WORKER_IDS = Array.from({ length: 13 }, (_, index) => `worker-${index + 1}`);

function wip(id: string, state: WorkerState = "active"): WipData {
  return {
    id,
    workId: id,
    name: `queue-for-${id}`,
    options: {},
    state,
    count: 0,
    createdOn: 1,
    lastFetchedOn: null,
    lastJobStartedOn: null,
    lastJobEndedOn: null,
    lastJobDuration: null,
    lastError: null,
    lastErrorOn: null,
  };
}

function fakeBoss(options: { workIds?: string[]; failWorkAt?: number } = {}) {
  const workIds = options.workIds ?? WORKER_IDS;
  let workIndex = 0;
  let wipData = workIds.map((id) => wip(id));
  let sqlError: Error | undefined;
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
    work: vi.fn(async (_name?: string) => {
      const index = workIndex;
      workIndex += 1;
      if (index === options.failWorkAt) throw new Error("worker registration failed");
      const id = workIds[index];
      if (!id) throw new Error("missing worker id fixture");
      return id;
    }),
    send: vi.fn(async () => "job-id"),
    getDb: vi.fn(() => ({
      executeSql: vi.fn(async () => {
        if (sqlError) throw sqlError;
      }),
    })),
    getWipData: vi.fn(() => wipData),
    setWipData(next: WipData[]) {
      wipData = next;
    },
    failSql(error: Error) {
      sqlError = error;
    },
  };
  return boss;
}

function serviceWith(boss: ReturnType<typeof fakeBoss>) {
  pgBossMock.instances.push(boss);
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => ({ rowCount: 0 })),
    })),
  } as unknown as MarkiroDb.Db;
  const journal = { prune: vi.fn(async () => undefined) } as unknown as JournalService;
  const exchangeSessions = {
    sweepExpired: vi.fn(async () => undefined),
  } as unknown as ExchangeSessionService;
  const mailJobs = {
    dispatchOutbox: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    processDelivery: vi.fn(async () => undefined),
  } as unknown as MailJobsService;
  const mailRetention = { prune: vi.fn(async () => undefined) } as unknown as MailRetentionService;
  const subscriptionStatus = {
    run: vi.fn(async () => undefined),
  } as unknown as SubscriptionStatusJob;
  const shiftExportRunner = {
    run: vi.fn(async () => undefined),
  } as unknown as ShiftExportRunnerService;
  const inventoryDocumentRunner = {
    run: vi.fn(async () => undefined),
  } as unknown as InventoryDocumentRunnerService;
  const signerScheduler = {
    run: vi.fn(async () => undefined),
  } as unknown as SignerSchedulerService;
  return {
    service: new PgBossService(
      db,
      "postgres://unused",
      journal,
      exchangeSessions,
      mailJobs,
      mailRetention,
      subscriptionStatus,
      shiftExportRunner,
      inventoryDocumentRunner,
      signerScheduler,
    ),
    subscriptionStatus,
    signerScheduler,
  };
}

describe("PgBossService readiness", () => {
  beforeEach(() => {
    pgBossMock.instances.length = 0;
  });

  it("accepts the exact thirteen successfully registered active workers including document jobs", async () => {
    const boss = fakeBoss();
    const { service, subscriptionStatus, signerScheduler } = serviceWith(boss);

    await service.onModuleInit();

    await expect(service.checkReady()).resolves.toBeUndefined();
    expect(boss.work).toHaveBeenCalledTimes(13);
    expect(boss.work.mock.calls.map(([queue]) => queue)).toContain(BUILD_SHIFT_EXPORT_QUEUE);
    expect(boss.work.mock.calls.map(([queue]) => queue)).toContain(BUILD_INVENTORY_DOCUMENT_QUEUE);
    expect(subscriptionStatus.run).toHaveBeenCalledTimes(1);
    expect(signerScheduler.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a missing worker", WORKER_IDS.slice(0, 9).map((id) => wip(id))],
    [
      "a stopping worker",
      WORKER_IDS.map((id, index) => wip(id, index === 3 ? "stopping" : "active")),
    ],
    [
      "a stopped worker",
      WORKER_IDS.map((id, index) => wip(id, index === 6 ? "stopped" : "active")),
    ],
    ["a duplicate worker record", [wip(WORKER_IDS[0]!), ...WORKER_IDS.map((id) => wip(id))]],
  ])("rejects readiness with %s", async (_case, wipData) => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await service.onModuleInit();
    boss.setWipData(wipData);

    await expect(service.checkReady()).rejects.toThrow("pg-boss workers are not active");
  });

  it("rejects readiness when the pg-boss SQL probe fails", async () => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await service.onModuleInit();
    boss.failSql(new Error("password=secret postgres://jobs.internal/markiro"));

    const error = await service.checkReady().catch((failure: unknown) => failure);
    expect(error).toEqual(new Error("pg-boss database probe failed"));
    expect(String(error)).not.toMatch(/secret|jobs\.internal|postgres:\/\//);
  });

  it("discards partially captured worker ids after initialization failure", async () => {
    const failedBoss = fakeBoss({ failWorkAt: 4 });
    const { service } = serviceWith(failedBoss);

    await expect(service.onModuleInit()).rejects.toThrow("worker registration failed");
    await expect(service.checkReady()).rejects.toThrow("pg-boss is not started");

    const replacementBoss = fakeBoss({
      workIds: WORKER_IDS.map((id) => `replacement-${id}`),
    });
    pgBossMock.instances.push(replacementBoss);
    await service.onModuleInit();
    await expect(service.checkReady()).resolves.toBeUndefined();
  });

  it("discards captured worker ids when destroyed", async () => {
    const boss = fakeBoss();
    const { service } = serviceWith(boss);
    await service.onModuleInit();

    await service.onModuleDestroy();

    await expect(service.checkReady()).rejects.toThrow("pg-boss is not started");
  });
});
