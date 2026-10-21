import {
  UsDatasetCompleteSeedStore,
  type UsDatasetCompleteSeedResult,
} from "../modules/traceability/demo/us-dataset-complete-seed";
import { usSixMonthDefinition } from "../modules/traceability/demo/us-six-month-definition";
import { datasetCommandEnvironment } from "./us-dataset-command";
import { loadUsRequestBuildDescriptor } from "./us-request-build-descriptor";
import { createUsRequestRuntimeExecutionIdentity } from "../modules/traceability/requests/us-request-worker-execution";
import { createDb, schema, type Db } from "@markiro/db";
import {
  UsPlanArtifactStore,
  type UsPlanArtifactS3Transport,
} from "../modules/traceability/plans/us-plan-artifacts";
import {
  UsRequestPackageArtifactStore,
  type UsRequestPackageArtifactS3Transport,
} from "../modules/traceability/requests/us-request-package-artifacts";
import { sql } from "drizzle-orm";
import type { UsDatasetContext } from "../modules/traceability/demo/us-dataset-contract";
import { assertUsDemoTarget } from "../modules/traceability/demo/us-demo-target";

export async function assertUsDatasetCommandPreflight(
  db: Db,
  context: UsDatasetContext,
): Promise<void> {
  await db.transaction(
    async (tx) => {
      const actual = await tx.execute<{ name: string; owner: string }>(
        sql`SELECT current_database() AS name, current_user AS owner`,
      );
      if (
        actual.rows.length !== 1 ||
        actual.rows[0]?.name !== "markiro_us_dev" ||
        actual.rows[0]?.owner !== "markiro_us"
      )
        throw new Error("us_dataset_command_target_invalid");
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
      try {
        // Select every current column, without loading business records or repairing schema.
        for (const table of [
          schema.organization,
          schema.user,
          schema.member,
          schema.account,
          schema.tenantAuditEvents,
          schema.traceabilityProfiles,
          schema.orgProfiles,
          schema.traceabilityDemoSeeds,
          schema.traceabilityDemoDatasets,
          schema.traceabilityDemoDatasetStages,
          schema.traceabilityParties,
          schema.traceabilityLocations,
          schema.products,
          schema.productTraceabilityProfiles,
          schema.referenceDocuments,
          schema.receivingEventRoots,
          schema.transformationEventRoots,
          schema.shippingEventRoots,
          schema.traceabilityEvents,
          schema.traceabilityLots,
          schema.boxes,
          schema.traceLotBoxes,
          schema.traceabilitySyntheticCaseOrigins,
          schema.traceabilityPlanVersions,
          schema.traceRequests,
          schema.traceExportRuns,
          schema.traceExportAttempts,
          schema.traceExportRenderCheckpoints,
          schema.traceExportObjectIntents,
          schema.traceExportArtifacts,
          schema.traceExportRetryReceipts,
        ] as const)
          await tx.select().from(table).limit(0);
      } catch (cause) {
        throw new Error("us_dataset_command_schema_invalid", { cause });
      }
      try {
        await assertUsDemoTarget(tx, db, context, () => {
          throw new Error("us_dataset_command_prerequisite_invalid");
        });
      } catch (cause) {
        throw new Error("us_dataset_command_prerequisite_invalid", { cause });
      }
    },
    { isolationLevel: "repeatable read" },
  );
  // Provenance/profile readers require FOR SHARE; READ ONLY would reject their locks.
}

/** Trusted external I/O seams only; the executable supplies no overrides. */
export async function runUsDatasetCommand(
  args: readonly string[],
  raw: NodeJS.ProcessEnv,
  dependencies: Readonly<{
    connect?: typeof createDb;
    loadBuild?: typeof loadUsRequestBuildDescriptor;
    planTransport?: UsPlanArtifactS3Transport;
    packageTransport?: UsRequestPackageArtifactS3Transport;
  }> = {},
): Promise<UsDatasetCompleteSeedResult> {
  // Capture once: a caller cannot retarget configuration while build I/O awaits.
  const source = Object.freeze({ ...raw });
  const command = datasetCommandEnvironment(args, source);
  let execution: ReturnType<typeof createUsRequestRuntimeExecutionIdentity>;
  try {
    const descriptor = await (dependencies.loadBuild ?? loadUsRequestBuildDescriptor)(source);
    execution = createUsRequestRuntimeExecutionIdentity(descriptor, source);
  } catch (cause) {
    throw new Error("us_dataset_command_build_invalid", { cause });
  }
  let connection: ReturnType<typeof createDb> | undefined;
  let packages: UsRequestPackageArtifactStore | undefined;
  let plans: UsPlanArtifactStore | undefined;
  let poolFailure: Error | undefined;
  let result: UsDatasetCompleteSeedResult | undefined;
  let failed = false;
  let failure: unknown;
  try {
    try {
      connection = (dependencies.connect ?? createDb)(command.env.DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
        statement_timeout: 15000,
      });
      // Observe idle pool failures immediately, without racing/closing pending work.
      connection.pool.on("error", (error: Error) => {
        poolFailure ??= error;
      });
    } catch (cause) {
      throw new Error("us_dataset_command_connection_failed", { cause });
    }
    try {
      packages = new UsRequestPackageArtifactStore(
        command.packageStorage,
        dependencies.packageTransport,
      );
      plans = new UsPlanArtifactStore(command.planStorage, dependencies.planTransport);
    } catch (cause) {
      throw new Error("us_dataset_command_storage_unavailable", { cause });
    }
    await assertUsDatasetCommandPreflight(connection.db, command.context);
    if (poolFailure) throw poolFailure;
    // A single concrete complete owner; no general worker, seed/proof injection or subset.
    const owner = new UsDatasetCompleteSeedStore(connection.db, {
      planArtifacts: plans,
      packageArtifacts: packages,
      execution,
    });
    result = await owner[command.mode](command.context);
  } catch (error) {
    failed = true;
    failure = error;
  }
  // All work above has settled before either client's destroy or pool.end.
  const disposalErrors: unknown[] = [];
  try {
    packages?.destroy();
  } catch (error) {
    disposalErrors.push(error);
  }
  try {
    plans?.onModuleDestroy();
  } catch (error) {
    disposalErrors.push(error);
  }
  try {
    await connection?.pool.end();
  } catch (error) {
    disposalErrors.push(error);
  }
  if (disposalErrors.length)
    throw new Error("us_dataset_command_disposal_failed", {
      cause: new AggregateError([
        ...(failed ? [failure] : []),
        ...(poolFailure ? [poolFailure] : []),
        ...disposalErrors,
      ]),
    });
  if (poolFailure)
    throw new Error("us_dataset_command_connection_failed", {
      cause: new AggregateError([...(failed ? [failure] : []), poolFailure]),
    });
  if (failed) throw failure;
  if (!result) throw new Error("us_dataset_command_failed");
  return result;
}

const categories = new Set([
  "us_dataset_command_arguments_invalid",
  "us_dataset_command_environment_invalid",
  "us_dataset_command_storage_unavailable",
  "us_dataset_command_build_invalid",
  "us_dataset_command_connection_failed",
  "us_dataset_command_target_invalid",
  "us_dataset_command_schema_invalid",
  "us_dataset_command_prerequisite_invalid",
  "us_dataset_command_disposal_failed",
]);

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}

/** No raw error/SQL/provider message, getter or inherited metadata reaches stdout/stderr. */
export function usDatasetCommandDiagnostic(error: unknown): Readonly<{
  code: string;
  unitKey?: string;
  stage?: string;
}> {
  try {
    const message = ownValue(error, "message");
    const code =
      typeof message === "string" && categories.has(message)
        ? message
        : "us_dataset_command_failed";
    const seen = new Set<object>();
    for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 32; depth++) {
      if (seen.has(cause)) break;
      seen.add(cause);
      const unitKey = ownValue(cause, "unitKey");
      const stage = ownValue(cause, "stage");
      const unit = usSixMonthDefinition.units.find((value) => value.key === unitKey);
      if (unit && unit.stages.some((value) => value === stage))
        return { code, unitKey: unit.key, stage: String(stage) };
      cause = ownValue(cause, "cause");
    }
    return { code };
  } catch {
    return { code: "us_dataset_command_failed" };
  }
}
