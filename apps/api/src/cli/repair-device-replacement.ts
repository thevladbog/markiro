import { createDb } from "@markiro/db";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { loadEnv } from "../env";
import { DeviceReplacementExecutionService } from "../modules/device-licensing/device-replacement-execution.service";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";
import { EntitlementsService } from "../subscriptions/entitlements.service";

interface CliStream {
  write(value: string): unknown;
}

/** Trusted maintenance host only; resumes a committed intent and preserves its original actor. */
export async function runReplacementRepairCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    const [tenantId, preparationId] = options.argv;
    if (
      options.argv.length !== 2 ||
      !tenantId?.trim() ||
      !platformUuidSchema.safeParse(preparationId).success ||
      !preparationId
    )
      throw new Error("Expected tenant and preparation identity");
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const service = new DeviceReplacementExecutionService(
        db,
        new EntitlementsService(db, env.SUBSCRIPTION_ENFORCEMENT_MODE),
        new PlatformAuditService(),
      );
      const receipt = await service.repairExecution(tenantId, preparationId);
      const execution = receipt.preparation.execution;
      if (!execution || receipt.preparation.state !== "completed")
        throw new Error("Incomplete execution");
      (options.stdout ?? process.stdout).write(
        `${JSON.stringify({ executionId: execution.id, targetDeviceId: execution.targetDeviceId, status: "completed" })}\n`,
      );
    } finally {
      await pool.end();
    }
    return 0;
  } catch {
    (options.stderr ?? process.stderr).write(
      "Device replacement repair failed; verify arguments, database access and execution state.\n",
    );
    return 1;
  }
}

if (require.main === module) {
  void runReplacementRepairCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
