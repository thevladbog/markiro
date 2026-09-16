import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { asc, eq } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { DeviceReplacementExecutionService } from "./device-replacement-execution.service";

/** Internal repair entrypoint. Retries committed intent; never creates a new cutover. */
@Injectable()
export class DeviceReplacementExecutionRepairService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly executions: DeviceReplacementExecutionService,
  ) {}
  repairExecution(tenantId: string, preparationId: string) {
    return this.executions.repairExecution(tenantId, preparationId);
  }
  async repairPending(limit = 100) {
    const rows = await this.db
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(eq(schema.workingDeviceReplacementExecutions.state, "executing"))
      .orderBy(asc(schema.workingDeviceReplacementExecutions.startedAt))
      .limit(Math.max(1, Math.min(100, limit)));
    const results = [];
    for (const row of rows) {
      try {
        await this.repairExecution(row.tenantId, row.preparationId);
        results.push({ executionId: row.id, status: "completed" as const });
      } catch {
        results.push({ executionId: row.id, status: "pending" as const });
      }
    }
    return results;
  }
}
