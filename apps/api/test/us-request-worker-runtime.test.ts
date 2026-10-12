import { createDb } from "@markiro/db";
import { S3Client } from "@aws-sdk/client-s3";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsRequestWorkerRuntime } from "../src/deployment/us-request-worker-runtime";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import { storageEnvironment } from "./support/us-request-worker-storage-fixture";

const planSettings = {
  US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
  US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-request-plan-test",
  US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-plan-access",
  US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-plan-secret",
  US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
};

describe("resource-owning US request worker composition", () => {
  let fixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
  const connections: ReturnType<typeof createDb>[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) {
      if (!connection.pool.ended) await connection.pool.end();
    }
    await fixture?.dispose();
    fixture = undefined;
  });
  const env = async () => ({ ...(await localBuildEnv()), ...storageEnvironment() });
  const loadBuild = async (raw: NodeJS.ProcessEnv) => {
    fixture = await createUsRequestBuildFixture();
    await fixture.writeDocument(
      await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    );
    return loadUsRequestBuildDescriptor(raw, fixture.roots);
  };
  const connect: typeof createDb = (url, options) => {
    const connection = createDb(url, options);
    connections.push(connection);
    // Substitute only external DB work; all accepted composition factories stay real.
    vi.spyOn(connection.db, "transaction").mockResolvedValue(undefined);
    return connection;
  };

  it.each([
    { MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { NODE_ENV: "production" },
    { US_REQUEST_PACKAGE_S3_ENDPOINT: "https://provider-secret.example" },
    { US_REQUEST_PACKAGE_S3_BUCKET: "" },
    { US_PLAN_ARTIFACT_S3_ENDPOINT: "https://plan-secret.example" },
  ])("refuses invalid configuration before build or DB ownership: %j", async (override) => {
    let connected = false;
    let loaded = false;
    await expect(
      createUsRequestWorkerRuntime(
        { ...(await env()), ...override },
        {
          connect: () => {
            connected = true;
            throw new Error("unexpected DB open");
          },
          loadBuild: async () => {
            loaded = true;
            throw new Error("unexpected build read");
          },
        },
      ),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(connected).toBe(false);
    expect(loaded).toBe(false);
  });

  it("refuses absent package storage before loading a descriptor or opening DB", async () => {
    let connected = false;
    let loaded = false;
    await expect(
      createUsRequestWorkerRuntime(await localBuildEnv(), {
        connect: () => {
          connected = true;
          throw new Error("unexpected DB open");
        },
        loadBuild: async () => {
          loaded = true;
          throw new Error("unexpected build read");
        },
      }),
    ).rejects.toThrow("us_request_worker_storage_unavailable");
    expect(connected).toBe(false);
    expect(loaded).toBe(false);
  });

  it("sanitizes descriptor failure before opening DB or creating storage clients", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    let connected = false;
    await expect(
      createUsRequestWorkerRuntime(await env(), {
        loadBuild: async () => {
          throw new Error("raw descriptor credentials");
        },
        connect: () => {
          connected = true;
          throw new Error("unexpected DB open");
        },
      }),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(connected).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("rejects a forged descriptor before DB ownership", async () => {
    fixture = await createUsRequestBuildFixture();
    const document = await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots);
    let connected = false;
    await expect(
      createUsRequestWorkerRuntime(await env(), {
        loadBuild: async () => ({ document, digest: "a".repeat(64) }),
        connect: () => {
          connected = true;
          throw new Error("unexpected DB open");
        },
      }),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(connected).toBe(false);
  });

  it("refuses misdirected workspace resolution with correct inventories before connecting", async () => {
    fixture = await createUsRequestBuildFixture();
    await fixture.writeDocument(
      await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
    );
    const outside = join(fixture.root, "stale-db");
    await mkdir(outside);
    await writeFile(join(outside, "package.json"), JSON.stringify({ main: "index.js" }));
    await writeFile(join(outside, "index.js"), "module.exports = {};\n");
    await mkdir(join(fixture.api, "node_modules/@markiro"), { recursive: true });
    await symlink(outside, join(fixture.api, "node_modules/@markiro/db"), "dir");
    const roots = fixture.roots;
    let connected = false;
    await expect(
      createUsRequestWorkerRuntime(await env(), {
        loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
        connect: () => {
          connected = true;
          throw new Error("unexpected DB open");
        },
      }),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(connected).toBe(false);
  });

  it("unwinds both owned clients and the bounded pool once when schema preflight fails", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    let end: ReturnType<typeof vi.spyOn> | undefined;
    await expect(
      createUsRequestWorkerRuntime(
        { ...(await env()), ...planSettings },
        {
          loadBuild,
          connect: (url, options) => {
            expect(options).toEqual({
              max: 2,
              connectionTimeoutMillis: 2000,
              statement_timeout: 15000,
            });
            const connection = connect(url, options);
            end = vi.spyOn(connection.pool, "end");
            vi.spyOn(connection.db, "transaction").mockRejectedValue(
              new Error("SQL secret payload"),
            );
            return connection;
          },
        },
      ),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
    connections.splice(0);
  });

  it("joins repeated graceful stops and closes owned clients/pool once", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const runtime = await createUsRequestWorkerRuntime(
      { ...(await env()), ...planSettings },
      { loadBuild, connect, emit: () => {} },
    );
    const connection = connections[0];
    if (!connection) throw new Error("missing owned pool");
    const end = vi.spyOn(connection.pool, "end");
    const first = runtime.stop();
    expect(runtime.stop()).toBe(first);
    expect(await first).toEqual({ kind: "graceful" });
    await runtime.run();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
    connections.splice(0);
  });

  it("unwinds only already-owned resources if Plan client setup throws", async () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    let end: ReturnType<typeof vi.spyOn> | undefined;
    await expect(
      createUsRequestWorkerRuntime(
        { ...(await env()), ...planSettings },
        {
          loadBuild,
          connect: (url, options) => {
            const connection = connect(url, options);
            end = vi.spyOn(connection.pool, "end");
            return connection;
          },
          get planTransport(): never {
            throw new Error("raw partial startup provider secret");
          },
        },
      ),
    ).rejects.toThrow("us_request_worker_startup_refused");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    connections.splice(0);
  });

  it("keeps injected transports caller-owned when a graceful stop disposes the pool", async () => {
    const transport = { send: async () => ({}), destroy: vi.fn() };
    const runtime = await createUsRequestWorkerRuntime(
      { ...(await env()), ...planSettings },
      {
        loadBuild,
        connect,
        packageTransport: transport,
        planTransport: transport,
        emit: () => {},
      },
    );
    expect(await runtime.stop()).toEqual({ kind: "graceful" });
    expect(transport.destroy).not.toHaveBeenCalled();
    expect(connections[0]?.pool.ended).toBe(true);
    connections.splice(0);
  });

  it("turns an idle pool error into a sanitized lifetime failure with graceful disposal", async () => {
    vi.spyOn(UsRequestWorkerLifecycle.prototype, "claimNext").mockResolvedValue(null);
    const runtime = await createUsRequestWorkerRuntime(await env(), {
      loadBuild,
      connect,
      emit: () => {},
    });
    const connection = connections[0];
    if (!connection) throw new Error("missing owned pool");
    const lifetime = runtime.run();
    connection.pool.emit("error", new Error("raw SQL provider secret"));
    await expect(lifetime).rejects.toThrow("us_request_worker_fatal");
    expect(await runtime.stop()).toEqual({ kind: "graceful" });
    expect(connection.pool.ended).toBe(true);
    connections.splice(0);
  });

  it("does not close resources beneath an unsettled invocation at the drain deadline", async () => {
    vi.useFakeTimers();
    let release: (value: null) => void = () => {};
    vi.spyOn(UsRequestWorkerLifecycle.prototype, "claimNext").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const runtime = await createUsRequestWorkerRuntime(await env(), {
      loadBuild,
      connect,
      emit: () => {},
    });
    const connection = connections[0];
    if (!connection) throw new Error("missing owned pool");
    const end = vi.spyOn(connection.pool, "end");
    const lifetime = runtime.run();
    const drain = runtime.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await drain).toEqual({ kind: "force_exit" });
    expect(end).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    release(null);
    await lifetime;
    expect(runtime.stop()).toBe(drain);
    expect(end).not.toHaveBeenCalled();
  });
});
