import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUsRequestWorkerRuntime,
  type UsRequestWorkerRuntime,
} from "../src/deployment/us-request-worker-runtime";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import type { UsWorkerProcessEvent } from "../src/deployment/us-request-worker-loop";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import {
  createUsRequestWorkerStorageFixture,
  storageEnvironment,
} from "./support/us-request-worker-storage-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("real US request runtime in a fixture-owned database", () => {
  let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let build: Awaited<ReturnType<typeof createUsRequestBuildFixture>>;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  let source: Awaited<ReturnType<typeof createUsRequestPackageFixture>> | undefined;
  let runtime: UsRequestWorkerRuntime | undefined;
  let ownedUrl: string;
  const pools: ReturnType<typeof createDb>["pool"][] = [];
  beforeEach(async () => {
    if (!url) throw new Error("Explicit synthetic US URL required");
    database = await createUsProfileTestDatabase(url);
    const identity = await database.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const name = identity.rows[0]?.name;
    if (!name?.startsWith("markiro_us_profile_")) throw new Error("Fixture ownership required");
    const owned = new URL(url);
    owned.pathname = `/${name}`;
    ownedUrl = owned.toString();
    build = await createUsRequestBuildFixture();
    await build.writeDocument(
      await captureUsRequestBuildDescriptor(
        { ...build.cleanBuild, apiVersion: "test-us09-package" },
        build.roots,
      ),
    );
    storage = createUsRequestWorkerStorageFixture();
  }, 60_000);
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    vi.restoreAllMocks();
    // Assertions check runtime disposal first; fixture cleanup also closes a
    // leaked pool if a regression fails, before dropping its own database.
    for (const pool of pools.splice(0)) {
      if (!pool.ended) await pool.end();
    }
    source?.destroy();
    source = undefined;
    storage?.destroy();
    await build?.dispose();
    await database?.close();
  });
  const connect: typeof createDb = (configured, options) => {
    expect(configured).toBe(
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
    );
    const connection = createDb(ownedUrl, options);
    pools.push(connection.pool);
    return connection;
  };
  const start = async (emit?: (event: UsWorkerProcessEvent) => void, plan = false) => {
    runtime = await createUsRequestWorkerRuntime(
      {
        ...(await localBuildEnv()),
        ...storageEnvironment(),
        ...(plan
          ? {
              US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
              US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
              US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-request-plan-test",
              US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-plan-access",
              US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-plan-secret",
              US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
            }
          : {}),
      },
      {
        connect,
        loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, build.roots),
        packageTransport: storage.transport,
        ...(plan && source ? { planTransport: source.planFixture.transport } : {}),
        emit: emit ?? (() => {}),
      },
    );
    return runtime;
  };
  const one = async (plan = false) => {
    const events: UsWorkerProcessEvent[] = [];
    let finished: Promise<unknown> | undefined;
    const worker = await start((event) => {
      events.push(event);
      if (event.event === "result") finished = runtime?.stop();
    }, plan);
    await worker.run();
    expect(await finished).toEqual({ kind: "graceful" });
    return events;
  };
  const state = async () => {
    if (!source) throw new Error("Missing synthetic source");
    const [run] = await database.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.id, source.run.id));
    return {
      run,
      attempts: await database.db.select().from(schema.traceExportAttempts),
      artifacts: await database.db.select().from(schema.traceExportArtifacts),
    };
  };

  it("preflights current schema without claiming or changing queued evidence", async () => {
    source = await createUsRequestPackageFixture(database.db, { mode: "export_ready" });
    const before = await state();
    const worker = await start();
    expect(await state()).toEqual(before);
    expect(storage.calls).toEqual([]);
    expect(await worker.stop()).toEqual({ kind: "graceful" });
    expect(pools[0]?.ended).toBe(true);
  });

  it.each(["relation", "cleanup_column"])(
    "refuses a missing %s with no claim and closes its pool",
    async (missing) => {
      source = await createUsRequestPackageFixture(database.db, { mode: "export_ready" });
      const before = await state();
      if (missing === "relation")
        await database.pool.query(
          "ALTER TABLE trace_export_retry_receipts RENAME TO fixture_hidden_retry_receipts",
        );
      else
        await database.pool.query(
          "ALTER TABLE trace_export_object_intents RENAME COLUMN fenced_at TO fixture_hidden_fenced_at",
        );
      await expect(start()).rejects.toThrow("us_request_worker_startup_refused");
      expect(await state()).toEqual(before);
      expect(storage.calls).toEqual([]);
      expect(pools[0]?.ended).toBe(true);
    },
  );

  it("publishes a genuine incomplete run with an absent frozen Plan and no Plan storage", async () => {
    source = await createUsRequestPackageFixture(database.db, {
      mode: "available_records_incomplete",
      withPlan: false,
    });
    expect(source.plan).toEqual({ kind: "absent", code: "plan_absent" });
    const events = await one();
    expect(events.find((event) => event.event === "result")?.kind).toBe("ready");
    const saved = await state();
    expect(saved.run?.status).toBe("ready");
    expect(saved.artifacts).toHaveLength(5);
    expect(saved.artifacts.some((artifact) => artifact.kind === "plan_pdf")).toBe(false);
    expect(storage.calls.map((call) => call.kind)).toEqual([
      "put",
      "get",
      "put",
      "get",
      "put",
      "get",
      "put",
      "get",
      "put",
      "get",
    ]);
  }, 30_000);

  it("persists a per-run failure for a pinned Plan with absent Plan storage", async () => {
    source = await createUsRequestPackageFixture(database.db, { mode: "export_ready" });
    const events = await one();
    expect(events.find((event) => event.event === "result")?.kind).toBe("failed");
    const saved = await state();
    expect(saved.run?.status).toBe("failed");
    expect(saved.run?.failureCode).toBe("us_request_plan_read_failed");
    expect(saved.attempts).toHaveLength(1);
    expect(saved.artifacts).toEqual([]);
    expect(storage.calls).toEqual([]);
  }, 30_000);

  it("composes accepted factories and publishes verified bytes with configured Plan storage", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    source = await createUsRequestPackageFixture(database.db, { mode: "export_ready" });
    const events = await one(true);
    expect(events.find((event) => event.event === "result")?.kind).toBe("ready");
    const saved = await state();
    expect(saved.run?.status).toBe("ready");
    expect(saved.artifacts).toHaveLength(6);
    expect(saved.attempts[0]?.status).toBe("succeeded");
    expect(listen).not.toHaveBeenCalled();
    for (const artifact of saved.artifacts)
      expect(storage.objects.get(artifact.objectKey)?.bytes.length).toBe(Number(artifact.byteSize));
  }, 30_000);
});
