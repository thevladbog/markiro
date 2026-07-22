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
import { ensurePartitions, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import { currentMonthUTC, nextMonthUTC } from "./months";

export const PG_CONNECTION_STRING = "JOBS_PG_CONNECTION_STRING";

const QUEUE_NAME = "ensure-partitions";
const QUEUE_CRON = "0 4 * * *";

/**
 * Boots a dedicated pg-boss instance (its own `pgboss` schema, same
 * database as the app) and keeps the `codes`/`scan_events` monthly
 * partitions ahead of traffic: ensures the current + next month exist once
 * at startup, then again every day at 04:00 UTC via a pg-boss schedule.
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

      // Also run once immediately at boot so this month's and next month's
      // partitions exist right away, instead of waiting for the first
      // 04:00 UTC tick.
      await this.runEnsurePartitions();
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
