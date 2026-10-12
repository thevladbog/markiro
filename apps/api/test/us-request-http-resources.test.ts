import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import { UsRequestHttpResources } from "../src/deployment/us-request-http-resources";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import {
  createUsRequestWorkerStorageFixture,
  storageEnvironment,
} from "./support/us-request-worker-storage-fixture";
import type { UsWorkerObjectEvidence } from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsRequestResourceTestScope } from "./support/us-request-resource-test-scope";

const resourceTestScope = createUsRequestResourceTestScope();
beforeEach(resourceTestScope.assertIdle);
afterEach(async () => {
  await resourceTestScope.drain();
  vi.restoreAllMocks();
});
afterAll(resourceTestScope.drain);
const unavailableBuild = { status: 503, response: { code: "us_request_build_unavailable" } };
const unavailableStorage = {
  status: 503,
  response: { code: "us_request_package_storage_unavailable" },
};
const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
};
const bytes = Buffer.from("synthetic private package");
const evidence: UsWorkerObjectEvidence = {
  ...scope,
  id: "44444444-4444-4444-8444-444444444444",
  attemptId: "33333333-3333-4333-8333-333333333333",
  name: "manifest.json",
  kind: "manifest",
  mediaType: "application/json",
  objectKey: `us/requests/${scope.tenantId}/${scope.runId}/33333333-3333-4333-8333-333333333333/manifest.json`,
  byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

describe("operation-local US request HTTP resources", () => {
  // Caching availability would wrongly permit an operation after output changes.
  it.each(["missing", "dirty", "tampered", "mixed"] as const)(
    "refuses %s build evidence with a sanitized 503",
    resourceTestScope.phase(async (kind) => {
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        fixture = await createUsRequestBuildFixture();
        const document = await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots);
        if (kind !== "missing") await fixture.writeDocument(document);
        if (kind === "dirty")
          await fixture.writeDocument({ ...document, build: { ...document.build, dirty: true } });
        if (kind === "tampered")
          await fixture.replaceApiBytes("index.js", Buffer.from("changed output\n"));
        if (kind === "mixed") {
          const outside = join(fixture.root, "stale-db");
          await mkdir(outside);
          await writeFile(join(outside, "package.json"), JSON.stringify({ main: "index.js" }));
          await writeFile(join(outside, "index.js"), "module.exports = {};\n");
          await mkdir(join(fixture.api, "node_modules/@markiro"), { recursive: true });
          await symlink(outside, join(fixture.api, "node_modules/@markiro/db"), "dir");
        }
        const roots = fixture.roots;
        resources = new UsRequestHttpResources(await localBuildEnv(), {
          loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
        });
        expect(await resources.availability()).toEqual({
          build: "unavailable",
          packageStorage: "unconfigured",
        });
        await expect(resources.loadBuild()).rejects.toMatchObject(unavailableBuild);
      } finally {
        resources?.dispose();
        await fixture?.dispose();
      }
    }),
  );

  it(
    "rechecks real descriptor bytes after successful availability",
    resourceTestScope.phase(async () => {
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        fixture = await createUsRequestBuildFixture();
        const document = await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots);
        await fixture.writeDocument(document);
        const roots = fixture.roots;
        resources = new UsRequestHttpResources(await localBuildEnv(), {
          loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
        });
        expect(await resources.availability()).toEqual({
          build: "available",
          packageStorage: "unconfigured",
        });
        await fixture.writeDocument({ ...document, build: { ...document.build, dirty: true } });
        await expect(resources.loadBuild()).rejects.toMatchObject(unavailableBuild);
        expect((await resources.availability()).build).toBe("unavailable");
      } finally {
        resources?.dispose();
        await fixture?.dispose();
      }
    }),
  );

  it(
    "rejects copied unbranded descriptors and hides trusted loader errors",
    resourceTestScope.phase(async () => {
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        fixture = await createUsRequestBuildFixture();
        await fixture.writeDocument(
          await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
        );
        const source = await localBuildEnv();
        const checked = await loadUsRequestBuildDescriptor(source, fixture.roots);
        resources = new UsRequestHttpResources(source, { loadBuild: async () => ({ ...checked }) });
        await expect(resources.loadBuild()).rejects.toMatchObject(unavailableBuild);
        resources.dispose();
        resources = new UsRequestHttpResources(source, {
          loadBuild: async () => {
            throw new Error("private-provider.example/sensitive-key");
          },
        });
        await expect(resources.loadBuild()).rejects.toMatchObject(unavailableBuild);
        expect(await resources.availability()).toEqual({
          build: "unavailable",
          packageStorage: "unconfigured",
        });
      } finally {
        resources?.dispose();
        await fixture?.dispose();
      }
    }),
  );

  it.each([
    { US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000" },
    { ...storageEnvironment(), US_REQUEST_PACKAGE_S3_BUCKET: "" },
    { ...storageEnvironment(), US_REQUEST_PACKAGE_S3_ENDPOINT: "https://private-provider.example" },
  ])(
    "keeps invalid package configuration local to storage",
    resourceTestScope.phase(async (override) => {
      let resources: UsRequestHttpResources | undefined;
      try {
        resources = new UsRequestHttpResources({ ...(await localBuildEnv()), ...override });
        expect((await resources.availability()).packageStorage).toBe("invalid");
        expect(resources.requirePackageStore.bind(resources)).toThrowError(
          expect.objectContaining(unavailableStorage),
        );
      } finally {
        resources?.dispose();
      }
    }),
  );

  it(
    "does not fall back to Plan or general storage",
    resourceTestScope.phase(async () => {
      let resources: UsRequestHttpResources | undefined;
      try {
        resources = new UsRequestHttpResources({
          ...(await localBuildEnv()),
          US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
          US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-plan-only",
          S3_ENDPOINT: "http://127.0.0.1:19000",
          S3_BUCKET: "synthetic-general-only",
        });
        expect((await resources.availability()).packageStorage).toBe("unconfigured");
        expect(resources.requirePackageStore.bind(resources)).toThrowError(
          expect.objectContaining(unavailableStorage),
        );
      } finally {
        resources?.dispose();
      }
    }),
  );

  it(
    "snapshots raw configuration and creates an owned client only on demand",
    resourceTestScope.phase(async () => {
      const destroy = vi.spyOn(S3Client.prototype, "destroy");
      const raw = { ...(await localBuildEnv()), ...storageEnvironment() };
      let unused: UsRequestHttpResources | undefined;
      let active: UsRequestHttpResources | undefined;
      try {
        unused = new UsRequestHttpResources(raw);
        active = new UsRequestHttpResources(raw);
        raw.US_REQUEST_PACKAGE_S3_BUCKET = "";
        expect((await unused.availability()).packageStorage).toBe("configured");
        unused.dispose();
        expect(destroy).not.toHaveBeenCalled();
        const store = active.requirePackageStore();
        expect(active.requirePackageStore()).toBe(store);
        active.dispose();
        active.dispose();
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(active.requirePackageStore.bind(active)).toThrowError(
          expect.objectContaining(unavailableStorage),
        );
      } finally {
        unused?.dispose();
        active?.dispose();
      }
    }),
  );

  it(
    "passes the fixed raw snapshot to each operation-local loader",
    resourceTestScope.phase(async () => {
      let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
      let resources: UsRequestHttpResources | undefined;
      try {
        fixture = await createUsRequestBuildFixture();
        await fixture.writeDocument(
          await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
        );
        const raw = await localBuildEnv();
        const roots = fixture.roots;
        resources = new UsRequestHttpResources(raw, {
          loadBuild: (source) => loadUsRequestBuildDescriptor(source, roots),
        });
        raw.MARKIRO_DEPLOYMENT_EDITION = "RU";
        expect((await resources.availability()).build).toBe("available");
        expect((await resources.loadBuild()).document.build).toEqual(fixture.cleanBuild);
      } finally {
        resources?.dispose();
        await fixture?.dispose();
      }
    }),
  );

  it(
    "aborts active store I/O on dispose without destroying caller-owned transport",
    resourceTestScope.phase(async () => {
      let fixture: ReturnType<typeof createUsRequestWorkerStorageFixture> | undefined;
      const destroy = vi.fn();
      let resources: UsRequestHttpResources | undefined;
      let release: (() => void) | undefined;
      let settlement: Promise<unknown> | undefined;
      try {
        fixture = createUsRequestWorkerStorageFixture();
        resources = new UsRequestHttpResources(
          { ...(await localBuildEnv()), ...storageEnvironment() },
          { packageTransport: { send: fixture.transport.send, destroy } },
        );
        fixture.faults.before = () =>
          new Promise<void>((resolve) => {
            release = resolve;
          });
        const store = resources.requirePackageStore();
        const pending = store.putVerified(scope, evidence, bytes);
        settlement = pending.catch(() => {});
        resources.dispose();
        await expect(pending).rejects.toThrow("us_request_package_storage_timeout");
        expect(fixture.calls[0]?.signal.aborted).toBe(true);
        expect(fixture.objects.size).toBe(0);
        expect(destroy).not.toHaveBeenCalled();
        await expect(store.readVerified(scope, evidence)).rejects.toThrow(
          "us_request_worker_unknown_failure",
        );
      } finally {
        resources?.dispose();
        release?.();
        await settlement;
        fixture?.destroy();
      }
    }),
  );
});
