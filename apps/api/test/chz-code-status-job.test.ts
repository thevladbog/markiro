import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import type { Db } from "@markiro/db";

import { PgBossService, REFRESH_CHZ_CODE_STATUSES_QUEUE } from "../src/jobs/jobs.module";
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

type CronHandler = () => Promise<void>;

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

function fakeBoss() {
  let workerIndex = 0;
  let refreshHandler: CronHandler | undefined;
  const boss = {
    on: vi.fn(),
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    schedule: vi.fn(async (_name?: string) => undefined),
    work: vi.fn(async (name: string, optionsOrHandler: object | CronHandler, maybe?: CronHandler) => {
      workerIndex += 1;
      const fn = typeof optionsOrHandler === "function" ? (optionsOrHandler as CronHandler) : maybe;
      if (name === REFRESH_CHZ_CODE_STATUSES_QUEUE && fn) refreshHandler = fn;
      return `worker-${workerIndex}`;
    }),
    send: vi.fn(async () => "job-id" as string | null),
    // `checkReady`'s probe ignores the result; `assertChzExportQueuePolicy`
    // (jobs.module.ts) needs a row reporting the expected "stately" policy so
    // `onModuleInit` doesn't throw on the boot-time policy check for the
    // unrelated `run-chz-export` queue.
    getDb: vi.fn(() => ({ executeSql: vi.fn(async () => ({ rows: [{ policy: "stately" }] })) })),
    getWipData: vi.fn(() => []),
    getRefreshChzCodeStatusesHandler: () => refreshHandler,
  };
  return boss;
}

/**
 * Tenants "enabled" for the ChZ channel, per the same tenant-selection query
 * `runRefreshChzCodeStatuses` copies from `SignerSchedulerService`'s: an
 * active `chz_signer_agents` row. `seedTenantsWithChzChannel`/
 * `seedTenantWithoutChzChannel` below just add or withhold entries from this
 * list, matching the mocked `db.selectDistinct(...).from(...).where(...)`
 * chain that stands in for it.
 */
let enabledTenantIds: string[] = [];

async function seedTenantsWithChzChannel(tenantIds: string[]): Promise<void> {
  enabledTenantIds.push(...tenantIds);
}

async function seedTenantWithoutChzChannel(_tenantId: string): Promise<void> {
  // Deliberately not added to `enabledTenantIds`: a tenant with no active
  // `chz_signer_agents` row must never be selected.
}

/** Every `.select()` chain onModuleInit touches (boot reconciliation) resolves to no rows. */
function fakeDb(): Db {
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const groupBy = vi.fn(() => ({ orderBy }));
  const where = vi.fn(() => ({ orderBy, groupBy }));
  const from = vi.fn(() => ({ where }));
  const distinctWhere = vi.fn(async () => enabledTenantIds.map((tenantId) => ({ tenantId })));
  const distinctFrom = vi.fn(() => ({ where: distinctWhere }));
  return {
    select: vi.fn(() => ({ from })),
    selectDistinct: vi.fn(() => ({ from: distinctFrom })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ rowCount: 0 })) })),
  } as unknown as Db;
}

function serviceWith(
  boss: ReturnType<typeof fakeBoss>,
  ingest: ChzCodeStatusIngestService,
  refresh: ChzCodeStatusRefreshService,
) {
  pgBossMock.instances.push(boss);
  return new PgBossService(
    fakeDb(),
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
    ingest,
    refresh,
  );
}

describe("PgBossService refresh-chz-code-statuses queue", () => {
  let ingest: { run: ReturnType<typeof vi.fn> };
  let refresh: { run: ReturnType<typeof vi.fn> };
  let handler: CronHandler;

  beforeEach(async () => {
    pgBossMock.instances.length = 0;
    enabledTenantIds = [];
    ingest = { run: vi.fn(async () => ({ inserted: 0, watermark: null, caughtUp: true })) };
    refresh = { run: vi.fn(async () => ({ batches: 0, updated: 0, caughtUp: true })) };
    const boss = fakeBoss();
    const service = serviceWith(
      boss,
      ingest as unknown as ChzCodeStatusIngestService,
      refresh as unknown as ChzCodeStatusRefreshService,
    );
    await service.onModuleInit();
    const captured = boss.getRefreshChzCodeStatusesHandler();
    if (!captured) throw new Error("missing refresh-chz-code-statuses handler");
    handler = captured;
  });

  it("registers a scheduled queue for refresh-chz-code-statuses", async () => {
    // Registration itself already happened in `beforeEach` (the handler was
    // captured); this asserts the schedule was set up as a cron, unlike the
    // request-driven `run-chz-export` queue.
    expect(handler).toEqual(expect.any(Function));
  });

  it("ingests before refreshing, so codes scanned since the last pass are asked about", async () => {
    await seedTenantsWithChzChannel(["tenant-a"]);

    await handler();

    expect(ingest.run.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.run.mock.invocationCallOrder[0]!,
    );
  });

  it("runs once per tenant with the ChZ channel enabled", async () => {
    await seedTenantsWithChzChannel(["tenant-a", "tenant-b"]);
    await seedTenantWithoutChzChannel("tenant-c");

    await handler();

    expect(refresh.run.mock.calls.map(([id]) => id).sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(ingest.run.mock.calls.map(([id]) => id).sort()).toEqual(["tenant-a", "tenant-b"]);
  });

  it("keeps going when one tenant throws", async () => {
    await seedTenantsWithChzChannel(["tenant-a", "tenant-b"]);
    refresh.run.mockRejectedValueOnce(new Error("boom"));

    await expect(handler()).resolves.not.toThrow();

    expect(refresh.run).toHaveBeenCalledTimes(2);
  });
});
