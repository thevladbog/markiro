import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import { type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import { usEventListSchema } from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { seedMixedEvents } from "./support/us-events-fixture";
import { seedShippingLifecycle } from "./support/us-shipping-lifecycle-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-transformation-password-42!";

describe.skipIf(!base)("US Events HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedMixedEvents>>;

  function transport(input: Request): Promise<Response> {
    return input.text().then(
      (body) =>
        new Promise((resolve, reject) => {
          const headers = new Headers(input.headers);
          headers.set("host", input.headers.get("host") ?? "localhost:3100");
          headers.set("content-length", String(Buffer.byteLength(body)));
          const url = new URL(input.url);
          const request = httpRequest(
            `${serverUrl}${url.pathname}${url.search}`,
            {
              method: input.method,
              headers: Object.fromEntries(headers),
            },
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
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode ?? 500,
                    headers: resultHeaders,
                  }),
                );
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        }),
    );
  }
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const headers = client?.headers() ?? new Headers();
    headers.set("origin", "http://localhost:5174");
    headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return transport(
      new Request(`http://localhost:3100${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(base);
    const identity = await f.pool.query("SELECT current_database() AS name");
    const url = new URL(base);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    app = await createUsDevelopmentApplication(
      parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
      (_url, options) => createDb(url.toString(), options),
    );
    await app.init();
    await listenOnLoopback(app);
    serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    c = await seedMixedEvents(f);
    await f.db.insert(schema.account).values({
      id: randomUUID(),
      userId: c.actor,
      accountId: c.actor,
      providerId: "credential",
      password: await hashPassword(password),
    });
    client = new UsAuthTestClient(transport);
    expect(
      (
        await client.request("/sign-in/email", {
          email: `${c.actor}@example.test`,
          password,
        })
      ).status,
    ).toBe(200);
    const enrollment = await client.request("/two-factor/enable", { password });
    expect(enrollment.status).toBe(200);
    const data: unknown = await enrollment.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("totpURI" in data) ||
      typeof data.totpURI !== "string"
    )
      throw new Error("Invalid enrollment");
    expect(
      (
        await client.request("/two-factor/verify-totp", {
          code: currentUsTotp(data.totpURI),
        })
      ).status,
    ).toBe(200);
    expect(
      (await client.request("/organization/set-active", { organizationId: c.tenant })).status,
    ).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await f?.close();
  });

  it("exposes only the collection GET and returns a tenant-scoped bounded no-store page", async () => {
    const paths = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    expect(Object.keys(paths?.["/traceability/events"] ?? {})).toEqual(["get"]);
    expect((await request("/traceability/events", "GET", undefined, { cookie: "" })).status).toBe(
      401,
    );
    const response = await request("/traceability/events?limit=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = usEventListSchema.parse(await response.json());
    expect(page.items.map((row) => row.id)).toEqual(c.expectedFirstFourIds.slice(0, 2));
    expect((await request("/traceability/events", "POST", {})).status).toBe(404);
    expect((await request("/traceability/events/" + c.foreignEventId)).status).toBe(404);
  });
  it.each(["type=receiving&type=transformation", "limit=01", "offset=100001", "tenantId=other"])(
    "rejects invalid strict query %s",
    async (query) => {
      expect((await request("/traceability/events?" + query)).status).toBe(400);
    },
  );
  it("accepts Shipping filter while retaining tenant isolation", async () => {
    const shipping = await seedShippingLifecycle(f.db);
    const saved = await shipping.store.createDraft(
      shipping.tenant,
      shipping.actor,
      {
        operationKey: randomUUID(),
        draft: { ...shipping.draft, items: [], documentIds: [] },
      },
      "events-http-shipping",
    );
    const response = await request("/traceability/events?type=shipping");
    expect(response.status).toBe(200);
    expect(
      usEventListSchema.parse(await response.json()).items.some((row) => row.id === saved.id),
    ).toBe(false);
  });
  it("denies a fresh unauthorized membership before query parsing", async () => {
    await f.db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, c.member));
    expect((await request("/traceability/events?type=shipping")).status).toBe(403);
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
  });
  it("fails closed over HTTP for a malformed matching root beyond the requested page", async () => {
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE transformation_event_roots SET pending_draft_id=NULL WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
      );
    });
    try {
      const response = await request("/traceability/events?status=amended&offset=100000");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
    } finally {
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE transformation_event_roots SET pending_draft_id=${c.pending.eventId} WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
        );
      });
    }
  });
});
