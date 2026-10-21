import { expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { PgBoss } from "pg-boss";
import { PlatformJobsService } from "../src/jobs/platform-jobs.service";
import { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import { PlatformReportRunnerService } from "../src/platform-reports/platform-report-runner.service";
import { LandingLeadJobsService } from "../src/modules/landing-leads/landing-lead-jobs.service";

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

it.each([undefined, false, true])(
  "bounds the queue pool and honors preprovisioned schema opt-in: %s",
  async (preprovisioned) => {
    vi.mocked(PgBoss).mockClear();
    calls.work.mockImplementation(async (name: string) => name);
    const leads = {
      dispatchNotifications: vi.fn(),
      sendDailyDigest: vi.fn(),
      anonymizeStale: vi.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        PlatformJobsService,
        ...(preprovisioned === undefined
          ? []
          : [{ provide: "PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA", useValue: preprovisioned }]),
        { provide: "JOBS_PG_CONNECTION_STRING", useValue: "postgresql://unused/unused" },
        { provide: MailJobsService, useValue: { dispatchOutbox: vi.fn(), reconcile: vi.fn() } },
        { provide: MailRetentionService, useValue: { prune: vi.fn() } },
        { provide: SubscriptionStatusJob, useValue: { run: vi.fn() } },
        { provide: PlatformReportRunnerService, useValue: { reconcile: vi.fn() } },
        { provide: LandingLeadJobsService, useValue: leads },
      ],
    }).compile();
    try {
      await module.init();
      expect(vi.mocked(PgBoss).mock.calls[0]?.[0]).toMatchObject({
        max: 4,
        schema: "pgboss_platform",
        createSchema: preprovisioned !== true,
      });
      expect(calls.work).toHaveBeenCalledWith(
        "platform-report-run",
        { batchSize: 1, localConcurrency: 1 },
        expect.any(Function),
      );
      // Lead jobs are scheduled but never run by a (re)start: no unscheduled digest,
      // no early retention and no Telegram calls holding up readiness.
      for (const queue of [
        "dispatch-lead-notifications",
        "send-lead-digest",
        "anonymize-landing-leads",
      ]) {
        expect(calls.work).toHaveBeenCalledWith(queue, expect.any(Function));
      }
      expect(leads.dispatchNotifications).not.toHaveBeenCalled();
      expect(leads.sendDailyDigest).not.toHaveBeenCalled();
      expect(leads.anonymizeStale).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  },
);
