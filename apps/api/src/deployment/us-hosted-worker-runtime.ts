import { schema, type Db } from "@markiro/db";
import type { createDb } from "@markiro/db";
import { sql } from "drizzle-orm";
import {
  UsRequestWorkerLoop,
  type UsWorkerDrainResult,
  type UsWorkerProcessEvent,
} from "./us-request-worker-loop";
import {
  verifyUsHostedRelease,
  disposeUsHostedRelease,
  type VerifiedUsHostedRelease,
} from "./us-hosted-release-verifier";
import {
  collectUsHostedMaterial,
  disposeUsHostedMaterial,
  type UsHostedMaterialOwner,
} from "./us-hosted-material-owner";
import { createUsHostedDatabase } from "./us-hosted-database";
import { UsRequestPackageArtifactStore } from "../modules/traceability/requests/us-request-package-artifacts";
import { UsPlanArtifactStore } from "../modules/traceability/plans/us-plan-artifacts";
import { UsRequestPlanReader } from "../modules/traceability/requests/us-request-plan-reader";
import { UsRequestWorkerLifecycle } from "../modules/traceability/requests/us-request-worker-lifecycle";
import { UsRequestWorkerCheckpoints } from "../modules/traceability/requests/us-request-worker-checkpoint";
import { UsRequestWorkerPublication } from "../modules/traceability/requests/us-request-worker-publication";
import { UsRequestWorkerCleanup } from "../modules/traceability/requests/us-request-worker-cleanup";
import { UsRequestWorker } from "../modules/traceability/requests/us-request-worker";
import {
  assertUsRequestWorkerExecutionIdentity,
  createHostedUsRequestExecutionIdentity,
  disposeUsHostedRequestExecutionIdentity,
  type UsRequestWorkerExecutionIdentity,
} from "../modules/traceability/requests/us-request-worker-execution";

export type UsHostedWorkerRuntime = Readonly<{
  run(): Promise<void>;
  stop(): Promise<UsWorkerDrainResult>;
}>;
export class UsHostedWorkerStartupError extends Error {
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

/** Fixed B2 → C → owned TLS clients. No environment, root, loader or runtime dependency options. */
export async function createUsHostedWorkerRuntime(): Promise<UsHostedWorkerRuntime> {
  let release: VerifiedUsHostedRelease | undefined;
  let material: UsHostedMaterialOwner | undefined;
  let connection: ReturnType<typeof createDb> | undefined;
  let execution: UsRequestWorkerExecutionIdentity | undefined;
  let packageStore: UsRequestPackageArtifactStore | undefined;
  let planStore: UsPlanArtifactStore | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      let failed = false;
      try {
        if (execution) disposeUsHostedRequestExecutionIdentity(execution);
      } catch {
        failed = true;
      }
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
      try {
        if (material) disposeUsHostedMaterial(material);
      } catch {
        failed = true;
      }
      try {
        if (release) disposeUsHostedRelease(release);
      } catch {
        failed = true;
      }
      if (failed) throw new Error("us_request_worker_disposal_failed");
    })();
    return disposal;
  };
  try {
    release = await verifyUsHostedRelease("worker");
    material = await collectUsHostedMaterial(release);
    execution = createHostedUsRequestExecutionIdentity(release, material);
    const invocationExecution = execution;
    connection = createUsHostedDatabase(release, material);
    let rejectDatabaseFailure: (error: Error) => void = () => {};
    const databaseFailure = new Promise<never>((_, reject) => {
      rejectDatabaseFailure = reject;
    });
    void databaseFailure.catch(() => {});
    connection.pool.on("error", () => rejectDatabaseFailure(new Error("us_request_worker_fatal")));
    try {
      packageStore = UsRequestPackageArtifactStore.createHosted(release, material);
      planStore = UsPlanArtifactStore.createHosted(release, material);
    } catch {
      throw new UsHostedWorkerStartupError("us_request_worker_storage_unavailable");
    }
    await preflight(connection.db);
    const lifecycle = new UsRequestWorkerLifecycle(connection.db);
    const worker = new UsRequestWorker(connection.db, {
      lifecycle,
      checkpoints: new UsRequestWorkerCheckpoints(connection.db, lifecycle),
      publication: new UsRequestWorkerPublication(connection.db, lifecycle),
      cleanup: new UsRequestWorkerCleanup(connection.db, packageStore),
      planReader: new UsRequestPlanReader(connection.db, planStore),
      storage: packageStore,
      execution: invocationExecution,
    });
    let terminalRefusal = false;
    const loop = new UsRequestWorkerLoop({
      runOne: async () => {
        try {
          return await worker.runOne();
        } finally {
          try {
            assertUsRequestWorkerExecutionIdentity(invocationExecution);
          } catch {
            terminalRefusal = true;
            // stop inhibits claims synchronously. Awaiting it here would await this invocation itself.
            try {
              void loop.stop().catch(() => {});
            } catch {
              /* Never replace the original result/error. */
            }
          }
        }
      },
      emit: emitProcessEvent,
    });
    let lifetime: Promise<void> | undefined;
    let drain: Promise<UsWorkerDrainResult> | undefined;
    return Object.freeze({
      run: () => {
        lifetime ??= Promise.race([loop.run(), databaseFailure]).then(() => {
          if (terminalRefusal) throw new Error("us_request_worker_fatal");
        });
        return lifetime;
      },
      stop: () => {
        drain ??= loop.stop().then(async (result) => {
          // force_exit is not settlement and never permits teardown beneath an invocation.
          if (result.kind === "graceful") {
            await loop.run();
            await dispose();
          }
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
    if (error instanceof UsHostedWorkerStartupError) throw error;
    throw new UsHostedWorkerStartupError("us_request_worker_startup_refused");
  }
}
