import { createDb, schema, type Db } from "@markiro/db";
import { sql } from "drizzle-orm";
import { loadUsDevelopmentEnv } from "./entry-policy";
import { loadUsRequestBuildDescriptor } from "./us-request-build-descriptor";
import {
  UsRequestWorkerLoop,
  type UsWorkerDrainResult,
  type UsWorkerProcessEvent,
} from "./us-request-worker-loop";
import { loadUsRequestPackageArtifactStorageConfig } from "../modules/traceability/requests/us-request-package-artifact-config";
import {
  UsRequestPackageArtifactStore,
  type UsRequestPackageArtifactS3Transport,
} from "../modules/traceability/requests/us-request-package-artifacts";
import {
  UsPlanArtifactStore,
  type UsPlanArtifactS3Transport,
} from "../modules/traceability/plans/us-plan-artifacts";
import { UsRequestPlanReader } from "../modules/traceability/requests/us-request-plan-reader";
import { UsRequestWorkerLifecycle } from "../modules/traceability/requests/us-request-worker-lifecycle";
import { UsRequestWorkerCheckpoints } from "../modules/traceability/requests/us-request-worker-checkpoint";
import { UsRequestWorkerPublication } from "../modules/traceability/requests/us-request-worker-publication";
import { UsRequestWorkerCleanup } from "../modules/traceability/requests/us-request-worker-cleanup";
import { UsRequestWorker } from "../modules/traceability/requests/us-request-worker";
import { createUsRequestRuntimeExecutionIdentity } from "../modules/traceability/requests/us-request-worker-execution";

export type UsRequestWorkerRuntimeDependencies = Readonly<{
  connect?: typeof createDb;
  loadBuild?: typeof loadUsRequestBuildDescriptor;
  packageTransport?: UsRequestPackageArtifactS3Transport;
  planTransport?: UsPlanArtifactS3Transport;
  emit?: (event: UsWorkerProcessEvent) => void;
}>;
export type UsRequestWorkerRuntime = Readonly<{
  run(): Promise<void>;
  stop(): Promise<UsWorkerDrainResult>;
}>;
export class UsRequestWorkerStartupError extends Error {
  constructor(
    readonly code: "us_request_worker_startup_refused" | "us_request_worker_storage_unavailable",
  ) {
    super(code);
  }
}

function emitProcessEvent(event: UsWorkerProcessEvent): void {
  process.stdout.write(
    `${JSON.stringify({
      event: event.event,
      ...(event.kind === undefined ? {} : { kind: event.kind }),
      completedIterations: event.completedIterations,
    })}\n`,
  );
}

async function preflight(db: Db): Promise<void> {
  await db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
      // Select current schema columns, not just table existence. No payload rows
      // are read, claimed or repaired. Cleanup uses the object-intent fence columns.
      await tx.select().from(schema.traceRequests).limit(0);
      await tx.select().from(schema.traceExportRuns).limit(0);
      await tx.select().from(schema.traceExportAttempts).limit(0);
      await tx.select().from(schema.traceExportRenderCheckpoints).limit(0);
      await tx.select().from(schema.traceExportObjectIntents).limit(0);
      await tx.select().from(schema.traceExportArtifacts).limit(0);
      await tx.select().from(schema.traceExportRetryReceipts).limit(0);
      await tx.select().from(schema.traceabilityPlanVersions).limit(0);
    },
    { accessMode: "read only" },
  );
}

/** Trusted in-process seams only. The executable supplies no dependencies and
 * cannot select a test database, bypass the descriptor or start HTTP/Auth. */
export async function createUsRequestWorkerRuntime(
  raw: NodeJS.ProcessEnv,
  dependencies: UsRequestWorkerRuntimeDependencies = {},
): Promise<UsRequestWorkerRuntime> {
  let connection: ReturnType<typeof createDb> | undefined;
  let packageStore: UsRequestPackageArtifactStore | undefined;
  let planStore: UsPlanArtifactStore | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      let failed = false;
      try {
        packageStore?.destroy();
      } catch {
        failed = true;
      }
      try {
        planStore?.onModuleDestroy();
      } catch {
        failed = true;
      }
      try {
        await connection?.pool.end();
      } catch {
        failed = true;
      }
      if (failed) throw new Error("us_request_worker_disposal_failed");
    })();
    return disposal;
  };
  try {
    const env = loadUsDevelopmentEnv(raw);
    const packageConfig = loadUsRequestPackageArtifactStorageConfig(raw);
    if (!packageConfig)
      throw new UsRequestWorkerStartupError("us_request_worker_storage_unavailable");
    const descriptor = await (dependencies.loadBuild ?? loadUsRequestBuildDescriptor)(raw);
    const execution = createUsRequestRuntimeExecutionIdentity(descriptor, raw);
    connection = (dependencies.connect ?? createDb)(env.DATABASE_URL, {
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 15000,
    });
    let rejectDatabaseFailure: (error: Error) => void = () => {};
    const databaseFailure = new Promise<never>((_, reject) => {
      rejectDatabaseFailure = reject;
    });
    // Attach immediately: an idle pool error must never print a SQL/provider stack.
    void databaseFailure.catch(() => {});
    connection.pool.on("error", () => rejectDatabaseFailure(new Error("us_request_worker_fatal")));
    packageStore = new UsRequestPackageArtifactStore(packageConfig, dependencies.packageTransport);
    if (env.planArtifactStorage)
      planStore = new UsPlanArtifactStore(env.planArtifactStorage, dependencies.planTransport);
    await preflight(connection.db);
    const lifecycle = new UsRequestWorkerLifecycle(connection.db);
    const worker = new UsRequestWorker(connection.db, {
      lifecycle,
      checkpoints: new UsRequestWorkerCheckpoints(connection.db, lifecycle),
      publication: new UsRequestWorkerPublication(connection.db, lifecycle),
      cleanup: new UsRequestWorkerCleanup(connection.db, packageStore),
      planReader: new UsRequestPlanReader(connection.db, planStore ?? null),
      storage: packageStore,
      execution,
    });
    const loop = new UsRequestWorkerLoop({
      runOne: () => worker.runOne(),
      emit: dependencies.emit ?? emitProcessEvent,
    });
    let lifetime: Promise<void> | undefined;
    let drain: Promise<UsWorkerDrainResult> | undefined;
    return Object.freeze({
      run: () => {
        lifetime ??= Promise.race([loop.run(), databaseFailure]);
        return lifetime;
      },
      stop: () => {
        drain ??= loop.stop().then(async (result) => {
          // A forced drain is not proof the invocation settled. The executable
          // terminates the process; never close clients beneath pending work.
          if (result.kind === "graceful") await dispose();
          return result;
        });
        return drain;
      },
    });
  } catch (error) {
    try {
      await dispose();
    } catch {
      /* Startup diagnostics retain only their category. */
    }
    if (error instanceof UsRequestWorkerStartupError) throw error;
    throw new UsRequestWorkerStartupError("us_request_worker_startup_refused");
  }
}
