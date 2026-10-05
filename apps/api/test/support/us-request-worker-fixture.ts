import { createHash, randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect } from "vitest";
import { bindUsRequestPackageInputs } from "../../src/modules/traceability/requests/us-request-package-inputs";
import { assembleUsRequestPackage } from "../../src/modules/traceability/requests/us-request-package";
import { verifyUsRequestPackageArchive } from "../../src/modules/traceability/requests/us-request-package-zip";
import { renderUsRequestPayloads } from "../../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPlanReader } from "../../src/modules/traceability/requests/us-request-plan-reader";
import { UsRequestWorker } from "../../src/modules/traceability/requests/us-request-worker";
import { UsRequestWorkerLifecycle } from "../../src/modules/traceability/requests/us-request-worker-lifecycle";
import { UsRequestWorkerCheckpoints } from "../../src/modules/traceability/requests/us-request-worker-checkpoint";
import {
  UsRequestWorkerPublication,
  usWorkerIntentEvidence,
} from "../../src/modules/traceability/requests/us-request-worker-publication";
import { UsRequestWorkerCleanup } from "../../src/modules/traceability/requests/us-request-worker-cleanup";
import { createSyntheticUsRequestExecutionIdentity } from "../../src/modules/traceability/requests/us-request-worker-execution";
import { UsRequestPackageArtifactStore } from "../../src/modules/traceability/requests/us-request-package-artifacts";
import { createUsRequestPackageFixture } from "./us-request-package-fixture";
import { createUsRequestWorkerStorageFixture } from "./us-request-worker-storage-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";
import { UsRequestStore } from "../../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../../src/modules/traceability/requests/us-request-prepare";
import type { UsRequestPayloadResult } from "../../src/modules/traceability/requests/us-request-payloads";
import type { UsTraceRequestScopeV1 } from "@markiro/platform-contracts";

export const requestWorkerFixtureBuild = {
  apiVersion: "test-us09-package",
  gitSha: "a".repeat(40),
  dirty: false,
};

export async function prepareUsWorkerSource(
  db: Db,
  c: { tenant: string; actor: string },
  mode: UsRequestPayloadResult["mode"],
  scope: UsTraceRequestScopeV1,
  withPlan = true,
) {
  const planFixture = createUsRequestPlanFixture(db, c);
  try {
    if (withPlan) await planFixture.approve("Synthetic worker Plan");
    const request = await new UsRequestStore(db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic worker requester",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: "2026-10-04T00:00:00Z",
      scope,
    });
    await new UsRequestValidationStore(db).validate(
      c.tenant,
      c.actor,
      request.id,
      requestWorkerFixtureBuild,
    );
    const run = await new UsRequestPrepareStore(db).prepare(
      c.tenant,
      c.actor,
      request.id,
      { mode, idempotencyKey: randomUUID() },
      requestWorkerFixtureBuild,
    );
    return {
      tenantId: c.tenant,
      actorId: c.actor,
      request,
      run,
      payloads: await renderUsRequestPayloads(run, c.tenant),
      plan: await new UsRequestPlanReader(db, planFixture.artifacts).read(run, c.tenant),
      context: {
        schemaVersion: 1 as const,
        workerStartedAt: null,
        reportDataPreparedAt: run.startedAt.toISOString(),
      },
      planFixture,
      destroy: () => planFixture.destroy(),
    };
  } catch (error) {
    planFixture.destroy();
    throw error;
  }
}

/** Approved test-only projection: no server clock or durable field is rewritten.
 * Only this wrapper's worker SQL is projected; base fixture/migrations are untouched.
 * Statements are bounded in memory and never include parameter values. */
export function createUsWorkerDatabaseTransport(db: Db): {
  db: Db;
  statements: {
    raw: string;
    projected: string;
    outcome: "forwarded" | "committed_reply_lost" | "rolled_back_reply_lost";
  }[];
  faultCommit(fault: "commit" | "rollback", predicate: (text: string) => boolean): void;
  advancePast(instant: Date): Promise<void>;
} {
  let offsetMs = 0;
  let commitFault: "commit" | "rollback" | null = null;
  const transactionMatched = new WeakMap<object, boolean>();
  let match: ((text: string) => boolean) | null = null;
  const statements: {
    raw: string;
    projected: string;
    outcome: "forwarded" | "committed_reply_lost" | "rolled_back_reply_lost";
  }[] = [];
  const query =
    (target: { query: unknown }, receiver: object) =>
    async (...args: unknown[]) => {
      const input = args[0];
      const raw =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "text" in input && typeof input.text === "string"
            ? input.text
            : "";
      if (/^begin\b/i.test(raw)) transactionMatched.set(receiver, false);
      if (match?.(raw)) transactionMatched.set(receiver, true);
      const workerClockQuery =
        /^\s*select\s+extract\(epoch from date_trunc\('milliseconds',\s*clock_timestamp\(\)\)\) \* 1000 as milliseconds\s*$/i.test(
          raw,
        ) ||
        (/^\s*select\b/i.test(raw) &&
          raw.includes('from "trace_export_runs"') &&
          raw.includes("clock_timestamp()"));
      const projected =
        offsetMs && workerClockQuery
          ? raw.replaceAll(
              /clock_timestamp\(\)/gi,
              `(clock_timestamp() + interval '${offsetMs} milliseconds')`,
            )
          : raw;
      const forwarded = [...args];
      forwarded[0] =
        typeof input === "string"
          ? projected
          : input && typeof input === "object"
            ? { ...input, text: projected }
            : input;
      if (statements.length >= 3000) statements.shift();
      const record: (typeof statements)[number] = { raw, projected, outcome: "forwarded" };
      statements.push(record);
      const send = (...values: unknown[]) =>
        Reflect.apply(target.query as (...a: unknown[]) => unknown, receiver, values);
      if (/^commit\b/i.test(raw) && commitFault && transactionMatched.get(receiver)) {
        const fault = commitFault;
        commitFault = null;
        match = null;
        if (fault === "commit") {
          await send(...forwarded);
          record.outcome = "committed_reply_lost";
        } else {
          await send("rollback");
          record.projected = "rollback";
          record.outcome = "rolled_back_reply_lost";
        }
        throw Object.assign(new Error("Synthetic PostgreSQL reply loss"), { code: "08007" });
      }
      return send(...forwarded);
    };
  const pool = db.$client;
  const wrapped = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, k) {
              if (k === "query") return query(c, c);
              const value: unknown = Reflect.get(c, k, c);
              return typeof value === "function" ? value.bind(c) : value;
            },
          });
        };
      if (key === "query") return query(target, target);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: drizzle(wrapped),
    statements,
    faultCommit(fault: "commit" | "rollback", predicate: (text: string) => boolean) {
      commitFault = fault;
      match = predicate;
    },
    async advancePast(instant: Date) {
      const raw = await pool.query<{ instant: Date }>(
        "select date_trunc('milliseconds',clock_timestamp()) as instant",
      );
      const now = raw.rows[0]?.instant;
      if (!now) throw new Error("Missing real PostgreSQL time");
      offsetMs = Math.max(offsetMs, instant.getTime() - now.getTime() + 10);
    },
  };
}

/** All authority is reread from the explicit durable DB on every recreated service. */
export async function createUsRequestWorkerFixture(
  db: Db,
  options: Parameters<typeof createUsRequestPackageFixture>[1],
) {
  const source = await createUsRequestPackageFixture(db, options);
  return bindUsRequestWorkerFixture(db, source);
}

/** Also binds actual event/provisioning fixtures without inventing saved evidence. */
export function bindUsRequestWorkerFixture(
  db: Db,
  source: Awaited<ReturnType<typeof createUsRequestPackageFixture>>,
) {
  const storage = createUsRequestWorkerStorageFixture();
  const scope = { tenantId: source.tenantId, runId: source.run.id };
  const originalPlans = new Map(
    [...source.planFixture.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]),
  );
  const stores: UsRequestPackageArtifactStore[] = [];
  const instances = () => {
    const store = new UsRequestPackageArtifactStore(storage.config, storage.transport);
    stores.push(store);
    const lifecycle = new UsRequestWorkerLifecycle(db);
    const checkpoints = new UsRequestWorkerCheckpoints(db, lifecycle);
    const publication = new UsRequestWorkerPublication(db, lifecycle);
    const cleanup = new UsRequestWorkerCleanup(db, store);
    const planReader = new UsRequestPlanReader(db, source.planFixture.artifacts);
    return {
      lifecycle,
      checkpoints,
      publication,
      cleanup,
      store,
      planReader,
      worker: new UsRequestWorker(db, {
        lifecycle,
        checkpoints,
        publication,
        cleanup,
        planReader,
        storage: store,
        execution: createSyntheticUsRequestExecutionIdentity(requestWorkerFixtureBuild, {
          NODE_ENV: "test",
          MARKIRO_DEPLOYMENT_EDITION: "US",
        }),
      }),
    };
  };
  const services = instances();
  return {
    source,
    storage,
    scope,
    ...services,
    instances,
    recreate: () => instances().worker,
    async verifyReady() {
      const state = await new UsRequestWorkerLifecycle(db).read(scope);
      if (!state.checkpoint || !state.expectation) throw new Error("Missing committed checkpoint");
      const payloads = await renderUsRequestPayloads(state.run, scope.tenantId);
      const plan = await new UsRequestPlanReader(db, source.planFixture.artifacts).read(
        state.run,
        scope.tenantId,
      );
      const actual = await assembleUsRequestPackage(
        bindUsRequestPackageInputs(state.run, scope.tenantId, payloads, plan, {
          schemaVersion: 1,
          workerStartedAt: state.checkpoint.model.timing.workerStartedAt,
          reportDataPreparedAt: state.checkpoint.model.timing.reportDataPreparedAt,
        }),
      );
      expect(state.run.status).toBe("ready");
      expect(state.run.inputSnapshot).toEqual(source.run.inputSnapshot);
      expect(state.run.revision).toBe(source.run.revision);
      expect(state.run.exportReady).toBe(source.run.mode === "export_ready");
      expect(state.artifacts).toHaveLength(actual.files.length);
      for (const row of state.artifacts) {
        const expected =
          row.kind === "package_zip"
            ? actual.zip
            : actual.files.find((e) => e.name === row.filename);
        if (!expected) throw new Error("Unexpected winning artifact");
        const [intent] = await db
          .select()
          .from(schema.traceExportObjectIntents)
          .where(eq(schema.traceExportObjectIntents.objectKey, row.objectKey));
        if (!intent) throw new Error("Missing committed winning object intent");
        const bytes = await services.store.readVerified(scope, usWorkerIntentEvidence(intent));
        expect(bytes).toEqual(expected.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
        expect(row.sha256).toBe(expected.sha256);
        if (row.kind === "package_zip")
          verifyUsRequestPackageArchive(bytes, { manifest: actual.manifest, files: actual.files });
      }
      for (const [key, bytes] of originalPlans)
        expect(source.planFixture.objects.get(key)).toEqual(bytes);
      return { state, actual };
    },
    destroy() {
      for (const store of stores) store.destroy();
      storage.destroy();
      source.destroy();
    },
  };
}
