import type { JobsReadiness, PlatformReportQueue } from "./platform-jobs.contract";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PgBoss } from "pg-boss";
import {
  MailJobsService,
  SEND_EMAIL_DELIVERY_QUEUE,
  type MailQueue,
} from "../modules/mail/mail-jobs.service";
import { MailRetentionService } from "../modules/mail/mail-retention.service";
import {
  SubscriptionStatusJob,
  MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE,
  MATERIALIZE_SUBSCRIPTION_STATUSES_CRON,
} from "../subscriptions/subscription-status.job";
import { PlatformReportRunnerService } from "../platform-reports/platform-report-runner.service";
import { SupportChatJobsService } from "../modules/support-chat/support-chat-jobs.service";
import { SupportChatSyncService } from "../modules/support-chat/support-chat-sync.service";

/** Only platform intent tables are repaired. Restored pgboss cloud queues remain untouched. */
@Injectable()
export class PlatformJobsService
  implements OnModuleInit, OnModuleDestroy, JobsReadiness, PlatformReportQueue
{
  private boss: PgBoss | undefined;
  private started = false;
  private workerIds: string[] = [];
  private readonly logger = new Logger(PlatformJobsService.name);
  constructor(
    @Inject("JOBS_PG_CONNECTION_STRING") private readonly connectionString: string,
    private readonly mail: MailJobsService,
    private readonly retention: MailRetentionService,
    private readonly subscriptions: SubscriptionStatusJob,
    private readonly reports: PlatformReportRunnerService,
    @Optional() private readonly support?: SupportChatJobsService,
    @Optional() private readonly sync?: SupportChatSyncService,
    @Optional()
    @Inject("PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA")
    private readonly preprovisionedSchema = false,
  ) {}

  async onModuleInit(): Promise<void> {
    const boss = new PgBoss({
      connectionString: this.connectionString,
      schema: "pgboss_platform",
      // Compact deployments provision the queue schema separately. PostgreSQL
      // checks database CREATE even when CREATE SCHEMA IF NOT EXISTS finds it.
      createSchema: !this.preprovisionedSchema,
      // Separate from the shared API/auth pool; LISTEN uses one additional client.
      max: 4,
    });
    this.boss = boss;
    boss.on("error", () => this.logger.error("Platform queue error"));
    try {
      await boss.start();
      const queue: MailQueue = { send: (name, data, options) => boss.send(name, data, options) };
      await boss.createQueue(SEND_EMAIL_DELIVERY_QUEUE, {
        policy: "key_strict_fifo",
        retryLimit: 8,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 3600,
        expireInSeconds: 60,
        deleteAfterSeconds: 300,
      });
      this.workerIds.push(
        await boss.work<{ deliveryId: string }>(SEND_EMAIL_DELIVERY_QUEUE, async (jobs) => {
          for (const job of jobs) await this.mail.processDelivery(job.data.deliveryId);
        }),
      );
      const schedules: [string, string, () => Promise<unknown>][] = [
        ["dispatch-email-outbox", "* * * * *", () => this.mail.dispatchOutbox(queue)],
        ["reconcile-email-deliveries", "*/5 * * * *", () => this.mail.reconcile(queue)],
        ["prune-email-deliveries", "30 2 * * *", () => this.retention.prune()],
        [
          MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE,
          MATERIALIZE_SUBSCRIPTION_STATUSES_CRON,
          () => this.subscriptions.run(),
        ],
        [
          "platform-report-repair",
          "* * * * *",
          () =>
            this.reports.reconcile((reportId) =>
              boss.send("platform-report-run", { reportId }, { singletonKey: reportId }),
            ),
        ],
      ];
      await boss.createQueue("platform-report-run", {
        policy: "stately",
        retryLimit: 3,
        retryDelay: 60,
        expireInSeconds: 600,
      });
      this.workerIds.push(
        await boss.work<{ reportId: string }>(
          "platform-report-run",
          // Preserve today's defaults explicitly: only one memory-heavy renderer at a time.
          { batchSize: 1, localConcurrency: 1 },
          async (jobs) => {
            for (const job of jobs) await this.reports.run(job.data.reportId);
          },
        ),
      );
      const support = this.support;
      const sync = this.sync;
      if (support && sync) {
        await boss.createQueue("support-chat-import", { retryLimit: 0 });
        this.workerIds.push(
          await boss.work<{ jobId: string }>("support-chat-import", async (jobs) => {
            for (const job of jobs) await sync.run(job.data.jobId);
          }),
        );
        schedules.push([
          "support-chat-import-repair",
          "* * * * *",
          () => support.repairAndWake((jobId) => boss.send("support-chat-import", { jobId })),
        ]);
      }
      for (const [name, cron, run] of schedules) {
        await boss.createQueue(name);
        await boss.schedule(name, cron);
        this.workerIds.push(
          await boss.work(name, async () => {
            await run();
          }),
        );
      }
      // Startup repairs durable intent only; retention follows its daily schedule.
      // A first boot against restored history must not immediately prune it.
      for (const [name, , run] of schedules) {
        if (name !== "prune-email-deliveries") await run();
      }
      this.started = true;
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      this.boss = undefined;
      this.workerIds = [];
      throw error;
    }
  }
  async wakePlatformReports(): Promise<void> {
    if (!this.boss || !this.started) throw new Error("Platform queue unavailable");
    await this.boss.send("platform-report-repair", {});
  }
  async checkReady(): Promise<void> {
    if (!this.started || !this.boss) throw new Error("Platform queue unavailable");
    await this.boss.getDb().executeSql("SELECT 1");
    const expected = this.support && this.sync ? 9 : 7;
    const wip = this.boss.getWipData();
    if (
      this.workerIds.length !== expected ||
      new Set(this.workerIds).size !== expected ||
      this.workerIds.some(
        (id) =>
          !id || wip.filter((worker) => worker.id === id && worker.state === "active").length !== 1,
      )
    )
      throw new Error("Platform workers are not active");
  }
  async onModuleDestroy(): Promise<void> {
    this.started = false;
    await this.boss?.stop({ graceful: true });
    this.boss = undefined;
    this.workerIds = [];
  }
}
