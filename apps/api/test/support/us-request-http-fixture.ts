import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { hashPassword } from "better-auth/crypto";
import { createUsDevelopmentApplication } from "../../src/deployment/us-bootstrap";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
  type UsRequestBuildRoots,
} from "../../src/deployment/us-request-build-descriptor";
import { listenOnLoopback } from "./listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./us-auth-client";
import { createUsProfileTestDatabase } from "./us-profile-database";
import { seedCompleteReceiving } from "./us-receiving-fixture";
import { createUsRequestBuildFixture, localBuildEnv } from "./us-request-build-fixture";
import {
  createUsRequestWorkerStorageFixture,
  storageEnvironment,
} from "./us-request-worker-storage-fixture";

export interface UsRequestHttpFixture {
  app: INestApplication;
  database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  build: Awaited<ReturnType<typeof createUsRequestBuildFixture>>;
  storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  roots: UsRequestBuildRoots;
  context: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  client: UsAuthTestClient;
  transport(input: Request): Promise<Response>;
  close(): Promise<void>;
  restart(storage: boolean): Promise<void>;
  passwordSessionStatus: number;
  request(path: string, method?: string, body?: unknown, headers?: HeadersInit): Promise<Response>;
}
export async function createUsRequestHttpFixture(
  options: { storage?: boolean; build?: "clean" | "missing" | "dirty"; mfa?: boolean } = {},
): Promise<UsRequestHttpFixture> {
  const base = process.env.US_TEST_DATABASE_URL;
  if (!base) throw new Error("Explicit isolated US database URL required");
  let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
  let build: Awaited<ReturnType<typeof createUsRequestBuildFixture>> | undefined;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture> | undefined;
  let app: INestApplication | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await app?.close();
    } finally {
      try {
        storage?.destroy();
      } finally {
        try {
          await build?.dispose();
        } finally {
          await database?.close();
        }
      }
    }
  }
  try {
    database = await createUsProfileTestDatabase(base);
    build = await createUsRequestBuildFixture();
    const document = await captureUsRequestBuildDescriptor(build.cleanBuild, build.roots);
    if (options.build !== "missing")
      await build.writeDocument(
        options.build === "dirty"
          ? { ...document, build: { ...document.build, dirty: true } }
          : document,
      );
    storage = createUsRequestWorkerStorageFixture();
    const owned = database;
    const identity = await owned.pool.query("SELECT current_database() AS name");
    const target = new URL(base);
    target.pathname = `/${String(identity.rows[0]?.name)}`;
    const roots = build.roots;
    // The temporary URL never escapes this fixture-owned connection seam.
    const transportStorage = storage;
    let serverUrl = "";
    async function start(configured: boolean) {
      app = await createUsDevelopmentApplication(
        { ...(await localBuildEnv()), ...(configured ? storageEnvironment() : {}) },
        (_url, settings) => createDb(target.toString(), settings),
        undefined,
        {
          loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, roots),
          packageTransport: transportStorage.transport,
        },
      );
      await app.init();
      await listenOnLoopback(app);
      serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    }
    await start(options.storage !== false);
    async function transport(input: Request): Promise<Response> {
      const body = await input.text();
      return new Promise((resolve, reject) => {
        const headers = new Headers(input.headers);
        if (!headers.has("host")) headers.set("host", "localhost:3100");
        headers.set("content-length", String(Buffer.byteLength(body)));
        const url = new URL(input.url);
        const req = httpRequest(
          `${serverUrl}${url.pathname}${url.search}`,
          { method: input.method, headers: Object.fromEntries(headers) },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              const resultHeaders = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (Array.isArray(value))
                  for (const entry of value) resultHeaders.append(key, entry);
                else if (value !== undefined) resultHeaders.set(key, value);
              }
              resolve(
                new Response(
                  response.statusCode === 204 || input.method === "HEAD"
                    ? null
                    : Buffer.concat(chunks),
                  { status: response.statusCode ?? 500, headers: resultHeaders },
                ),
              );
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    }
    const context = await seedCompleteReceiving(database.db);
    const password = "Synthetic-US-request-password-42!";
    await database.db.insert(schema.account).values({
      id: randomUUID(),
      userId: context.actor,
      accountId: context.actor,
      providerId: "credential",
      password: await hashPassword(password),
    });
    const client = new UsAuthTestClient(transport);
    const signedIn = await client.request("/sign-in/email", {
      email: `${context.actor}@example.test`,
      password,
    });
    if (signedIn.status !== 200) throw new Error("Synthetic sign-in failed");
    const passwordSessionStatus = (
      await transport(
        new Request("http://localhost:3100/traceability/requests", { headers: client.headers() }),
      )
    ).status;
    if (options.mfa !== false) {
      const enrollment = await client.request("/two-factor/enable", { password });
      const data: unknown = await enrollment.json();
      if (
        typeof data !== "object" ||
        data === null ||
        !("totpURI" in data) ||
        typeof data.totpURI !== "string"
      )
        throw new Error("Synthetic enrollment failed");
      if (
        (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
          .status !== 200
      )
        throw new Error("Synthetic verification failed");
    }
    if (
      options.mfa !== false &&
      (await client.request("/organization/set-active", { organizationId: context.tenant }))
        .status !== 200
    )
      throw new Error("Synthetic active tenant failed");
    return {
      get app() {
        if (!app) throw new Error("Fixture not started");
        return app;
      },
      database,
      build,
      storage,
      roots,
      context,
      client,
      transport,
      close,
      passwordSessionStatus,
      async restart(configured: boolean) {
        await app?.close();
        await start(configured);
      },
      request(path: string, method = "GET", body?: unknown, overrides?: HeadersInit) {
        const headers = client.headers();
        headers.set("origin", "http://localhost:5174");
        headers.set("content-type", "application/json");
        for (const [key, value] of new Headers(overrides)) headers.set(key, value);
        return transport(
          new Request(`http://localhost:3100${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
