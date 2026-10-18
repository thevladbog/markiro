import { expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { PgBoss } from "pg-boss";
import { PlatformJobsService } from "../src/jobs/platform-jobs.service";
import { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import { PlatformReportRunnerService } from "../src/platform-reports/platform-report-runner.service";

const calls = vi.hoisted(() => ({ work: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("pg-boss", () => ({
  PgBoss: vi.fn(
    class {
      on = vi.fn();
      start = calls.start;
      stop = calls.stop;
      work = calls.work;
      createQueue = vi.fn();
      schedule = vi.fn();
      send = vi.fn();
    },
  ),
}));

it("bounds the platform queue pool and pins report execution to one job per process", async () => {
  calls.work.mockImplementation(async (name: string) => name);
  const module = await Test.createTestingModule({
    providers: [
      PlatformJobsService,
      { provide: "JOBS_PG_CONNECTION_STRING", useValue: "postgresql://unused/unused" },
      { provide: MailJobsService, useValue: { dispatchOutbox: vi.fn(), reconcile: vi.fn() } },
      { provide: MailRetentionService, useValue: { prune: vi.fn() } },
      { provide: SubscriptionStatusJob, useValue: { run: vi.fn() } },
      { provide: PlatformReportRunnerService, useValue: { reconcile: vi.fn() } },
    ],
  }).compile();
  try {
    await module.init();
    expect(vi.mocked(PgBoss).mock.calls[0]?.[0]).toMatchObject({
      max: 4,
      schema: "pgboss_platform",
    });
    expect(calls.work).toHaveBeenCalledWith(
      "platform-report-run",
      { batchSize: 1, localConcurrency: 1 },
      expect.any(Function),
    );
  } finally {
    await module.close();
  }
});
