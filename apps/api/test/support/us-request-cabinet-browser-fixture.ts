import "reflect-metadata";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createDb, schema } from "@markiro/db";
import { hashPassword } from "better-auth/crypto";
import type { INestApplication } from "@nestjs/common";
import { createUsDevelopmentApplication } from "../../src/deployment/us-bootstrap";
import { loadUsRequestBuildDescriptor } from "../../src/deployment/us-request-build-descriptor";
import type { UsPlanArtifactS3Transport } from "../../src/modules/traceability/plans/us-plan-artifacts";
import type { UsRequestPackageArtifactS3Transport } from "../../src/modules/traceability/requests/us-request-package-artifacts";
import {
  createWorkerProcessFixture,
  type WorkerProcessFixture,
} from "./us-request-worker-process-fixture";
import { seedCompleteReceiving } from "./us-receiving-fixture";
import { finalizeUsRequestPayloadReceiving } from "./us-request-payload-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";
import { localBuildEnv } from "./us-request-build-fixture";
import { storageEnvironment } from "./us-request-worker-storage-fixture";

type Stage = "process" | "seed" | "app" | "vite";
type Server = { listen(): Promise<unknown>; close(): Promise<void> };
const buckets = new Set(["markiro-us-request-fixture", "synthetic-request-plan-test"]);

function requireExplicitUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Explicit isolated US_TEST_DATABASE_URL required");
  }
  if (
    url.protocol !== "postgres:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/markiro_us_dev" ||
    url.username !== "markiro_us" ||
    url.search ||
    url.hash
  )
    throw new Error("Explicit isolated US_TEST_DATABASE_URL required");
  return url;
}

async function requireFreePort(port: number, host: string) {
  const probe = createServer();
  try {
    await new Promise<void>((done, fail) => {
      probe.once("error", fail);
      probe.listen(port, host, done);
    });
  } finally {
    if (probe.listening)
      await new Promise<void>((done, fail) =>
        probe.close((error) => (error ? fail(error) : done())),
      );
  }
}

/** Test-only private transport shared with the real child process. No provider access. */
function createTransport(objects: WorkerProcessFixture["objects"]) {
  const streams = new Set<Readable>();
  const transport: UsPlanArtifactS3Transport & UsRequestPackageArtifactS3Transport = {
    async send(command, { abortSignal }) {
      const { Bucket, Key } = command.input;
      if (
        !Bucket ||
        !buckets.has(Bucket) ||
        !Key ||
        Key.length > 400 ||
        !/^[A-Za-z0-9_./-]+$/.test(Key) ||
        Key.startsWith("/") ||
        Key.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        abortSignal.aborted
      )
        throw new Error("Invalid owned object scope");
      const mapKey = `${Bucket}/${Key}`;
      if (command instanceof PutObjectCommand) {
        const { Body, IfNoneMatch, ACL, ContentType } = command.input;
        const max = Bucket === "synthetic-request-plan-test" ? 8_000_000 : 64 * 1024 * 1024;
        if (
          !(Body instanceof Uint8Array) ||
          Body.byteLength === 0 ||
          Body.byteLength > max ||
          IfNoneMatch !== "*" ||
          ACL !== undefined ||
          !ContentType ||
          ContentType.length > 100 ||
          (Bucket === "synthetic-request-plan-test" && ContentType !== "application/pdf")
        )
          throw new Error("Unsafe owned object publication");
        if (objects.has(mapKey))
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        objects.set(mapKey, { bytes: Buffer.from(Body), contentType: ContentType });
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(mapKey);
        return {};
      }
      const object = objects.get(mapKey);
      if (!object) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      if (
        object.bytes.length === 0 ||
        object.bytes.length >
          (Bucket === "synthetic-request-plan-test" ? 8_000_000 : 64 * 1024 * 1024)
      )
        throw new Error("Unbounded owned object");
      const metadata = { ContentType: object.contentType, ContentLength: object.bytes.length };
      if (command instanceof HeadObjectCommand) return metadata;
      if (!(command instanceof GetObjectCommand)) throw new Error("Unsupported owned command");
      const body = Readable.from([Buffer.from(object.bytes)]);
      const abort = () => body.destroy();
      abortSignal.addEventListener("abort", abort, { once: true });
      streams.add(body);
      body.once("close", () => {
        abortSignal.removeEventListener("abort", abort);
        streams.delete(body);
      });
      return { ...metadata, Body: body };
    },
  };
  return {
    transport,
    destroy() {
      for (const stream of streams) stream.destroy();
      streams.clear();
    },
  };
}

export async function startRequestCabinetBrowserFixture(
  rawUrl: string,
  options: { afterAcquire?: (stage: Stage) => Promise<void> } = {},
): Promise<{
  origin: string;
  email: string;
  password: string;
  tenantId: string;
  actorId: string;
  lotId: string;
  workerPid(): number | null;
  startWorker(): Promise<void>;
  approvePlan(): Promise<void>;
  close(): Promise<void>;
}> {
  const base = requireExplicitUrl(rawUrl);
  let processFixture: WorkerProcessFixture | undefined;
  let app: INestApplication | undefined;
  let vite: Server | undefined;
  let plan: ReturnType<typeof createUsRequestPlanFixture> | undefined;
  let store: ReturnType<typeof createTransport> | undefined;
  let worker: Awaited<ReturnType<WorkerProcessFixture["spawn"]>> | undefined;
  let closing: Promise<void> | undefined;
  let assertCompiled: (() => Promise<void>) | undefined;
  let stage = "process";
  const close = () =>
    (closing ??= (async () => {
      try {
        await vite?.close();
      } finally {
        try {
          await app?.close();
        } finally {
          try {
            plan?.destroy();
          } finally {
            try {
              store?.destroy();
            } finally {
              try {
                await assertCompiled?.();
              } finally {
                await processFixture?.close();
              }
            }
          }
        }
      }
    })());
  try {
    processFixture = await createWorkerProcessFixture(rawUrl);
    await options.afterAcquire?.("process");
    const identity = (
      await processFixture.database.pool.query<{ name: string }>(
        "SELECT current_database() AS name",
      )
    ).rows[0]?.name;
    if (!identity || !/^markiro_us_profile_[a-f0-9_]+$/.test(identity))
      throw new Error("Owned database required");
    const ownedUrl = new URL(base);
    ownedUrl.pathname = `/${identity}`;
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
    const descriptor = await loadUsRequestBuildDescriptor(raw, processFixture.build.roots);
    const original = {
      api: resolve("dist"),
      db: resolve("../../packages/db/dist"),
      domain: resolve("../../packages/domain/dist"),
      contracts: resolve("../../packages/platform-contracts/dist"),
    };
    assertCompiled = async () => {
      for (const file of descriptor.document.files) {
        const bytes = await readFile(join(original[file.tree], file.path));
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
          throw new Error("Compiled bytes changed during browser fixture");
      }
    };
    await assertCompiled();
    stage = "seed";
    const c = await seedCompleteReceiving(processFixture.database.db);
    await finalizeUsRequestPayloadReceiving(processFixture.database.db, c);
    const password = `Synthetic-${randomBytes(24).toString("hex")}`;
    const hash = hashPassword as unknown as (password: string) => Promise<string>;
    await processFixture.database.db.insert(schema.account).values({
      id: randomUUID(),
      userId: c.actor,
      accountId: c.actor,
      providerId: "credential",
      password: await hash(password),
    });
    plan = createUsRequestPlanFixture(processFixture.database.db, c);
    store = createTransport(processFixture.objects);
    await options.afterAcquire?.("seed");
    await requireFreePort(3100, "127.0.0.1");
    await requireFreePort(5174, "localhost");
    const ownedProcess = processFixture;
    stage = "app";
    app = await createUsDevelopmentApplication(
      raw,
      (databaseUrl, config) => {
        if (databaseUrl !== base.toString()) throw new Error("Unexpected base database URL");
        return createDb(ownedUrl.toString(), config);
      },
      store.transport,
      {
        loadBuild: (source) => loadUsRequestBuildDescriptor(source, ownedProcess.build.roots),
        packageTransport: store.transport,
      },
    );
    await options.afterAcquire?.("app");
    await app.listen(3100, "127.0.0.1");
    stage = "vite-runtime";
    const adminRequire = createRequire(resolve("../admin/package.json"));
    const { createServer: createVite } = (await import(adminRequire.resolve("vite"))) as {
      createServer(config: unknown): Promise<Server>;
    };
    stage = "vite-config";
    const { createUsAdminConfig } = (await import(adminRequire.resolve("./vite.us.config.ts"))) as {
      createUsAdminConfig(raw: NodeJS.ProcessEnv, mode: string): Record<string, unknown>;
    };
    stage = "vite";
    vite = await createVite({
      ...createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test"),
      configFile: false,
      mode: "test",
      logLevel: "silent",
    });
    await options.afterAcquire?.("vite");
    await vite.listen();
    const ownedPlan = plan;
    let approved = false;
    let workerStarted = false;
    return {
      origin: "http://localhost:5174",
      email: `${c.actor}@example.test`,
      password,
      tenantId: c.tenant,
      actorId: c.actor,
      lotId: c.lot,
      workerPid: () => worker?.pid ?? null,
      async startWorker() {
        if (closing || workerStarted) throw new Error("Single owned worker required");
        workerStarted = true;
        await assertCompiled?.();
        worker = await ownedProcess.spawn();
      },
      async approvePlan() {
        if (closing || approved) throw new Error("Single owned Plan required");
        await ownedPlan.approve("Synthetic browser Plan");
        approved = true;
        for (const [key, bytes] of ownedPlan.objects)
          ownedProcess.objects.set(`synthetic-request-plan-test/${key}`, {
            bytes: Buffer.from(bytes),
            contentType: "application/pdf",
          });
      },
      close,
    };
  } catch {
    try {
      await close();
    } catch {
      /* All nested cleanup was attempted; no raw private diagnostics. */
    }
    throw new Error(
      `Requests browser fixture could not start at ${stage}; check isolated prerequisites`,
    );
  }
}
