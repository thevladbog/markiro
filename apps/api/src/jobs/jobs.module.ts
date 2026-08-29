import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import type { Env } from "../env";
import { ExchangeSessionService } from "../modules/exchange/exchange-session.service";
import { JournalService } from "../modules/integrations/journal.service";
import {
  MailJobsService,
  SEND_EMAIL_DELIVERY_QUEUE,
  type MailQueue,
} from "../modules/mail/mail-jobs.service";
import { MailModule } from "../modules/mail/mail.module";
import { MailRetentionService } from "../modules/mail/mail-retention.service";
import { ShiftExportRunnerService } from "../modules/shift-exports/shift-export-runner.service";
import { ShiftExportSourceService } from "../modules/shift-exports/shift-export-source.service";
import {
  SignerSchedulerService,
  type SignerScheduler,
} from "../modules/signer-agents/signer-scheduler.service";
import { ChzCryptoService } from "../modules/signer-agents/chz-crypto.service";
import {
  INVENTORY_DOCUMENT_GENERATOR_REGISTRY,
  InventoryDocumentRunnerService,
  productionInventoryDocumentGeneratorRegistry,
} from "../modules/inventories/inventory-document-runner.service";
import { InventoryResultSourceService } from "../modules/inventories/inventory-result-source.service";
import { InventoriesService } from "../modules/inventories/inventories.service";
import { InventorySnapshotService } from "../modules/inventories/inventory-snapshot.service";
import { ChzExportRunnerService } from "../modules/chz-exports/chz-export-runner.service";
import { ChzTokenService } from "../modules/chz-exports/chz-token.service";
import { TrueApiClient } from "../modules/chz-exports/true-api.client";
import { currentMonthUTC, nextMonthUTC } from "./months";
import {
  MATERIALIZE_SUBSCRIPTION_STATUSES_CRON,
  MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE,
  SubscriptionStatusJob,
} from "../subscriptions/subscription-status.job";

export const PG_CONNECTION_STRING = "JOBS_PG_CONNECTION_STRING";
export const BUILD_SHIFT_EXPORT_QUEUE = "build-shift-export";
export const BUILD_INVENTORY_DOCUMENT_QUEUE = "build-inventory-document-run";
export const RUN_CHZ_EXPORT_QUEUE = "run-chz-export";
/**
 * One pass per invocation, then re-enqueue: a dispenser task can take minutes,
 * and holding a pg-boss worker that long would starve the queue and lose
 * progress across a restart. 30 seconds keeps the batch results endpoint at two
 * requests per minute against its limit of twelve.
 */
const CHZ_EXPORT_POLL_INTERVAL_SECONDS = 30;
/**
 * Every `startAfter` re-enqueue below creates a brand-new pg-boss job, so
 * `job.retryCount`/`job.retryLimit` reset to zero each pass -- they bound
 * failures inside one invocation, never how many passes an order gets. The
 * runner has its own two caps (`chz_export_runs.attempts` for creation
 * attempts, a six-hour wall-clock deadline for `ordered`/`ready` runs), but
 * neither reaches an order whose six runs are all still `queued` for a tenant
 * whose token never becomes available: the deadline needs `orderedAt`, which
 * a `queued` run never gets, and `attempts` only increments on a claim, which
 * happens after the token check. Such an order would otherwise re-enqueue
 * forever.
 *
 * Carrying the pass count in the job payload instead closes that gap: it is
 * passed to the runner as `retryCount` against this cap as `retryLimit`, so
 * its existing "budget exhausted" branch (`giveUpOnToken`) finally has a
 * budget that advances across re-enqueues. At the 30-second poll interval
 * this is two hours of passes -- comfortably inside the runner's own
 * six-hour deadline for orders that did reach `ordered`, and a firm stop for
 * ones that never could.
 */
const MAX_EXPORT_PASSES = 240;

interface ChzExportJobData {
  tenantId: string;
  inventoryId: string;
  /** Defaults to 0: the initial enqueue from `ChzExportsService` omits it. */
  pass?: number;
}

/**
 * `MAX_EXPORT_PASSES` bounds one continuous chain of pg-boss jobs, not the
 * order itself: the count only ever lives in a job's payload, never in
 * Postgres against the order. pg-boss jobs, unlike that in-memory count, do
 * survive a restart on their own -- the previous chain's correctly-numbered
 * next-pass job is still sitting there, `created`, waiting out its
 * `startAfter` delay. Any code path that unconditionally sends a fresh job
 * for an order (the initial enqueue, and boot reconciliation below) would
 * otherwise race that survivor and, on every restart, hand the order a new
 * 240-pass budget instead of continuing the old one -- reopening exactly the
 * unbounded path the pass counter exists to close, for a tenant with no
 * valid token, every time the API restarts.
 *
 * Keying every send to `RUN_CHZ_EXPORT_QUEUE` on this makes a duplicate
 * impossible rather than detected after the fact: `RUN_CHZ_EXPORT_QUEUE`'s
 * `stately` policy (below) plus this key makes pg-boss itself refuse a
 * second `created` or `active` job for the same order (pg-boss v12
 * `dist/plans.js`'s `job_i3` unique index is on `(name, state,
 * coalesce(singleton_key, ''))` for states `created`/`retry`/`active`) --
 * `send` then resolves to `null` instead of inserting, which is a normal
 * dedup outcome here, not a failure. Keying on `state` as well as the order
 * is what lets the worker's own chain re-enqueue below use the same
 * mechanism without deadlocking on itself: the job doing the sending is
 * still `active` while its `created` successor is inserted, and those are
 * different states, so they never collide.
 *
 * That leaves one narrow gap `stately` cannot close: a restart landing in
 * the window where a pass is actually *running* (not waiting out
 * `startAfter`) finds no `created` row to conflict with, so reconciliation's
 * send can still start a second, pass-0 chain alongside the real one. That
 * is self-limiting rather than the original bug -- whichever of the two
 * chains re-enqueues its next `created` pass first wins the slot for that
 * order, and the other's next attempt hits the dedup above -- so a
 * mistimed restart can cost an order at most one extra pass, never a
 * repeatedly reset budget.
 */
function chzExportSingletonKey(tenantId: string, inventoryId: string): string {
  return `${tenantId}:${inventoryId}`;
}

const RUN_CHZ_EXPORT_QUEUE_POLICY = "stately";

/**
 * `boss.createQueue(RUN_CHZ_EXPORT_QUEUE, { policy: "stately", ... })` above
 * is a no-op the moment the queue row already exists: pg-boss v12's
 * `create_queue()` SQL function inserts with `ON CONFLICT DO NOTHING`, and
 * `updateQueue` has no support for changing an existing queue's `policy` at
 * all. Every job insert reads `policy` from the *current* `queue.policy` row
 * at send time, so a queue that was ever created under `standard` (pg-boss's
 * own default) silently keeps that policy forever, no matter what this file
 * asks for on later boots -- `chzExportSingletonKey` above is accepted on
 * every `send` but never deduplicated, with no error. This happened for real
 * on this repo's dev database on an earlier version of this branch.
 *
 * There is no safe automatic repair here: dropping and recreating the queue
 * row is only safe when it has no jobs (verified by hand for this repo's dev
 * database), and this boot path has no business making that judgment call or
 * deleting rows out from under in-flight export chains. The only environments
 * that can currently have the wrong policy are ones that already ran this
 * unreleased branch, so failing loudly here -- instead of quietly limping
 * along with a budget-reset bug this whole file exists to close -- costs
 * those environments one clear, actionable boot failure instead of costing
 * every environment a silent one.
 */
async function assertChzExportQueuePolicy(boss: PgBoss): Promise<void> {
  const { rows } = await boss
    .getDb()
    .executeSql("select policy from pgboss.queue where name = $1", [RUN_CHZ_EXPORT_QUEUE]);
  const actual = (rows[0] as { policy?: string } | undefined)?.policy;
  if (actual !== RUN_CHZ_EXPORT_QUEUE_POLICY) {
    throw new Error(
      `${RUN_CHZ_EXPORT_QUEUE} queue policy is "${actual ?? "unknown"}", expected ` +
        `"${RUN_CHZ_EXPORT_QUEUE_POLICY}". createQueue cannot change an existing queue's ` +
        `policy, so the export dedup (chzExportSingletonKey) is silently inert on this ` +
        `database. Fix by confirming the queue has no jobs, then running: ` +
        `delete from pgboss.queue where name = '${RUN_CHZ_EXPORT_QUEUE}'; -- createQueue ` +
        `will recreate it under the right policy on the next boot.`,
    );
  }
}

const QUEUE_NAME = "ensure-partitions";
const QUEUE_CRON = "0 4 * * *";

// Rows older than the kiosk-pairing rate limiter's 15-minute window are dead
// weight -- nothing ever reads them again -- but they're deleted an hour
// late rather than right at the window boundary so an in-flight request that
// started just before the boundary can't race the prune and read a
// half-deleted window.
const PRUNE_PAIR_ATTEMPTS_QUEUE_NAME = "prune-kiosk-pair-attempts";
const PRUNE_PAIR_ATTEMPTS_QUEUE_CRON = "0 * * * *";

// Same abandoned-mid-transfer concern as `kiosk_pair_attempts` above, but
// for `/1c_exchange`: `ExchangeSessionService.sweepExpired` (Task 6) already
// knows how to close a session whose TTL ran out and drop its chunks --
// nothing was ever wired to call it, so an interrupted CommerceML exchange
// left its `exchange_uploads` rows (and eventually its `integration_
// sessions` row too, once retention below catches it) forever. An hour
// matches the sessions' own `SESSION_TTL_MS`, same reasoning as
// `PRUNE_PAIR_ATTEMPTS_QUEUE_CRON`: no point checking more often than the
// window it enforces can even turn over.
const SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME = "sweep-expired-exchange-sessions";
const SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_CRON = "0 * * * *";

// Same unauthenticated-write concern as `kiosk_pair_attempts` above, but for
// `exchange_attempts` (exchange-credentials.ts's `assertUnderCheckauthLimit`):
// `checkauth` on `/1c_exchange` writes a row there before any credential is
// even checked, exactly like kiosk pairing does -- and Task 16 wired up
// hourly cleanup for the kiosk table but never for this one, its own twin,
// same shape, same reason (final review, Fix 5). Same hour-late margin as
// `PRUNE_PAIR_ATTEMPTS_QUEUE_CRON`: nothing ever reads a dead
// `CHECKAUTH_WINDOW_MS` window again, so there is no benefit to pruning
// closer to the boundary, only risk of racing an in-flight request.
const PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME = "prune-exchange-attempts";
const PRUNE_EXCHANGE_ATTEMPTS_QUEUE_CRON = "0 * * * *";

// `JournalService.prune` (Task 3) is the retention policy for
// `integration_sessions`/`integration_events` (спека §7: 90-day session
// summaries, 14-day item-grain detail) -- also written, also tested, also
// never called until now. Daily, not hourly: this trims a slow-growing
// audit trail, not a rate limiter's window, so there is no benefit to
// checking more often than once a day. Offset from `QUEUE_CRON`'s 04:00 so
// the two daily jobs don't contend for the same tick.
const PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME = "prune-integration-journal";
const PRUNE_INTEGRATION_JOURNAL_QUEUE_CRON = "0 3 * * *";

const DISPATCH_EMAIL_OUTBOX_QUEUE_NAME = "dispatch-email-outbox";
const DISPATCH_EMAIL_OUTBOX_QUEUE_CRON = "* * * * *";
const SHIFT_EXPORT_RECONCILE_LIMIT = 100;
const RECONCILE_EMAIL_DELIVERIES_QUEUE_NAME = "reconcile-email-deliveries";
const RECONCILE_EMAIL_DELIVERIES_QUEUE_CRON = "*/5 * * * *";
const PRUNE_EMAIL_DELIVERIES_QUEUE_NAME = "prune-email-deliveries";
const PRUNE_EMAIL_DELIVERIES_QUEUE_CRON = "30 2 * * *";

// `SignerSchedulerService` (Task 7) expires stale `chz_signer_tasks` and
// enqueues `true_api_auth` refresh tasks before a tenant's True API token
// runs out -- every 15 minutes so a 90-minute refresh lead window
// (`CHZ_TOKEN_REFRESH_LEAD_MS`) still leaves several ticks of slack even if
// one run is skipped.
const CHZ_SIGNER_SCHEDULER_QUEUE_NAME = "chz-signer-token-scheduler";
const CHZ_SIGNER_SCHEDULER_QUEUE_CRON = "*/15 * * * *";

/**
 * Boots a dedicated pg-boss instance (its own `pgboss` schema, same
 * database as the app), four request-driven workers, and ten schedules on it:
 *  - keeps the `codes`/`scan_events` monthly partitions ahead of traffic:
 *    ensures the current + next month exist once at startup, then again
 *    every day at 04:00 UTC.
 *  - prunes stale `kiosk_pair_attempts` rows (the kiosk-pairing rate
 *    limiter's fixed-window counters) once at startup, then again every
 *    hour, so an unauthenticated write path with no other cleanup doesn't
 *    grow the table forever.
 *  - prunes stale `exchange_attempts` rows (the `/1c_exchange` `checkauth`
 *    rate limiter's own fixed-window counters -- final review, Fix 5) on the
 *    same schedule and for the same reason as `kiosk_pair_attempts` above.
 *  - sweeps expired `/1c_exchange` sessions once at startup, then again
 *    every hour, closing them and dropping their uploaded chunks so an
 *    abandoned exchange doesn't leave binary rows around forever.
 *  - prunes the integrations journal once at startup, then again every day
 *    at 03:00 UTC, per the per-grain retention described on
 *    `JournalService.prune`.
 *  - dispatches the transactional email outbox every minute, reconciles lost
 *    or stale delivery jobs every five minutes, and applies mail retention
 *    daily at 02:30 UTC.
 *  - materializes subscription and add-on activation/expiry reporting status
 *    every minute while request-time entitlement checks remain authoritative.
 *  - expires stale `chz_signer_tasks` and enqueues True API token refresh
 *    tasks for tenants with an active signer agent, once at startup and
 *    then every 15 minutes (`SignerSchedulerService`, Task 7).
 *  - generates shift export artifacts on demand with bounded retries; this
 *    queue is deliberately not scheduled because export requests enqueue it.
 *  - generates inventory document artifacts on demand with the same bounded
 *    retry and boot-reconciliation guarantees.
 *  - orders and imports the six Chestny ZNAK code-status exports for an
 *    inventory on demand, one pass per invocation, re-enqueuing itself with a
 *    delay until every run is terminal or `MAX_EXPORT_PASSES` is reached.
 *
 * pg-boss v12 requires a queue to be created (`createQueue`) before it can
 * be scheduled or worked -- scheduling against a queue that doesn't exist
 * yet fails with a foreign-key error under the hood. Both `createQueue` and
 * `schedule` are idempotent (`ON CONFLICT DO NOTHING` / `DO UPDATE`
 * upsert respectively), so `start -> createQueue -> schedule -> work` is
 * safe to run on every boot.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossService.name);
  private boss?: PgBoss;
  private started = false;
  private workerIds: string[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_CONNECTION_STRING) private readonly connectionString: string,
    private readonly journal: JournalService,
    private readonly exchangeSessions: ExchangeSessionService,
    private readonly mailJobs: MailJobsService,
    private readonly mailRetention: MailRetentionService,
    private readonly subscriptionStatus: SubscriptionStatusJob,
    private readonly shiftExportRunner: ShiftExportRunnerService,
    private readonly inventoryDocumentRunner: InventoryDocumentRunnerService,
    @Inject(SignerSchedulerService) private readonly signerScheduler: SignerScheduler,
    private readonly chzExportRunner: ChzExportRunnerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.started = false;
    this.workerIds = [];
    const boss = new PgBoss(this.connectionString);
    // PgBoss extends EventEmitter; an "error" event with no listener throws
    // and crashes the process, so this must be registered before start().
    boss.on("error", (err) => this.logger.error(err));
    // Assign eagerly so onModuleDestroy can always reach this instance and
    // stop it, even if bootstrap fails partway through below.
    this.boss = boss;

    try {
      await boss.start();
      await boss.createQueue(QUEUE_NAME);
      await boss.schedule(QUEUE_NAME, QUEUE_CRON);
      this.workerIds.push(
        await boss.work(QUEUE_NAME, async () => {
          await this.runEnsurePartitions();
        }),
      );

      await boss.createQueue(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME);
      await boss.schedule(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME, PRUNE_PAIR_ATTEMPTS_QUEUE_CRON);
      this.workerIds.push(
        await boss.work(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME, async () => {
          await this.runPruneKioskPairAttempts();
        }),
      );

      await boss.createQueue(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME);
      await boss.schedule(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME, PRUNE_EXCHANGE_ATTEMPTS_QUEUE_CRON);
      this.workerIds.push(
        await boss.work(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME, async () => {
          await this.runPruneExchangeAttempts();
        }),
      );

      await boss.createQueue(SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME);
      await boss.schedule(
        SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME,
        SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_CRON,
      );
      this.workerIds.push(
        await boss.work(SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME, async () => {
          await this.runSweepExpiredExchangeSessions();
        }),
      );

      await boss.createQueue(PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME);
      await boss.schedule(
        PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME,
        PRUNE_INTEGRATION_JOURNAL_QUEUE_CRON,
      );
      this.workerIds.push(
        await boss.work(PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME, async () => {
          await this.runPruneIntegrationJournal();
        }),
      );

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
        await boss.work<{ deliveryId: string }>(
          SEND_EMAIL_DELIVERY_QUEUE,
          { includeMetadata: true },
          async (jobs) => {
            for (const job of jobs) await this.mailJobs.processDelivery(job.data.deliveryId);
          },
        ),
      );

      await boss.createQueue(DISPATCH_EMAIL_OUTBOX_QUEUE_NAME);
      await boss.schedule(DISPATCH_EMAIL_OUTBOX_QUEUE_NAME, DISPATCH_EMAIL_OUTBOX_QUEUE_CRON);
      this.workerIds.push(
        await boss.work(DISPATCH_EMAIL_OUTBOX_QUEUE_NAME, async () => {
          await this.mailJobs.dispatchOutbox(this.mailQueue(boss));
        }),
      );

      await boss.createQueue(RECONCILE_EMAIL_DELIVERIES_QUEUE_NAME);
      await boss.schedule(
        RECONCILE_EMAIL_DELIVERIES_QUEUE_NAME,
        RECONCILE_EMAIL_DELIVERIES_QUEUE_CRON,
      );
      this.workerIds.push(
        await boss.work(RECONCILE_EMAIL_DELIVERIES_QUEUE_NAME, async () => {
          await this.mailJobs.reconcile(this.mailQueue(boss));
        }),
      );

      await boss.createQueue(PRUNE_EMAIL_DELIVERIES_QUEUE_NAME);
      await boss.schedule(PRUNE_EMAIL_DELIVERIES_QUEUE_NAME, PRUNE_EMAIL_DELIVERIES_QUEUE_CRON);
      this.workerIds.push(
        await boss.work(PRUNE_EMAIL_DELIVERIES_QUEUE_NAME, async () => {
          await this.mailRetention.prune();
        }),
      );

      await boss.createQueue(MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE);
      await boss.schedule(
        MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE,
        MATERIALIZE_SUBSCRIPTION_STATUSES_CRON,
      );
      this.workerIds.push(
        await boss.work(MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE, async () => {
          await this.subscriptionStatus.run();
        }),
      );

      await boss.createQueue(BUILD_SHIFT_EXPORT_QUEUE, {
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 900,
        expireInSeconds: 900,
      });
      this.workerIds.push(
        await boss.work(
          BUILD_SHIFT_EXPORT_QUEUE,
          { includeMetadata: true },
          async (jobs: JobWithMetadata<{ exportId: string }>[]) => {
            for (const job of jobs) {
              await this.shiftExportRunner.run(job.data.exportId, {
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
              });
            }
          },
        ),
      );
      await this.reconcileQueuedShiftExports(boss);

      await boss.createQueue(BUILD_INVENTORY_DOCUMENT_QUEUE, {
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 900,
        expireInSeconds: 900,
      });
      this.workerIds.push(
        await boss.work(
          BUILD_INVENTORY_DOCUMENT_QUEUE,
          { includeMetadata: true },
          async (jobs: JobWithMetadata<{ runId: string }>[]) => {
            for (const job of jobs) {
              await this.inventoryDocumentRunner.run(job.data.runId, {
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
              });
            }
          },
        ),
      );
      await this.reconcileQueuedInventoryDocumentRuns(boss);

      await boss.createQueue(CHZ_SIGNER_SCHEDULER_QUEUE_NAME);
      await boss.schedule(CHZ_SIGNER_SCHEDULER_QUEUE_NAME, CHZ_SIGNER_SCHEDULER_QUEUE_CRON);
      this.workerIds.push(
        await boss.work(CHZ_SIGNER_SCHEDULER_QUEUE_NAME, async () => {
          await this.signerScheduler.run();
        }),
      );

      await boss.createQueue(RUN_CHZ_EXPORT_QUEUE, {
        // See `chzExportSingletonKey` above for why this policy plus a
        // per-order key is what makes a duplicate chain impossible instead
        // of merely detected. The constant is shared with
        // `assertChzExportQueuePolicy` on purpose: two literals that happened
        // to agree would let one drift and leave the assertion checking a
        // policy nothing sets.
        policy: RUN_CHZ_EXPORT_QUEUE_POLICY,
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 900,
        expireInSeconds: 900,
      });
      // `createQueue` above is a no-op if this queue already existed under a
      // different policy -- see `assertChzExportQueuePolicy` for why that
      // makes the dedup above silently inert instead of merely absent.
      await assertChzExportQueuePolicy(boss);
      this.workerIds.push(
        await boss.work(
          RUN_CHZ_EXPORT_QUEUE,
          { includeMetadata: true },
          async (jobs: JobWithMetadata<ChzExportJobData>[]) => {
            for (const job of jobs) {
              const pass = job.data.pass ?? 0;
              let finished: boolean;
              try {
                ({ finished } = await this.chzExportRunner.run(
                  job.data.tenantId,
                  job.data.inventoryId,
                  { retryCount: pass, retryLimit: MAX_EXPORT_PASSES },
                ));
              } catch (error) {
                // `run()` rethrows anything that is not a `ChzUnauthorizedError`.
                // A throw makes pg-boss retry the *job* itself (this queue's own
                // `retryLimit: 5`), and no `startAfter` successor is ever sent
                // for a thrown pass -- so once the job's own retry budget is
                // spent (`job.retryCount >= job.retryLimit`, i.e. this was the
                // last attempt pg-boss will ever make), nothing would advance
                // this order again: it would sit non-terminal with no operator
                // recovery (`ChzExportsService.retry()` requires `state =
                // "failed"`), reachable again only by boot reconciliation
                // (capped at `SHIFT_EXPORT_RECONCILE_LIMIT` orders per boot).
                // Failing the remaining runs here closes that gap instead of
                // letting the job die silently. A retryable attempt (budget not
                // yet spent) rethrows unchanged so pg-boss's own retry/backoff
                // still applies exactly as before.
                if (job.retryCount < job.retryLimit) throw error;
                this.logger.error(
                  `ChZ export pass permanently failed for tenant ${job.data.tenantId} ` +
                    `inventory ${job.data.inventoryId} after ${job.retryCount} job retries; ` +
                    `failing remaining runs`,
                  error instanceof Error ? error.stack : undefined,
                );
                await this.chzExportRunner.abandonAfterJobRetriesExhausted(
                  job.data.tenantId,
                  job.data.inventoryId,
                );
                continue;
              }
              if (!finished) {
                // A `null` return here would mean another `created` job for
                // this order already exists (see `chzExportSingletonKey`) --
                // possible only in the narrow restart-during-an-active-pass
                // gap described there -- and is harmless to ignore: it means
                // some chain already holds the next-pass slot for this
                // order, so this invocation doesn't need to.
                await boss.send(
                  RUN_CHZ_EXPORT_QUEUE,
                  {
                    tenantId: job.data.tenantId,
                    inventoryId: job.data.inventoryId,
                    pass: pass + 1,
                  },
                  {
                    startAfter: CHZ_EXPORT_POLL_INTERVAL_SECONDS,
                    singletonKey: chzExportSingletonKey(job.data.tenantId, job.data.inventoryId),
                  },
                );
              }
            }
          },
        ),
      );
      await this.reconcileUnfinishedChzExports(boss);

      // Also run all ten maintenance paths once immediately at boot rather
      // than waiting for the first tick of any schedule.
      await this.runEnsurePartitions();
      await this.runPruneKioskPairAttempts();
      await this.runPruneExchangeAttempts();
      await this.runSweepExpiredExchangeSessions();
      await this.runPruneIntegrationJournal();
      await this.mailJobs.dispatchOutbox(this.mailQueue(boss));
      await this.mailJobs.reconcile(this.mailQueue(boss));
      await this.mailRetention.prune();
      await this.subscriptionStatus.run();
      await this.signerScheduler.run();
      this.started = true;
    } catch (e) {
      // Bootstrap failed partway through: stop whatever pg-boss managed to
      // start so it doesn't leak a connection/maintenance loop, then
      // rethrow so Nest surfaces the original failure.
      this.started = false;
      this.workerIds = [];
      await boss.stop({ graceful: false }).catch(() => undefined);
      delete this.boss;
      throw e;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.started = false;
    this.workerIds = [];
    const boss = this.boss;
    delete this.boss;
    if (!boss) return;
    await boss.stop();
    this.logger.log("pg-boss stopped");
  }

  async enqueueShiftExport(exportId: string): Promise<string> {
    if (!this.boss || !this.started) throw new Error("pg-boss is not started");
    const jobId = await this.boss.send(BUILD_SHIFT_EXPORT_QUEUE, { exportId });
    if (!jobId) throw new Error("shift export enqueue failed");
    return jobId;
  }

  async enqueueInventoryDocumentRun(runId: string): Promise<string> {
    if (!this.boss || !this.started) throw new Error("pg-boss is not started");
    const jobId = await this.boss.send(BUILD_INVENTORY_DOCUMENT_QUEUE, { runId });
    if (!jobId) throw new Error("inventory document run enqueue failed");
    return jobId;
  }

  /**
   * `pass` is omitted here, defaulting to 0 in the worker: this is always the
   * first pass an order gets, whether it comes from `ChzExportsService.order`
   * or `.retry` (Task 4) or from boot reconciliation below.
   *
   * A `null` return means pg-boss deduped this against an already-pending
   * job for the same order (see `chzExportSingletonKey`) -- e.g. `.order`/
   * `.retry` called again while a chain is already running -- which is not a
   * failure: both current call sites discard the id and only care that a
   * chain is in flight, which it already is.
   */
  async enqueueChzExportOrder(tenantId: string, inventoryId: string): Promise<string | null> {
    if (!this.boss || !this.started) throw new Error("pg-boss is not started");
    return this.boss.send(
      RUN_CHZ_EXPORT_QUEUE,
      { tenantId, inventoryId },
      { singletonKey: chzExportSingletonKey(tenantId, inventoryId) },
    );
  }

  private async reconcileQueuedShiftExports(boss: PgBoss): Promise<void> {
    let queued: { id: string }[];
    try {
      queued = await this.db
        .select({ id: schema.shiftExports.id })
        .from(schema.shiftExports)
        .where(eq(schema.shiftExports.status, "queued"))
        .orderBy(asc(schema.shiftExports.createdAt))
        .limit(SHIFT_EXPORT_RECONCILE_LIMIT);
    } catch (error) {
      this.logger.error(
        "shift export reconciliation query failed",
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }
    for (const row of queued) {
      try {
        const jobId = await boss.send(BUILD_SHIFT_EXPORT_QUEUE, { exportId: row.id });
        if (!jobId) throw new Error("shift export enqueue returned no job id");
      } catch (error) {
        this.logger.error(
          `shift export reconciliation failed for ${row.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async reconcileQueuedInventoryDocumentRuns(boss: PgBoss): Promise<void> {
    let queued: { id: string }[];
    try {
      queued = await this.db
        .select({ id: schema.inventoryDocumentRuns.id })
        .from(schema.inventoryDocumentRuns)
        .where(eq(schema.inventoryDocumentRuns.status, "queued"))
        .orderBy(asc(schema.inventoryDocumentRuns.createdAt))
        .limit(SHIFT_EXPORT_RECONCILE_LIMIT);
    } catch (error) {
      this.logger.error(
        "inventory document reconciliation query failed",
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }
    for (const row of queued) {
      try {
        const jobId = await boss.send(BUILD_INVENTORY_DOCUMENT_QUEUE, { runId: row.id });
        if (!jobId) throw new Error("inventory document enqueue returned no job id");
      } catch (error) {
        this.logger.error(
          `inventory document reconciliation failed for ${row.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Distinct `(tenantId, inventoryId)` pairs, not runs: one boot job per
   * order, exactly matching what `enqueueChzExportOrder` sends, since the
   * runner's `run` already re-checks all six of an order's runs on every
   * pass -- one job per run would just be five wasted enqueues per order.
   *
   * This is exactly the send site `chzExportSingletonKey` exists to guard:
   * pg-boss jobs survive a restart on their own, so an order's previous
   * chain is typically still sitting there, `created`. Sending unconditionally
   * here (with no `pass`, always defaulting to 0) would otherwise race that
   * survivor and, on every restart, hand the order a fresh 240-pass budget.
   * A `null` return below means pg-boss deduped this against that survivor,
   * which is the expected outcome, not a failure -- see `chzExportSingletonKey`
   * for the one narrow case this can't catch and why it's self-limiting.
   */
  private async reconcileUnfinishedChzExports(boss: PgBoss): Promise<void> {
    let queued: { tenantId: string; inventoryId: string }[];
    try {
      queued = await this.db
        .select({
          tenantId: schema.chzExportRuns.tenantId,
          inventoryId: schema.chzExportRuns.inventoryId,
        })
        .from(schema.chzExportRuns)
        .where(inArray(schema.chzExportRuns.state, ["queued", "ordered", "ready"]))
        .groupBy(schema.chzExportRuns.tenantId, schema.chzExportRuns.inventoryId)
        .orderBy(sql`min(${schema.chzExportRuns.createdAt})`)
        .limit(SHIFT_EXPORT_RECONCILE_LIMIT);
    } catch (error) {
      this.logger.error(
        "chz export reconciliation query failed",
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }
    for (const row of queued) {
      try {
        const jobId = await boss.send(
          RUN_CHZ_EXPORT_QUEUE,
          { tenantId: row.tenantId, inventoryId: row.inventoryId },
          { singletonKey: chzExportSingletonKey(row.tenantId, row.inventoryId) },
        );
        if (jobId === null) {
          this.logger.log(
            `chz export reconciliation skipped for tenant ${row.tenantId} inventory ${row.inventoryId}: a chain is already pending`,
          );
        }
      } catch (error) {
        this.logger.error(
          `chz export reconciliation failed for tenant ${row.tenantId} inventory ${row.inventoryId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  async checkReady(): Promise<void> {
    if (!this.started || !this.boss) throw new Error("pg-boss is not started");
    try {
      await this.boss.getDb().executeSql("SELECT 1");
    } catch {
      throw new Error("pg-boss database probe failed");
    }
    if (
      this.workerIds.length !== 14 ||
      this.workerIds.some((id) => id.length === 0) ||
      new Set(this.workerIds).size !== this.workerIds.length
    ) {
      throw new Error("pg-boss workers are not active");
    }
    const wip = this.boss.getWipData();
    const workersActive = this.workerIds.every((id) => {
      const matches = wip.filter((worker) => worker.id === id);
      return matches.length === 1 && matches[0]?.state === "active";
    });
    if (!workersActive) throw new Error("pg-boss workers are not active");
  }

  private async runEnsurePartitions(): Promise<void> {
    const created = await ensurePartitions(this.db, [currentMonthUTC(), nextMonthUTC()]);
    this.logger.log(
      created.length > 0
        ? `Ensured partitions: ${created.join(", ")}`
        : "Partitions already present for current and next month",
    );
  }

  /** Deletes `kiosk_pair_attempts` rows whose fixed window ended over an hour ago. */
  private async runPruneKioskPairAttempts(): Promise<void> {
    // No `.returning()`: this is a maintenance job that only needs a count
    // for the log line, so materialising every pruned row's id would be pure
    // overhead. The node-postgres driver reports the row count directly on
    // the query result (`rowCount`) without it.
    const result = await this.db
      .delete(schema.kioskPairAttempts)
      .where(sql`${schema.kioskPairAttempts.windowStartedAt} < now() - interval '1 hour'`);
    const count = result.rowCount ?? 0;
    this.logger.log(
      count > 0
        ? `Pruned ${count} stale kiosk_pair_attempts row(s)`
        : "No stale kiosk_pair_attempts rows to prune",
    );
  }

  /**
   * Deletes `exchange_attempts` rows whose fixed window ended over an hour
   * ago -- `/1c_exchange`'s `checkauth` rate limiter's own twin of
   * `runPruneKioskPairAttempts` above (final review, Fix 5). Same "an hour
   * late" reasoning: nothing ever reads a window again once it's over, and
   * pruning right at the boundary would race an in-flight `checkauth` call.
   */
  private async runPruneExchangeAttempts(): Promise<void> {
    const result = await this.db
      .delete(schema.exchangeAttempts)
      .where(sql`${schema.exchangeAttempts.windowStartedAt} < now() - interval '1 hour'`);
    const count = result.rowCount ?? 0;
    this.logger.log(
      count > 0
        ? `Pruned ${count} stale exchange_attempts row(s)`
        : "No stale exchange_attempts rows to prune",
    );
  }

  /**
   * Closes `/1c_exchange` sessions whose TTL ran out and drops their
   * uploaded chunks. See `ExchangeSessionService.sweepExpired`'s own
   * comment for why this can't just be folded into `finishSession`'s call
   * sites: the protocol has no explicit goodbye, so only running out of
   * time (this job) ever ends an abandoned session.
   */
  private async runSweepExpiredExchangeSessions(): Promise<void> {
    await this.exchangeSessions.sweepExpired(new Date());
    this.logger.log("Swept expired /1c_exchange sessions");
  }

  /**
   * Applies the integrations journal's per-grain retention (session
   * summaries 90 days, item-grain detail 14 -- see `JournalService.prune`).
   */
  private async runPruneIntegrationJournal(): Promise<void> {
    await this.journal.prune(new Date());
    this.logger.log("Pruned integrations journal");
  }

  private mailQueue(boss: PgBoss): MailQueue {
    return {
      send: (name, data, options) => boss.send(name, data, options),
    };
  }
}

@Global()
@Module({})
export class JobsModule {
  /** `connectionString`: raw Postgres URL pg-boss uses for its own pool (separate from the app's Drizzle `Db`, which is injected globally via `AUTH`/`DB`'s `AuthModule`). */
  static forRoot(connectionString: string, env: Env): DynamicModule {
    return {
      module: JobsModule,
      imports: [MailModule.forRoot(env)],
      providers: [
        { provide: PG_CONNECTION_STRING, useValue: connectionString },
        PgBossService,
        JournalService,
        ExchangeSessionService,
        ShiftExportSourceService,
        ShiftExportRunnerService,
        InventoryResultSourceService,
        {
          provide: INVENTORY_DOCUMENT_GENERATOR_REGISTRY,
          useValue: productionInventoryDocumentGeneratorRegistry,
        },
        InventoryDocumentRunnerService,
        {
          // Same construction as `SignerAgentsModule.forRoot`: `SignerSchedulerService`
          // (this module) needs its own `ChzCryptoService` instance to check whether
          // `CHZ_TOKEN_ENCRYPTION_KEY` is configured before enqueueing refresh tasks
          // (final review, Finding A) -- `SignerAgentsModule`'s export isn't reachable
          // here without a circular import between it and `JobsModule`.
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
        SignerSchedulerService,
        // `ChzExportRunnerService` (this module's `run-chz-export` worker) needs its
        // own `InventoriesService`/`InventorySnapshotService` and True API stack for
        // the same reason `ChzCryptoService` above gets its own factory instead of
        // importing `ChzExportsModule`: that module's `ChzExportsService` needs
        // `PgBossService`, which lives here, so importing it back would be
        // circular. `ChzCryptoService` above is reused rather than duplicated again
        // since both consumers live in this same `forRoot` call.
        InventorySnapshotService,
        InventoriesService,
        // `TrueApiClient`'s constructor parameter is typed as an interface
        // (`TrueApiClientDependencies`), which TypeScript erases to `Object`
        // in `design:paramtypes` -- registering the bare class makes Nest try
        // to resolve a provider for `Object` and fail. A factory sidesteps
        // constructor injection and just takes the class's own default (the
        // real `fetch`).
        { provide: TrueApiClient, useFactory: () => new TrueApiClient() },
        ChzTokenService,
        ChzExportRunnerService,
      ],
      exports: [PgBossService, INVENTORY_DOCUMENT_GENERATOR_REGISTRY],
    };
  }
}
