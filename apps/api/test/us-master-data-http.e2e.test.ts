import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { hashPassword } from "better-auth/crypto";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { listenOnLoopback } from "./support/listen-loopback";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-master-data-password-42!";

function httpFetch(
  url: string,
  init: { method?: string; headers?: Headers | Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-length", String(Buffer.byteLength(init.body)));
    const request = httpRequest(
      url,
      { method: init.method ?? "GET", headers: Object.fromEntries(headers) },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

describe.skipIf(!base)("US master-data HTTP with real MFA and isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  let serverUrl: string;
  let userId: string;
  let tenantId: string;
  let email: string;
  let hash: string;
  let client: UsAuthTestClient;
  let clock = Date.now();

  async function transport(input: Request): Promise<Response> {
    const headers = new Headers(input.headers);
    headers.set("host", "localhost:3100");
    return httpFetch(`${serverUrl}${new URL(input.url).pathname}`, {
      method: input.method,
      headers,
      ...(input.method === "GET" ? {} : { body: await input.text() }),
    });
  }

  function masterRequest(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const headers = client.headers();
    headers.set("host", "localhost:3100");
    headers.set("origin", "http://localhost:5174");
    if (body !== undefined) headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return httpFetch(`${serverUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function login() {
    expect((await client.request("/sign-in/email", { email, password })).status).toBe(200);
    const enrollment = await client.request("/two-factor/enable", { password });
    expect(enrollment.status).toBe(200);
    const data = (await enrollment.json()) as { totpURI?: unknown };
    if (typeof data.totpURI !== "string") throw new Error("Invalid synthetic enrollment");
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(200);
    expect(
      (await client.request("/organization/set-active", { organizationId: tenantId })).status,
    ).toBe(200);
  }

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(base);
    const identity = await fixture.pool.query("SELECT current_database() AS name");
    const url = new URL(base);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    app = await createUsDevelopmentApplication(
      parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
      (_url, options) => {
        connection = createDb(url.toString(), options);
        return connection;
      },
    );
    await app.init();
    await listenOnLoopback(app);
    const address: AddressInfo = app.getHttpServer().address();
    serverUrl = `http://127.0.0.1:${address.port}`;
    hash = await hashPassword(password);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await fixture?.close();
  });

  beforeEach(async () => {
    clock += 60_000;
    vi.setSystemTime(clock);
    userId = randomUUID();
    tenantId = randomUUID();
    email = `${userId}@example.test`;
    await fixture.db
      .insert(schema.user)
      .values({ id: userId, name: "Synthetic HTTP owner", email });
    await fixture.db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: hash,
    });
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US HTTP", slug: tenantId, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      userId,
      organizationId: tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: userId,
    });
    await fixture.db.insert(schema.orgProfiles).values({ tenantId, timeZone: "America/Chicago" });
    client = new UsAuthTestClient(transport);
    await login();
  });

  it("serves strict party and location CRUD contracts with server-owned audit identity", async () => {
    const partyResponse = await masterRequest("/traceability/parties", "POST", {
      name: "HTTP Party",
    });
    expect(partyResponse.status).toBe(201);
    const requestId = partyResponse.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    if (!requestId) throw new Error("Missing server request ID");
    const party = (await partyResponse.json()) as { id: string; updatedAt: string };
    expect(party).toMatchObject({ name: "HTTP Party", archived: false });
    expect((await masterRequest(`/traceability/parties/${party.id}`)).status).toBe(200);
    expect((await masterRequest("/traceability/parties?limit=1&offset=0")).status).toBe(200);

    const locationResponse = await masterRequest("/traceability/locations", "POST", {
      partyId: party.id,
      name: "HTTP Dock",
      businessName: "HTTP Dock",
    });
    expect(locationResponse.status).toBe(201);
    const location = (await locationResponse.json()) as { id: string };
    expect(location).toMatchObject({
      partyId: party.id,
      descriptionStatus: { exportReady: false, issues: expect.any(Array) },
    });
    const patched = await masterRequest(`/traceability/locations/${location.id}`, "PATCH", {
      roles: ["supplier", "processor"],
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ roles: ["supplier", "processor"] });

    const [audit] = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, requestId));
    expect(audit).toMatchObject({
      organizationId: tenantId,
      actorUserId: userId,
      targetType: "traceability_party",
      targetId: party.id,
      before: null,
    });
  });

  it("uses fresh membership capabilities for every master-data request", async () => {
    const created = await masterRequest("/traceability/parties", "POST", { name: "Readable" });
    const party = (await created.json()) as { id: string };
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    expect((await masterRequest(`/traceability/parties/${party.id}`)).status).toBe(200);
    expect((await masterRequest("/traceability/parties", "POST", { name: "Blocked" })).status).toBe(
      403,
    );
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    expect((await masterRequest("/traceability/parties")).status).toBe(403);
  });

  it("serves fresh presentation capabilities without leaking identity or requiring a profile", async () => {
    const owner = await masterRequest("/traceability/access");
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      capabilities: [
        "traceability.read",
        "traceability.master_data.write",
        "traceability.receiving.write",
        "traceability.transformation.write",
        "traceability.shipping.write",
        "traceability.qa.manage",
        "traceability.export.read",
        "tenant.settings.manage",
        "members.manage",
      ],
    });

    for (const [role, capabilities] of [
      [
        "manager",
        [
          "traceability.read",
          "traceability.master_data.write",
          "traceability.receiving.write",
          "traceability.transformation.write",
          "traceability.shipping.write",
        ],
      ],
      ["traceability_auditor", ["traceability.read", "traceability.export.read"]],
      ["unknown_us_role", []],
    ] as const) {
      await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.userId, userId));
      const response = await masterRequest("/traceability/access");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ capabilities });
    }

    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.userId, userId));
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    expect(await (await masterRequest("/traceability/access")).json()).toEqual({
      capabilities: [
        "traceability.read",
        "traceability.master_data.write",
        "traceability.receiving.write",
        "traceability.transformation.write",
        "traceability.shipping.write",
        "traceability.qa.manage",
        "traceability.export.read",
        "tenant.settings.manage",
        "members.manage",
      ],
    });

    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    expect((await masterRequest("/traceability/access")).status).toBe(403);

    const missingSession = await httpFetch(`${serverUrl}/traceability/access`, {
      headers: { host: "localhost:3100", origin: "http://localhost:5174" },
    });
    expect(missingSession.status).toBe(401);
  });

  it("rejects foreign identifiers, client-owned fields and immutable location party identity", async () => {
    const foreignId = randomUUID();
    expect((await masterRequest(`/traceability/parties/${foreignId}`)).status).toBe(404);
    expect((await masterRequest("/traceability/parties?forged=1")).status).toBe(400);
    expect(
      (
        await masterRequest("/traceability/parties", "POST", {
          name: "Forged",
          tenantId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    const party = (await (
      await masterRequest("/traceability/parties", "POST", { name: "Party" })
    ).json()) as { id: string };
    const location = (await (
      await masterRequest("/traceability/locations", "POST", {
        partyId: party.id,
        name: "Dock",
        businessName: "Dock",
      })
    ).json()) as { id: string };
    expect(
      (
        await masterRequest(`/traceability/locations/${location.id}`, "PATCH", {
          partyId: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });

  it("applies trusted host/origin/body limits and exposes no DELETE or RU routes", async () => {
    expect(
      (
        await masterRequest(
          "/traceability/parties",
          "POST",
          { name: "Wrong origin" },
          { origin: "http://localhost:5173" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await masterRequest(
          "/traceability/parties",
          "POST",
          { name: "Wrong host" },
          { host: "untrusted.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await masterRequest("/traceability/parties", "POST", {
          name: "x".repeat(17 * 1024),
        })
      ).status,
    ).toBe(413);
    expect((await masterRequest("/traceability/parties", "DELETE", {})).status).toBe(404);
    expect((await masterRequest("/traceability/locations", "DELETE", {})).status).toBe(404);
    expect((await masterRequest("/api/auth/get-session")).status).toBe(404);
  });

  it("fails closed when the persisted US profile is missing or invalid", async () => {
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ baselineVersion: "invalid-baseline" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    const invalid = await masterRequest("/traceability/parties");
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({ code: "traceability_profile_invalid" });
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    const missing = await masterRequest("/traceability/parties");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: "traceability_profile_required" });
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    const readerMissing = await masterRequest("/traceability/parties");
    expect(readerMissing.status).toBe(403);
    expect(await readerMissing.json()).toMatchObject({ code: "traceability_profile_required" });
  });

  it("documents strict shared request, query and response contracts in OpenAPI", async () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("US development").setVersion("0").build(),
    );
    const createParty = document.paths["/traceability/parties"]?.post;
    const partyList = document.paths["/traceability/parties"]?.get;
    const getParty = document.paths["/traceability/parties/{id}"]?.get;
    const updateParty = document.paths["/traceability/parties/{id}"]?.patch;
    const createLocation = document.paths["/traceability/locations"]?.post;
    const locationList = document.paths["/traceability/locations"]?.get;
    const getLocation = document.paths["/traceability/locations/{id}"]?.get;
    const updateLocation = document.paths["/traceability/locations/{id}"]?.patch;
    const access = document.paths["/traceability/access"]?.get;
    expect(createParty).toBeDefined();
    expect(access?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["capabilities"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(JSON.stringify(access)).not.toMatch(/tenantId|userId|sessionId|roles/);
    expect(partyList?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "limit", in: "query" })]),
    );
    expect(JSON.stringify(createParty)).not.toContain("tenantId");
    expect(JSON.stringify(updateLocation?.requestBody)).not.toContain('"partyId"');
    expect(JSON.stringify(createParty)).toContain('"additionalProperties":false');
    expect(createParty?.responses["400"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            oneOf: expect.arrayContaining([
              {
                type: "object",
                required: ["code", "issues"],
                additionalProperties: false,
                properties: {
                  code: { type: "string", enum: ["invalid_master_data"] },
                  issues: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["path", "message"],
                      additionalProperties: false,
                      properties: {
                        path: { type: "string" },
                        message: { type: "string" },
                      },
                    },
                  },
                },
              },
            ]),
          },
        },
      },
    });
    const badRequest = createParty?.responses["400"];
    if (!badRequest || !("content" in badRequest)) throw new Error("Missing 400 response");
    const errorSchema = badRequest.content?.["application/json"]?.schema;
    if (!errorSchema) throw new Error("Missing 400 response schema");
    const validator = z.fromJSONSchema(errorSchema as z.core.JSONSchema.JSONSchema, {
      defaultTarget: "openapi-3.0",
    });
    const invalidParty = await masterRequest("/traceability/parties", "POST", { name: "" });
    expect(invalidParty.status).toBe(400);
    const errorBody: unknown = await invalidParty.json();
    expect(errorBody).toMatchObject({
      code: "invalid_master_data",
      issues: [expect.objectContaining({ path: "name", message: expect.any(String) })],
    });
    expect(validator.safeParse(errorBody).success).toBe(true);
    expect(validator.safeParse({ code: "us_invalid_body" }).success).toBe(true);
    expect(
      validator.safeParse({ statusCode: 400, message: "Bad Request", error: "Bad Request" })
        .success,
    ).toBe(true);
    for (const malformed of [
      { code: "invalid_master_data" },
      { code: "invalid_master_data", issues: "name" },
      { code: "invalid_master_data", issues: [{ path: "name" }] },
      { code: "invalid_master_data", issues: [{ path: 42, message: "required" }] },
    ])
      expect(validator.safeParse(malformed).success).toBe(false);
    expect(createParty?.responses).toHaveProperty("409");
    expect(updateParty?.responses).toHaveProperty("409");
    for (const operation of [
      partyList,
      getParty,
      createLocation,
      locationList,
      getLocation,
      updateLocation,
    ]) {
      expect(operation?.responses).not.toHaveProperty("409");
    }
  });

  it("maps a missing master-data table to the existing safe database 503", async () => {
    await fixture.pool.query(
      "ALTER TABLE traceability_locations RENAME TO us_test_missing_traceability_locations",
    );
    try {
      const response = await masterRequest("/traceability/locations");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "us_database_unavailable" });
    } finally {
      await fixture.pool.query(
        "ALTER TABLE us_test_missing_traceability_locations RENAME TO traceability_locations",
      );
    }
  });
});
