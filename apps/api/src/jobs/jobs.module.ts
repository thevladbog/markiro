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

/**
 * Boots a dedicated pg-boss instance (its own `pgboss` schema, same
 * database as the app) and runs two independent schedules on it:
 *  - keeps the `codes`/`scan_events` monthly partitions ahead of traffic:
 *    ensures the current + next month exist once at startup, then again
 *    every day at 04:00 UTC.
 *  - prunes stale `kiosk_pair_attempts` rows (the kiosk-pairing rate
 *    limiter's fixed-window counters) once at startup, then again every
 *    hour, so an unauthenticated write path with no other cleanup doesn't
 *    grow the table forever.
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

      // Also run both once immediately at boot rather than waiting for the
      // first tick of either schedule.
      await this.runEnsurePartitions();
      await this.runPruneKioskPairAttempts();
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
}

@Module({})
export class JobsModule {
  /** `connectionString`: raw Postgres URL pg-boss uses for its own pool (separate from the app's Drizzle `Db`, which is injected globally via `AUTH`/`DB`'s `AuthModule`). */
  static forRoot(connectionString: string): DynamicModule {
    return {
      module: JobsModule,
      providers: [{ provide: PG_CONNECTION_STRING, useValue: connectionString }, PgBossService],
    };
  }
}
