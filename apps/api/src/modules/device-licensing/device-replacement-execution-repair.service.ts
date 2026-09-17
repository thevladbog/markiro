import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { DeviceReplacementExecutionService } from "./device-replacement-execution.service";

/** Internal repair entrypoint. Retries committed intent; never creates a new cutover. */
@Injectable()
export class DeviceReplacementExecutionRepairService implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(DeviceReplacementExecutionRepairService.name);
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  onModuleInit(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.tick(), 30_000);
    this.#timer.unref();
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
  }

  private tick(): void {
    if (this.#running || this.#stopped) return;
    this.#running = this.repairPending()
      .then(() => undefined)
      .catch(() => {
        this.#logger.error({ event: "device_replacement_repair_scan_failed" });
      })
      .finally(() => {
        this.#running = undefined;
      });
  }

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly executions: DeviceReplacementExecutionService,
  ) {}
  repairExecution(tenantId: string, preparationId: string) {
    return this.executions.repairExecution(tenantId, preparationId);
  }
  async repairPending(limit = 100) {
    const executions = schema.workingDeviceReplacementExecutions;
    const dueAt = sql<Date>`coalesce(${executions.nextRepairAt}, ${executions.startedAt})`;
    const rows = await this.db
      .select()
      .from(executions)
      .where(and(eq(executions.state, "executing"), lte(dueAt, new Date())))
      .orderBy(asc(dueAt), asc(executions.startedAt), asc(executions.id))
      .limit(Math.max(1, Math.min(100, limit)));
    const results = [];
    for (const row of rows) {
      try {
        await this.repairExecution(row.tenantId, row.preparationId);
        results.push({ executionId: row.id, status: "completed" as const });
        this.#logger.log({ event: "device_replacement_repair_completed", executionId: row.id });
      } catch {
        await this.executions.deferRepair(row);
        results.push({ executionId: row.id, status: "pending" as const });
        this.#logger.warn({ event: "device_replacement_repair_pending", executionId: row.id });
      }
    }
    return results;
  }
}
