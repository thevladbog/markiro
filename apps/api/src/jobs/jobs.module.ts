import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PgBoss } from "pg-boss";
import { sql } from "drizzle-orm";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import { ExchangeSessionService } from "../modules/exchange/exchange-session.service";
import { JournalService } from "../modules/integrations/journal.service";
import { currentMonthUTC, nextMonthUTC } from "./months";

export const PG_CONNECTION_STRING = "JOBS_PG_CONNECTION_STRING";

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

/**
 * Boots a dedicated pg-boss instance (its own `pgboss` schema, same
 * database as the app) and runs five independent schedules on it:
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

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_CONNECTION_STRING) private readonly connectionString: string,
    private readonly journal: JournalService,
    private readonly exchangeSessions: ExchangeSessionService,
  ) {}

  async onModuleInit(): Promise<void> {
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
      await boss.work(QUEUE_NAME, async () => {
        await this.runEnsurePartitions();
      });

      await boss.createQueue(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME);
      await boss.schedule(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME, PRUNE_PAIR_ATTEMPTS_QUEUE_CRON);
      await boss.work(PRUNE_PAIR_ATTEMPTS_QUEUE_NAME, async () => {
        await this.runPruneKioskPairAttempts();
      });

      await boss.createQueue(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME);
      await boss.schedule(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME, PRUNE_EXCHANGE_ATTEMPTS_QUEUE_CRON);
      await boss.work(PRUNE_EXCHANGE_ATTEMPTS_QUEUE_NAME, async () => {
        await this.runPruneExchangeAttempts();
      });

      await boss.createQueue(SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME);
      await boss.schedule(
        SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME,
        SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_CRON,
      );
      await boss.work(SWEEP_EXPIRED_EXCHANGE_SESSIONS_QUEUE_NAME, async () => {
        await this.runSweepExpiredExchangeSessions();
      });

      await boss.createQueue(PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME);
      await boss.schedule(
        PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME,
        PRUNE_INTEGRATION_JOURNAL_QUEUE_CRON,
      );
      await boss.work(PRUNE_INTEGRATION_JOURNAL_QUEUE_NAME, async () => {
        await this.runPruneIntegrationJournal();
      });

      // Also run all five once immediately at boot rather than waiting for
      // the first tick of any schedule.
      await this.runEnsurePartitions();
      await this.runPruneKioskPairAttempts();
      await this.runPruneExchangeAttempts();
      await this.runSweepExpiredExchangeSessions();
      await this.runPruneIntegrationJournal();
    } catch (e) {
      // Bootstrap failed partway through: stop whatever pg-boss managed to
      // start so it doesn't leak a connection/maintenance loop, then
      // rethrow so Nest surfaces the original failure.
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw e;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.boss) return;
    await this.boss.stop();
    this.logger.log("pg-boss stopped");
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
}

@Module({})
export class JobsModule {
  /** `connectionString`: raw Postgres URL pg-boss uses for its own pool (separate from the app's Drizzle `Db`, which is injected globally via `AUTH`/`DB`'s `AuthModule`). */
  static forRoot(connectionString: string): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        { provide: PG_CONNECTION_STRING, useValue: connectionString },
        PgBossService,
        JournalService,
        ExchangeSessionService,
      ],
    };
  }
}
