import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../../src/deployment/us-request-build-descriptor";
import { UsRequestStore } from "../../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../../src/modules/traceability/requests/us-request-prepare";
import { createUsProfileTestDatabase } from "./us-profile-database";
import { createUsRequestBuildFixture, localBuildEnv } from "./us-request-build-fixture";
import { seedCompleteReceiving } from "./us-receiving-fixture";
import { finalizeUsRequestPayloadReceiving } from "./us-request-payload-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";
import { storageEnvironment } from "./us-request-worker-storage-fixture";

const MAX_BYTES = 32_000_000;
const message = z
  .object({
    type: z.literal("storage"),
    id: z.number().int().positive(),
    kind: z.enum(["put", "get", "head", "delete"]),
    bucket: z.enum(["markiro-us-request-fixture", "synthetic-request-plan-test"]),
    key: z.string().min(1).max(400),
    bytes: z
      .string()
      .max(Math.ceil(MAX_BYTES / 3) * 4)
      .optional(),
    contentType: z.string().max(100).optional(),
    conditional: z.literal("*").optional(),
  })
  .strict();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function waitFor<T>(
  read: () => Promise<T | undefined>,
  milliseconds = 15_000,
): Promise<T> {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error("Synthetic process observation deadline exceeded");
}
function barrier() {
  let enter = () => {};
  let release = () => {};
  return {
    entered: new Promise<void>((done) => {
      enter = done;
    }),
    released: new Promise<void>((done) => {
      release = done;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
type CommitMode = "normal" | "lose_reply" | "hold_reply";
type Seed = {
  tenantId: string;
  actorId: string;
  requestId: string;
  memberId: string;
  run: Awaited<ReturnType<UsRequestPrepareStore["prepare"]>>;
};
export type WorkerProcessFixture = {
  database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  calls: { pid: number; kind: string; bucket: string; key: string }[];
  build: Awaited<ReturnType<typeof createUsRequestBuildFixture>>;
  seedRun(
    mode: "export_ready" | "available_records_incomplete",
  ): Promise<{ tenantId: string; actorId: string; runId: string }>;
  holdNextUpload(completedPutsBeforeHold?: number): Promise<ReturnType<typeof barrier>>;
  holdNextPublicationReply(): ReturnType<typeof barrier>;
  spawn(commit?: CommitMode): Promise<{
    pid: number;
    signal(value: "SIGTERM" | "SIGINT" | "SIGKILL"): void;
    exited: Promise<{ code: number | null; signal: string | null }>;
    output(): string;
  }>;
  waitForReady(runId: string): Promise<void>;
  readEvidence(runId: string): Promise<{
    scope: Seed;
    run: typeof schema.traceExportRuns.$inferSelect;
    attempts: (typeof schema.traceExportAttempts.$inferSelect)[];
    artifacts: (typeof schema.traceExportArtifacts.$inferSelect)[];
    audits: (typeof schema.tenantAuditEvents.$inferSelect)[];
    intents: (typeof schema.traceExportObjectIntents.$inferSelect)[];
    frozenInput: unknown;
    checkpoint: unknown;
    attemptCount: number;
    successfulPublications: number;
    artifactHashes: string[];
  }>;
  close(): Promise<void>;
};
export type WorkerProcessSetup = {
  readIdentity?: (
    database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>,
  ) => Promise<string | undefined>;
  createBuild?: typeof createUsRequestBuildFixture;
};
export async function createWorkerProcessFixture(
  rawUrl: string,
  setup: WorkerProcessSetup = {},
): Promise<WorkerProcessFixture> {
  const database = await createUsProfileTestDatabase(rawUrl);
  let ownedBuild: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
  try {
    const name = setup.readIdentity
      ? await setup.readIdentity(database)
      : (await database.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
          ?.name;
    if (!name || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
      throw new Error("Owned DB required");
    const owned = new URL(rawUrl);
    owned.pathname = `/${name}`;
    const build = await (setup.createBuild ?? createUsRequestBuildFixture)();
    ownedBuild = build;
    const children: {
      child: ChildProcess;
      exited: Promise<{ code: number | null; signal: string | null }>;
    }[] = [];
    const plans: ReturnType<typeof createUsRequestPlanFixture>[] = [];
    const objects = new Map<string, { bytes: Buffer; contentType: string }>();
    const calls: { pid: number; kind: string; bucket: string; key: string }[] = [];
    let uploadHold: ReturnType<typeof barrier> | undefined;
    let completedPutsBeforeHold = 0;
    let commitHold: ReturnType<typeof barrier> | undefined;
    const originalRoots = {
      api: resolve("dist"),
      db: resolve("../../packages/db/dist"),
      domain: resolve("../../packages/domain/dist"),
      contracts: resolve("../../packages/platform-contracts/dist"),
    };
    for (const tree of ["api", "db", "domain", "contracts"] as const) {
      await rm(build.roots.trees[tree], { recursive: true, force: true });
      await cp(originalRoots[tree], build.roots.trees[tree], {
        recursive: true,
        filter: (path) => !path.endsWith("/us-request-build.json"),
      });
      if (tree !== "api")
        await cp(
          join(originalRoots[tree], "../package.json"),
          join(build.roots.trees[tree], "../package.json"),
        );
    }
    await cp(resolve("../../pnpm-lock.yaml"), build.roots.lockfile);
    await rm(join(build.api, "node_modules"), { recursive: true, force: true });
    // External libraries retain their installed dependency graph. Workspace imports
    // resolve through the owned root's normal package links into copied checked bytes.
    const ownedPackages = new Set([
      "@markiro/db",
      "@markiro/domain",
      "@markiro/platform-contracts",
    ]);
    for (const tree of ["api", "db", "domain", "contracts"] as const) {
      const source = join(originalRoots[tree], "../node_modules");
      const target = join(build.roots.trees[tree], "../node_modules");
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source)) {
        if (entry.startsWith(".")) continue;
        if (entry.startsWith("@")) {
          await mkdir(join(target, entry), { recursive: true });
          for (const child of await readdir(join(source, entry))) {
            if (!ownedPackages.has(`${entry}/${child}`))
              await symlink(join(source, entry, child), join(target, entry, child), "dir");
          }
        } else await symlink(join(source, entry), join(target, entry), "dir");
      }
    }
    const tuple = { apiVersion: "fixture-1", gitSha: build.initializeGit(), dirty: false };
    const document = await captureUsRequestBuildDescriptor(tuple, build.roots);
    await build.writeDocument(document);
    const raw = {
      ...(await localBuildEnv()),
      ...storageEnvironment(),
      US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
      US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
      US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-request-plan-test",
      US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic",
      US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic",
      US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    };
    await loadUsRequestBuildDescriptor(raw, build.roots);
    // Identity describes only a clean owned snapshot; compiled product bytes match it.
    const assertCompiledBytes = async () => {
      for (const file of document.files) {
        if (hash(await readFile(join(originalRoots[file.tree], file.path))) !== file.sha256)
          throw new Error("Compiled production changed during process matrix");
      }
    };
    const seeds = new Map<
      string,
      {
        tenantId: string;
        actorId: string;
        requestId: string;
        memberId: string;
        run: Awaited<ReturnType<UsRequestPrepareStore["prepare"]>>;
      }
    >();
    return {
      database,
      objects,
      calls,
      build,
      async seedRun(mode: "export_ready" | "available_records_incomplete") {
        const c = await seedCompleteReceiving(database.db);
        await finalizeUsRequestPayloadReceiving(database.db, c);
        const plan = createUsRequestPlanFixture(database.db, c);
        plans.push(plan);
        if (mode === "export_ready") {
          await plan.approve("Synthetic subprocess Plan");
          for (const [key, bytes] of plan.objects)
            objects.set(`synthetic-request-plan-test/${key}`, {
              bytes: Buffer.from(bytes),
              contentType: "application/pdf",
            });
        }
        const request = await new UsRequestStore(database.db).create(c.tenant, c.actor, {
          requestNumber: randomUUID(),
          requesterName: "Synthetic subprocess requester",
          requesterOrganization: "Synthetic organization",
          requesterContact: "private@example.test",
          receivedAt: "2026-10-04T00:00:00Z",
          scope: { lotId: c.lot },
        });
        await new UsRequestValidationStore(database.db).validate(
          c.tenant,
          c.actor,
          request.id,
          tuple,
        );
        const run = await new UsRequestPrepareStore(database.db).prepare(
          c.tenant,
          c.actor,
          request.id,
          { mode, idempotencyKey: randomUUID() },
          tuple,
        );
        const scope = { tenantId: c.tenant, actorId: c.actor, runId: run.id };
        seeds.set(run.id, { ...scope, requestId: request.id, memberId: c.member, run });
        return scope;
      },
      async holdNextUpload(completed = 0) {
        if (uploadHold) throw new Error("Upload barrier already armed");
        if (!Number.isInteger(completed) || completed < 0 || completed > 6)
          throw new Error("Bounded upload barrier required");
        completedPutsBeforeHold = completed;
        uploadHold = barrier();
        return uploadHold;
      },
      holdNextPublicationReply() {
        if (commitHold) throw new Error("Commit barrier already armed");
        commitHold = barrier();
        return commitHold;
      },
      async spawn(commit: CommitMode = "normal") {
        await assertCompiledBytes();
        const child = fork(resolve("test/support/us-request-worker-process-child.mjs"), [], {
          env: {},
          execArgv: [],
          serialization: "json",
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const pid = child.pid;
        if (!pid) throw new Error("Missing real child PID");
        let output = "";
        const capture = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.length > 64_000) child.kill("SIGKILL");
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        let died = () => {};
        const dead = new Promise<void>((done) => {
          died = done;
        });
        const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
          child.once("exit", (code, signal) => {
            died();
            done({ code, signal });
          }),
        );
        children.push({ child, exited });
        let ready = false;
        let startupFailed = false;
        let active = 0;
        const reply = (value: Serializable) => {
          if (child.connected) child.send(value, () => {});
        };
        child.on("message", (value: unknown) => {
          if (value && typeof value === "object" && "type" in value && value.type === "ready") {
            ready = true;
            return;
          }
          if (value && typeof value === "object" && "type" in value && value.type === "commit") {
            const hold = commitHold;
            commitHold = undefined;
            hold?.enter();
            if (hold)
              void Promise.race([hold.released, dead]).then(() =>
                reply({ type: "commit_release" }),
              );
            return;
          }
          const parsed = message.safeParse(value);
          if (!parsed.success || ++active > 8) {
            child.kill("SIGKILL");
            return;
          }
          const request = parsed.data;
          void (async () => {
            calls.push({ pid, kind: request.kind, bucket: request.bucket, key: request.key });
            if (request.kind === "put" && uploadHold && completedPutsBeforeHold === 0) {
              const hold = uploadHold;
              uploadHold = undefined;
              hold.enter();
              await Promise.race([hold.released, dead]);
              if (!child.connected) return;
            }
            const key = `${request.bucket}/${request.key}`;
            if (request.kind === "put") {
              if (!request.bytes || !request.contentType || request.conditional !== "*")
                throw new Error("unsafe");
              const bytes = Buffer.from(request.bytes, "base64");
              if (bytes.length > MAX_BYTES || bytes.toString("base64") !== request.bytes)
                throw new Error("unsafe");
              if (objects.has(key)) {
                reply({ type: "storage_reply", id: request.id, error: "PreconditionFailed" });
                return;
              }
              objects.set(key, { bytes, contentType: request.contentType });
              if (uploadHold && completedPutsBeforeHold > 0) completedPutsBeforeHold--;
              reply({ type: "storage_reply", id: request.id });
              return;
            }
            if (request.kind === "delete") {
              objects.delete(key);
              reply({ type: "storage_reply", id: request.id });
              return;
            }
            const object = objects.get(key);
            if (!object) {
              reply({ type: "storage_reply", id: request.id, error: "NoSuchKey" });
              return;
            }
            reply({
              type: "storage_reply",
              id: request.id,
              length: object.bytes.length,
              contentType: object.contentType,
              ...(request.kind === "get" ? { bytes: object.bytes.toString("base64") } : {}),
            });
          })()
            .catch(() => child.kill("SIGKILL"))
            .finally(() => {
              active--;
            });
        });
        child.once("exit", () => {
          startupFailed = !ready;
        });
        child.send({
          type: "initialize",
          raw,
          ownedUrl: owned.toString(),
          databaseName: name,
          roots: build.roots,
          commit,
        });
        try {
          await waitFor(async () => {
            if (startupFailed) throw new Error(`Synthetic child startup refused: ${output}`);
            return ready ? true : undefined;
          });
        } catch (error) {
          child.kill("SIGKILL");
          await exited;
          throw error;
        }
        return {
          pid,
          signal: (signal: "SIGTERM" | "SIGINT" | "SIGKILL") => {
            child.kill(signal);
          },
          exited,
          output: () => output,
        };
      },
      async waitForReady(runId: string) {
        const scope = seeds.get(runId);
        if (!scope) throw new Error("Owned run required");
        await waitFor(async () => {
          const [run] = await database.db
            .select({ status: schema.traceExportRuns.status })
            .from(schema.traceExportRuns)
            .where(
              and(
                eq(schema.traceExportRuns.tenantId, scope.tenantId),
                eq(schema.traceExportRuns.id, runId),
              ),
            );
          return run?.status === "ready" ? true : undefined;
        }, 150_000);
      },
      async readEvidence(runId: string) {
        const scope = seeds.get(runId);
        if (!scope) throw new Error("Owned run required");
        const [run] = await database.db
          .select()
          .from(schema.traceExportRuns)
          .where(
            and(
              eq(schema.traceExportRuns.tenantId, scope.tenantId),
              eq(schema.traceExportRuns.id, runId),
            ),
          );
        if (!run) throw new Error("Missing owned run");
        const checkpoints = await database.db
          .select()
          .from(schema.traceExportRenderCheckpoints)
          .where(eq(schema.traceExportRenderCheckpoints.runId, runId));
        const attempts = await database.db
          .select()
          .from(schema.traceExportAttempts)
          .where(eq(schema.traceExportAttempts.runId, runId));
        const artifacts = await database.db
          .select()
          .from(schema.traceExportArtifacts)
          .where(eq(schema.traceExportArtifacts.runId, runId));
        const audits = await database.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(
            and(
              eq(schema.tenantAuditEvents.organizationId, scope.tenantId),
              eq(schema.tenantAuditEvents.targetId, runId),
              eq(schema.tenantAuditEvents.action, "traceability.request.worker.published"),
            ),
          );
        const intents = await database.db
          .select()
          .from(schema.traceExportObjectIntents)
          .where(eq(schema.traceExportObjectIntents.runId, runId));
        return {
          scope,
          run,
          attempts,
          artifacts,
          audits,
          intents,
          frozenInput: {
            inputSnapshot: run.inputSnapshot,
            inputDigest: run.inputDigest,
            commandDigest: run.commandDigest,
            scopedContentDigest: run.scopedContentDigest,
          },
          checkpoint: checkpoints[0] ?? null,
          attemptCount: attempts.length,
          successfulPublications: audits.length,
          artifactHashes: artifacts.map((artifact) => {
            const object = objects.get(`markiro-us-request-fixture/${artifact.objectKey}`);
            if (!object || object.bytes.length !== Number(artifact.byteSize))
              throw new Error("Winning bytes missing");
            return hash(object.bytes);
          }),
        };
      },
      async close() {
        const closeChild = async (index: number): Promise<void> => {
          const entry = children[index];
          if (!entry) return;
          const { child, exited } = entry;
          try {
            try {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              await exited;
            } finally {
              if (child.connected) child.disconnect();
            }
          } finally {
            await closeChild(index + 1);
          }
        };
        const destroyPlan = (index: number): void => {
          const plan = plans[index];
          if (!plan) return;
          try {
            plan.destroy();
          } finally {
            destroyPlan(index + 1);
          }
        };
        try {
          uploadHold?.release();
        } finally {
          try {
            commitHold?.release();
          } finally {
            try {
              await closeChild(0);
            } finally {
              try {
                destroyPlan(0);
              } finally {
                objects.clear();
                try {
                  await build.dispose();
                } finally {
                  await database.close();
                }
              }
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await ownedBuild?.dispose();
    } finally {
      await database.close();
    }
    throw error;
  }
}
