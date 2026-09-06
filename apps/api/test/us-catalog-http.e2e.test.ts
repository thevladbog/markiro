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
import {
  traceabilityLotSchema,
  traceabilityLotListSchema,
  referenceDocumentSchema,
  referenceDocumentListSchema,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { listenOnLoopback } from "./support/listen-loopback";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-catalog-password-42!";
const profileInput = {
  expectedRevision: 0,
  productName: "HTTP Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSizeValue: "6",
  packagingSizeUom: "oz",
  packagingStyle: "cup",
  defaultQuantityUom: "case",
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
};

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

describe.skipIf(!base)("US catalog HTTP with real MFA and isolated PostgreSQL", () => {
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

  function catalogRequest(
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
      .values({ id: userId, name: "Synthetic catalog owner", email });
    await fixture.db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: hash,
    });
    await fixture.db.insert(schema.organization).values({
      id: tenantId,
      name: "Synthetic US catalog",
      slug: tenantId,
      createdAt: new Date(),
    });
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

  const documentInput = {
    type: "bol",
    typeOtherLabel: null,
    number: "=0001",
    partyId: null,
    issuedOn: "2026-09-14",
    notes: "Synthetic receipt",
  };
  async function createReference(body: unknown = documentInput) {
    const response = await catalogRequest("/traceability/reference-documents", "POST", body);
    expect(response.status).toBe(201);
    return referenceDocumentSchema.parse(await response.json());
  }

  it("US documents: creates and reads metadata with exact trusted audit", async () => {
    const response = await catalogRequest(
      "/traceability/reference-documents",
      "POST",
      documentInput,
      { "x-request-id": "forged-id" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requestId).not.toBe("forged-id");
    const saved = referenceDocumentSchema.parse(await response.json());
    expect(saved).toMatchObject({ ...documentInput, createdBy: userId });
    const detail = await catalogRequest(`/traceability/reference-documents/${saved.id}`);
    expect(detail.status).toBe(200);
    expect(referenceDocumentSchema.parse(await detail.json())).toEqual(saved);
    const list = await catalogRequest("/traceability/reference-documents?type=bol&search=%3D0001");
    expect(list.status).toBe(200);
    expect(referenceDocumentListSchema.parse(await list.json()).items).toEqual([saved]);
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId: tenantId,
        actorUserId: userId,
        action: "traceability.reference_document.created",
        outcome: "success",
        targetType: "traceability_reference_document",
        targetId: saved.id,
        before: null,
        after: saved,
        requestId,
      }),
    ]);
  });

  it("US documents: rejects duplicates and malformed inputs without extra writes", async () => {
    await createReference();
    const duplicate = await catalogRequest(
      "/traceability/reference-documents",
      "POST",
      documentInput,
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ code: "document_duplicate" });
    for (const patch of [
      { tenantId: "forged" },
      { createdBy: "forged" },
      { archivedAt: null },
      { issuedOn: "2026-02-29" },
      { attachmentObjectKey: "private" },
      { notes: "x\u0000y" },
    ])
      expect(
        (
          await catalogRequest("/traceability/reference-documents", "POST", {
            ...documentInput,
            ...patch,
          })
        ).status,
      ).toBe(400);
    for (const path of [
      "/traceability/reference-documents/invalid",
      "/traceability/reference-documents?limit=101",
      "/traceability/reference-documents?tenantId=foreign",
      "/traceability/reference-documents?search=x%00y",
    ])
      expect((await catalogRequest(path)).status).toBe(400);
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audit).toHaveLength(1);
  });

  it("US documents: respects fresh roles and MFA", async () => {
    const saved = await createReference();
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_shipping" })
      .where(eq(schema.member.organizationId, tenantId));
    await createReference({ ...documentInput, number: "SHIPPING" });
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.organizationId, tenantId));
    expect((await catalogRequest(`/traceability/reference-documents/${saved.id}`)).status).toBe(
      200,
    );
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", {
          ...documentInput,
          number: "NO",
        })
      ).status,
    ).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, tenantId));
    expect((await catalogRequest("/traceability/reference-documents")).status).toBe(403);
    expect(
      (
        await httpFetch(`${serverUrl}/traceability/reference-documents`, {
          headers: { host: "localhost:3100" },
        })
      ).status,
    ).toBe(401);
  });

  it("US documents: keeps foreign issuers and records invisible", async () => {
    const foreign = randomUUID(),
      foreignParty = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: foreign, name: "Foreign synthetic", slug: foreign, createdAt: new Date() });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: foreignParty, tenantId: foreign, name: "Foreign synthetic" });
    const [record] = await fixture.db
      .insert(schema.referenceDocuments)
      .values({ tenantId: foreign, type: "bol", number: "FOREIGN", createdBy: "historical" })
      .returning();
    expect((await catalogRequest(`/traceability/reference-documents/${record?.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", {
          ...documentInput,
          partyId: foreignParty,
        })
      ).status,
    ).toBe(404);
    const list = await catalogRequest("/traceability/reference-documents?search=FOREIGN");
    expect(list.status).toBe(200);
    expect(referenceDocumentListSchema.parse(await list.json()).items).toEqual([]);
  });

  it("US documents: preserves transport policy and leaves edits, attachments and events closed", async () => {
    const saved = await createReference();
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", documentInput, {
          host: "foreign.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", documentInput, {
          origin: "http://localhost:5173",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", documentInput, {
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await catalogRequest("/traceability/reference-documents", "POST", {
          ...documentInput,
          notes: "x".repeat(17000),
        })
      ).status,
    ).toBe(413);
    for (const method of ["PATCH", "PUT", "DELETE"])
      expect(
        (await catalogRequest(`/traceability/reference-documents/${saved.id}`, method, {})).status,
      ).toBe(404);
    for (const path of [
      `/traceability/reference-documents/${saved.id}/archive`,
      `/traceability/reference-documents/${saved.id}/attachment`,
      "/traceability/receivings",
      "/station/bootstrap",
    ])
      expect((await catalogRequest(path, "POST", {})).status).toBe(404);
    expect((await catalogRequest("/health/ready")).status).toBe(503);
  });

  it("US documents: exposes strict OpenAPI for only the supported routes", () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("US test").setVersion("0").build(),
    );
    const collection = document.paths["/traceability/reference-documents"];
    expect(Object.keys(collection ?? {}).sort()).toEqual(["get", "post"]);
    expect(Object.keys(document.paths["/traceability/reference-documents/{id}"] ?? {})).toEqual([
      "get",
    ]);
    expect(collection?.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { additionalProperties: false } } },
    });
    expect(collection?.post?.responses).toHaveProperty("409");
    expect(collection?.get?.responses).toHaveProperty("503");
    expect(JSON.stringify(collection?.post?.requestBody)).not.toContain("attachmentObjectKey");
  });

  it("US documents: sanitizes corrupt stored content at the HTTP boundary", async () => {
    const [record] = await fixture.db
      .insert(schema.referenceDocuments)
      .values({ tenantId, type: "bol", number: "🍎".repeat(65), createdBy: "historical" })
      .returning();
    const response = await catalogRequest(`/traceability/reference-documents/${record?.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "us_database_unavailable" });
  });

  it("US lot source: corrects a source through real MFA without changing the lot identity", async () => {
    const productId = randomUUID();
    const partyId = randomUUID();
    const locationId = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Source correction" });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId, name: "Source supplier" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: locationId,
      tenantId,
      partyId,
      name: "Source site",
      businessName: "Source site",
    });
    const lot = traceabilityLotSchema.parse(
      await (
        await catalogRequest("/traceability/lots", "POST", {
          productId,
          tlc: "Source-A",
          source: null,
        })
      ).json(),
    );
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(eq(schema.member.organizationId, tenantId));
    const body = {
      source: { kind: "location", locationId },
      expectedRevision: 1,
      reason: "Supplier confirmed the site",
    };
    const result = await catalogRequest(`/traceability/lots/${lot.id}/source`, "PATCH", body, {
      "x-request-id": "forged",
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const saved = traceabilityLotSchema.parse(await result.json());
    expect(saved).toEqual({
      ...lot,
      source: body.source,
      revision: 2,
      updatedAt: expect.any(String),
    });
    expect(
      await (await catalogRequest(`/traceability/lots/${lot.id}/source`, "PATCH", body)).json(),
    ).toEqual(saved);
    const audit = (
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
    ).filter((row) => row.action === "traceability.lot.source_changed");
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId: tenantId,
        actorUserId: userId,
        action: "traceability.lot.source_changed",
        targetType: "traceability_lot",
        targetId: lot.id,
        outcome: "success",
        before: lot,
        after: { ...saved, reason: body.reason },
        requestId: result.headers.get("x-request-id"),
      }),
    ]);
    expect(audit[0]?.requestId).not.toBe("forged");
    for (const patch of [
      { tlc: "changed" },
      { sourceLockedAt: null },
      { productId },
      { reason: " " },
      { expectedRevision: undefined },
    ]) {
      expect(
        (
          await catalogRequest(`/traceability/lots/${lot.id}/source`, "PATCH", {
            ...body,
            expectedRevision: 2,
            ...patch,
          })
        ).status,
      ).toBe(400);
    }
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.organizationId, tenantId));
    expect(
      (
        await catalogRequest(`/traceability/lots/${lot.id}/source`, "PATCH", {
          ...body,
          source: null,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(403);
  });
  it("US lot source: returns a documented lock conflict and keeps unlock routes absent", async () => {
    const productId = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Locked source" });
    const lot = traceabilityLotSchema.parse(
      await (
        await catalogRequest("/traceability/lots", "POST", {
          productId,
          tlc: "Locked-A",
          source: null,
        })
      ).json(),
    );
    await fixture.db
      .update(schema.traceabilityLots)
      .set({ sourceLockedAt: new Date() })
      .where(eq(schema.traceabilityLots.id, lot.id));
    const result = await catalogRequest(`/traceability/lots/${lot.id}/source`, "PATCH", {
      source: null,
      expectedRevision: 1,
      reason: "Cannot rewrite frozen source",
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ code: "lot_source_locked" });
    expect(
      (await catalogRequest(`/traceability/lots/${lot.id}/source/unlock`, "POST", {})).status,
    ).toBe(404);
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addCookieAuth("markiro-us.session_token").build(),
    );
    const path = document.paths["/traceability/lots/{id}/source"];
    expect(Object.keys(path ?? {})).toEqual(["patch"]);
    expect(path?.patch?.security).toEqual([{ "markiro-us.session_token": [] }]);
    expect(JSON.stringify(path?.patch?.requestBody)).toContain("expectedRevision");
    expect(JSON.stringify(path?.patch?.responses["409"])).toContain("lot_source_locked");
  });
  it("US lots: serves creation, lookup, list and QA status with exact server audit", async () => {
    const productId = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "HTTP lot apples", gtin14: null });
    const body = { productId, tlc: " =APPLE-01 ", source: null };
    const response = await catalogRequest("/traceability/lots", "POST", body, {
      "x-request-id": "forged",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const lot = traceabilityLotSchema.parse(await response.json());
    expect(lot).toMatchObject({
      productId,
      tlc: "=APPLE-01",
      source: null,
      status: "active",
      revision: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    expect(await (await catalogRequest(`/traceability/lots/${lot.id}`)).json()).toEqual(lot);
    const list = await catalogRequest("/traceability/lots?limit=1&offset=0&tlc=%3DAPPLE-01");
    expect(traceabilityLotListSchema.parse(await list.json())).toEqual({
      items: [lot],
      limit: 1,
      offset: 0,
    });
    const statusBody = {
      status: "quarantined",
      reason: "Synthetic QA review",
      expectedRevision: 1,
    };
    const changed = await catalogRequest(`/traceability/lots/${lot.id}/status`, "POST", statusBody);
    expect(changed.status).toBe(200);
    const after = traceabilityLotSchema.parse(await changed.json());
    expect(after).toMatchObject({ status: "quarantined", revision: 2 });
    expect(
      await (
        await catalogRequest(`/traceability/lots/${lot.id}/status`, "POST", statusBody)
      ).json(),
    ).toEqual(after);
    const duplicate = await catalogRequest("/traceability/lots", "POST", body);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ code: "LOT_DUPLICATE", existingId: lot.id });
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
      .orderBy(schema.tenantAuditEvents.createdAt);
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId: tenantId,
        actorUserId: userId,
        action: "traceability.lot.created",
        outcome: "success",
        targetType: "traceability_lot",
        targetId: lot.id,
        before: null,
        after: lot,
        requestId: response.headers.get("x-request-id"),
      }),
      expect.objectContaining({
        organizationId: tenantId,
        actorUserId: userId,
        action: "traceability.lot.status_changed",
        outcome: "success",
        targetType: "traceability_lot",
        targetId: lot.id,
        before: lot,
        after: { ...after, reason: "Synthetic QA review" },
        requestId: changed.headers.get("x-request-id"),
      }),
    ]);
  });

  it("US lots: requires current MFA session, membership and QA capability", async () => {
    expect(
      (await httpFetch(`${serverUrl}/traceability/lots`, { headers: { host: "localhost:3100" } }))
        .status,
    ).toBe(401);
    const productId = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "HTTP apples" });
    const lot = traceabilityLotSchema.parse(
      await (
        await catalogRequest("/traceability/lots", "POST", { productId, tlc: "A-1", source: null })
      ).json(),
    );
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(eq(schema.member.userId, userId));
    expect(
      (
        await catalogRequest(`/traceability/lots/${lot.id}/status`, "POST", {
          status: "recalled",
          reason: "Reviewed",
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    expect((await catalogRequest(`/traceability/lots/${lot.id}`)).status).toBe(200);
    expect(
      (await catalogRequest("/traceability/lots", "POST", { productId, tlc: "B-1", source: null }))
        .status,
    ).toBe(403);
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    expect((await catalogRequest("/traceability/lots")).status).toBe(403);
  });

  it("US lots: rejects forged metadata and unsupported assignments or methods", async () => {
    const productId = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "HTTP apples" });
    const body = { productId, tlc: "A-1", source: null };
    expect((await catalogRequest("/traceability/lots", "POST", { ...body, tenantId })).status).toBe(
      400,
    );
    expect((await catalogRequest("/traceability/lots/bad")).status).toBe(400);
    expect((await catalogRequest(`/traceability/lots/${randomUUID()}`)).status).toBe(404);
    const reserved = await catalogRequest("/traceability/lots", "POST", {
      ...body,
      assignmentBasis: "initial_packing",
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.json()).toEqual({ code: "ASSIGNMENT_BASIS_RESERVED" });
    expect(
      (
        await catalogRequest("/traceability/lots", "POST", {
          ...body,
          assignmentBasis: "transformation",
        })
      ).status,
    ).toBe(422);
    const lot = traceabilityLotSchema.parse(
      await (await catalogRequest("/traceability/lots", "POST", body)).json(),
    );
    expect(
      (
        await catalogRequest(`/traceability/lots/${lot.id}/status`, "POST", {
          status: "recalled",
          reason: "Reviewed",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await catalogRequest(`/traceability/lots/${lot.id}/status`, "POST", {
          status: "recalled",
          reason: "Reviewed",
          expectedRevision: 2,
        })
      ).status,
    ).toBe(409);
    expect((await catalogRequest(`/traceability/lots/${lot.id}`, "DELETE", {})).status).toBe(404);
    expect(
      (await catalogRequest(`/traceability/lots/${lot.id}`, "PATCH", { tlc: "changed" })).status,
    ).toBe(404);
    expect((await catalogRequest("/traceability/events")).status).toBe(404);
  });

  it("US lots: enforces mutation transport and sanitized database failure", async () => {
    const body = { productId: randomUUID(), tlc: "A-1", source: null };
    expect(
      (
        await catalogRequest("/traceability/lots", "POST", body, {
          origin: "https://wrong.example.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (await catalogRequest("/traceability/lots", "POST", body, { host: "wrong.example.test" }))
        .status,
    ).toBe(403);
    expect(
      (await catalogRequest("/traceability/lots", "POST", body, { "content-type": "text/plain" }))
        .status,
    ).toBe(415);
    expect(
      (await catalogRequest("/traceability/lots", "POST", { ...body, tlc: "a".repeat(17000) }))
        .status,
    ).toBe(413);
    await fixture.pool.query("ALTER TABLE traceability_lots RENAME TO us_test_missing_lots");
    try {
      const response = await catalogRequest("/traceability/lots");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await fixture.pool.query("ALTER TABLE us_test_missing_lots RENAME TO traceability_lots");
    }
  });

  it("US lots: documents only the isolated methods and revisioned status contract", () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addCookieAuth("markiro-us.session_token").build(),
    );
    expect(Object.keys(document.paths["/traceability/lots"] ?? {}).sort()).toEqual(["get", "post"]);
    expect(Object.keys(document.paths["/traceability/lots/{id}"] ?? {})).toEqual(["get"]);
    const status = document.paths["/traceability/lots/{id}/status"]?.post;
    expect(status?.responses["200"]).toBeDefined();
    expect(status?.security).toEqual([{ "markiro-us.session_token": [] }]);
    expect(JSON.stringify(status?.requestBody)).toContain("expectedRevision");
    expect(JSON.stringify(document.paths["/traceability/lots"]?.post?.responses["409"])).toContain(
      "existingId",
    );
  });

  it("serves catalog CRUD with server-owned principal, request ID and no-store responses", async () => {
    const createdResponse = await catalogRequest("/traceability/catalog/products", "POST", {
      name: "HTTP cereal",
      gtin: "96385074",
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const requestId = createdResponse.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    if (!requestId) throw new Error("Missing request ID");
    const created = (await createdResponse.json()) as { id: string; updatedAt: string };
    expect(created).toMatchObject({ name: "HTTP cereal", gtin14: "00000096385074" });
    expect((await catalogRequest(`/traceability/catalog/products/${created.id}`)).status).toBe(200);
    const list = await catalogRequest("/traceability/catalog/products?limit=1&offset=0");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [created], limit: 1, offset: 0 });
    const updated = await catalogRequest(
      `/traceability/catalog/products/${created.id}`,
      "PATCH",
      { gtin: null },
      { "x-request-id": "untrusted-request-id" },
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get("x-request-id")).not.toBe("untrusted-request-id");
    expect(await updated.json()).toMatchObject({ id: created.id, gtin14: null });
    const [audit] = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, requestId));
    expect(audit).toMatchObject({
      organizationId: tenantId,
      actorUserId: userId,
      targetType: "traceability_product",
      targetId: created.id,
      before: null,
    });

    const first = await catalogRequest("/traceability/catalog/products", "POST", {
      name: "First conflict owner",
      gtin: "036000291452",
    });
    expect(first.status).toBe(201);
    const conflict = await catalogRequest("/traceability/catalog/products", "POST", {
      name: "Second conflict owner",
      gtin: "00036000291452",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "product_gtin_taken" });
  });

  async function seedProfileProduct() {
    const id = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id, tenantId, name: "HTTP catalog product", gtin14: null });
    return { id, path: `/traceability/products/${id}` };
  }

  it("serves versioned profile GET/PUT with real MFA, owned request ID and atomic audit", async () => {
    const product = await seedProfileProduct();
    const defaults = await catalogRequest(product.path);
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get("cache-control")).toBe("no-store");
    expect(await defaults.json()).toMatchObject({
      productId: product.id,
      productName: "HTTP catalog product",
      revision: 0,
      createdAt: null,
      reviewedBy: null,
    });
    const saved = await catalogRequest(product.path, "PUT", profileInput, {
      "x-request-id": "forged",
    });
    expect(saved.status).toBe(200);
    const requestId = saved.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const after: unknown = await saved.json();
    expect(after).toMatchObject({
      productId: product.id,
      productName: "HTTP Apple Cups",
      revision: 1,
      packagingSizeValue: "6.000",
      reviewedBy: null,
    });
    expect(await (await catalogRequest(product.path)).json()).toEqual(after);
    const stale = await catalogRequest(product.path, "PUT", {
      ...profileInput,
      productName: "Stale overwrite",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "product_profile_conflict" });
    expect(await (await catalogRequest(product.path, "PUT", profileInput)).json()).toEqual(after);
    const events = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, product.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: tenantId,
      actorUserId: userId,
      action: "traceability.product_profile.updated",
      outcome: "success",
      targetType: "traceability_product_profile",
      targetId: product.id,
      requestId,
      after,
    });
  });

  it("enforces profile MFA, current write roles, tenant scoping and strict server-owned metadata", async () => {
    const product = await seedProfileProduct();
    const anonymous = await httpFetch(`${serverUrl}${product.path}`, {
      headers: { host: "localhost:3100" },
    });
    expect(anonymous.status).toBe(401);
    expect(
      (await catalogRequest(product.path, "PUT", { ...profileInput, reviewedBy: userId })).status,
    ).toBe(400);
    expect((await catalogRequest("/traceability/products/invalid")).status).toBe(400);
    expect(
      (await catalogRequest(`/traceability/products/${randomUUID()}`, "PUT", profileInput)).status,
    ).toBe(404);
    const foreignTenant = randomUUID();
    const foreignProduct = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: foreignTenant, name: "Foreign", slug: foreignTenant, createdAt: new Date() });
    await fixture.db
      .insert(schema.products)
      .values({ id: foreignProduct, tenantId: foreignTenant, name: "Foreign" });
    expect((await catalogRequest(`/traceability/products/${foreignProduct}`)).status).toBe(404);
    expect(
      (await catalogRequest(`/traceability/products/${foreignProduct}`, "PUT", profileInput))
        .status,
    ).toBe(404);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    expect((await catalogRequest(product.path)).status).toBe(200);
    expect((await catalogRequest(product.path, "PUT", profileInput)).status).toBe(403);
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id = $1)",
      [userId],
    );
    expect((await catalogRequest(product.path)).status).toBe(403);
  });

  it("requires QA for a profile review even when a manager has master-data write rights", async () => {
    const product = await seedProfileProduct();
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(eq(schema.member.userId, userId));
    expect((await catalogRequest(product.path, "PUT", profileInput)).status).toBe(200);
    const review = {
      ...profileInput,
      expectedRevision: 1,
      coverageStatus: "not_covered",
      coverageRationale: "Synthetic manual assessment",
    };
    expect((await catalogRequest(product.path, "PUT", review)).status).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_qa" })
      .where(eq(schema.member.userId, userId));
    const result = await catalogRequest(product.path, "PUT", review);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      coverageStatus: "not_covered",
      reviewedBy: userId,
      reviewedAt: new Date(clock).toISOString(),
      revision: 2,
    });
  });

  it("applies host/origin/JSON limits to profile PUT and sanitizes missing storage", async () => {
    const product = await seedProfileProduct();
    for (const [headers, expectedStatus] of [
      [{ host: "wrong.example" }, 403],
      [{ origin: "http://localhost:5173" }, 403],
      [{ "content-type": "text/plain" }, 415],
    ] as const)
      expect((await catalogRequest(product.path, "PUT", profileInput, headers)).status).toBe(
        expectedStatus,
      );
    expect(
      (
        await catalogRequest(product.path, "PUT", {
          ...profileInput,
          productName: "x".repeat(17000),
        })
      ).status,
    ).toBe(413);
    expect((await catalogRequest(product.path, "DELETE", {})).status).toBe(404);
    expect((await catalogRequest("/traceability/products")).status).toBe(404);
    await fixture.pool.query(
      "ALTER TABLE product_traceability_profiles RENAME TO us_test_missing_product_profiles",
    );
    try {
      for (const method of ["GET", "PUT"]) {
        const result = await catalogRequest(
          product.path,
          method,
          method === "PUT" ? profileInput : undefined,
        );
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({ code: "us_database_unavailable" });
      }
    } finally {
      await fixture.pool.query(
        "ALTER TABLE us_test_missing_product_profiles RENAME TO product_traceability_profiles",
      );
    }
  });

  it("publishes a strict versioned product profile OpenAPI contract", () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("US development").setVersion("0").build(),
    );
    const path = document.paths["/traceability/products/{productId}"];
    expect(path?.get?.responses).toHaveProperty("200");
    expect(path?.put?.responses).toHaveProperty("409");
    expect(path).not.toHaveProperty("delete");
    const body = JSON.stringify(path?.put?.requestBody);
    expect(body).toContain('"expectedRevision"');
    expect(body).toContain('"additionalProperties":false');
    expect(body).not.toContain('"reviewedBy"');
    expect(body).not.toContain('"tenantId"');
    for (const operation of [path?.get, path?.put]) {
      for (const status of ["400", "401", "403", "404", "413", "415", "503"])
        expect(operation?.responses).toHaveProperty(status);
    }
  });

  it("requires a real MFA session and fresh read/write membership", async () => {
    const anonymous = await httpFetch(`${serverUrl}/traceability/catalog/products`, {
      headers: { host: "localhost:3100", origin: "http://localhost:5174" },
    });
    expect(anonymous.status).toBe(401);
    const created = (await (
      await catalogRequest("/traceability/catalog/products", "POST", { name: "Readable" })
    ).json()) as { id: string };
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    expect((await catalogRequest(`/traceability/catalog/products/${created.id}`)).status).toBe(200);
    expect(
      (await catalogRequest("/traceability/catalog/products", "POST", { name: "Blocked" })).status,
    ).toBe(403);
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    expect((await catalogRequest("/traceability/catalog/products")).status).toBe(403);
  });

  it("rejects client-owned identity and hides cross-tenant products", async () => {
    expect(
      (
        await catalogRequest("/traceability/catalog/products", "POST", {
          name: "Forged",
          tenantId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    const foreignTenantId = randomUUID();
    await fixture.db.insert(schema.organization).values({
      id: foreignTenantId,
      name: "Foreign tenant",
      slug: foreignTenantId,
      createdAt: new Date(),
    });
    const [foreign] = await fixture.db
      .insert(schema.products)
      .values({ tenantId: foreignTenantId, name: "Foreign", gtin14: null })
      .returning({ id: schema.products.id });
    if (!foreign) throw new Error("Missing foreign fixture");
    expect((await catalogRequest(`/traceability/catalog/products/${foreign.id}`)).status).toBe(404);
    expect(
      (
        await catalogRequest(`/traceability/catalog/products/${foreign.id}`, "PATCH", {
          name: "Forged update",
        })
      ).status,
    ).toBe(404);
  });

  it("applies host, origin, JSON media type and body-size boundaries", async () => {
    expect(
      (
        await catalogRequest(
          "/traceability/catalog/products",
          "POST",
          { name: "Wrong origin" },
          { origin: "http://localhost:5173" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await catalogRequest(
          "/traceability/catalog/products",
          "POST",
          { name: "Wrong host" },
          { host: "untrusted.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await catalogRequest(
          "/traceability/catalog/products",
          "POST",
          { name: "Wrong type" },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await catalogRequest("/traceability/catalog/products", "POST", {
          name: "x".repeat(17 * 1024),
        })
      ).status,
    ).toBe(413);
    const malformed = await httpFetch(`${serverUrl}/traceability/catalog/products`, {
      method: "POST",
      headers: {
        ...Object.fromEntries(client.headers()),
        host: "localhost:3100",
        origin: "http://localhost:5174",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ code: "us_invalid_body" });
  });

  it("keeps RU, future catalog and destructive routes absent", async () => {
    expect((await catalogRequest("/products")).status).toBe(404);
    expect((await catalogRequest("/traceability/catalog/lots")).status).toBe(404);
    expect((await catalogRequest("/traceability/catalog/products", "DELETE", {})).status).toBe(404);
    expect(
      (await catalogRequest(`/traceability/catalog/products/${randomUUID()}`, "DELETE", {})).status,
    ).toBe(404);
  });

  it("keeps liveness green and readiness explicitly unavailable", async () => {
    const live = await httpFetch(`${serverUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });
    const ready = await httpFetch(`${serverUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ reason: "us_business_modules_not_ready" });
  });

  it("maps catalog database failures to the isolated safe 503", async () => {
    await fixture.pool.query("ALTER TABLE products RENAME TO us_test_missing_products");
    try {
      const response = await catalogRequest("/traceability/catalog/products");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "us_database_unavailable" });
    } finally {
      await fixture.pool.query("ALTER TABLE us_test_missing_products RENAME TO products");
    }
  });

  it("sanitizes corrupt stored products without partial lists, mutation or audit", async () => {
    const corruptId = randomUUID();
    await fixture.db.insert(schema.products).values({
      id: corruptId,
      tenantId,
      name: "Corrupt after insert",
      gtin14: null,
    });
    await fixture.db
      .update(schema.products)
      .set({ name: " " })
      .where(eq(schema.products.id, corruptId));

    const list = await catalogRequest("/traceability/catalog/products");
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({ code: "us_database_unavailable" });

    const get = await catalogRequest(`/traceability/catalog/products/${corruptId}`);
    expect(get.status).toBe(503);
    expect(await get.json()).toEqual({ code: "us_database_unavailable" });

    const update = await catalogRequest(`/traceability/catalog/products/${corruptId}`, "PATCH", {
      name: "Attempted repair",
    });
    expect(update.status).toBe(503);
    expect(await update.json()).toEqual({ code: "us_database_unavailable" });
    const [stored] = await fixture.db
      .select({ name: schema.products.name })
      .from(schema.products)
      .where(eq(schema.products.id, corruptId));
    expect(stored).toEqual({ name: " " });
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, corruptId)),
    ).toHaveLength(0);

    const invalidRequest = await catalogRequest("/traceability/catalog/products", "POST", {
      name: "",
    });
    expect(invalidRequest.status).toBe(400);
    expect(await invalidRequest.json()).toMatchObject({
      code: "invalid_master_data",
      issues: [expect.objectContaining({ path: "name" })],
    });
  });

  it("publishes strict OpenAPI payloads and observed error responses", async () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("US development").setVersion("0").build(),
    );
    const collection = document.paths["/traceability/catalog/products"];
    const item = document.paths["/traceability/catalog/products/{id}"];
    expect(collection?.get).toBeDefined();
    expect(collection?.post).toBeDefined();
    expect(item?.get).toBeDefined();
    expect(item?.patch).toBeDefined();
    expect(collection).not.toHaveProperty("delete");
    expect(item).not.toHaveProperty("delete");
    expect(collection?.get?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "limit", in: "query" })]),
    );
    expect(JSON.stringify(collection?.post)).not.toContain("tenantId");
    for (const operation of [collection?.get, collection?.post, item?.get, item?.patch]) {
      for (const status of ["400", "401", "403", "404", "413", "415", "503"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
    }
    expect(collection?.post?.responses).toHaveProperty("409");
    expect(item?.patch?.responses).toHaveProperty("409");
    const createSchema = collection?.post?.responses["201"];
    if (!createSchema || !("content" in createSchema)) throw new Error("Missing create schema");
    const responseSchema = createSchema.content?.["application/json"]?.schema;
    if (!responseSchema) throw new Error("Missing product schema");
    const responseValidator = z.fromJSONSchema(responseSchema as z.core.JSONSchema.JSONSchema, {
      defaultTarget: "openapi-3.0",
    });
    const created = await catalogRequest("/traceability/catalog/products", "POST", {
      name: "OpenAPI product",
    });
    expect(created.status).toBe(201);
    expect(responseValidator.safeParse(await created.json()).success).toBe(true);

    const badRequest = collection?.post?.responses["400"];
    if (!badRequest || !("content" in badRequest)) throw new Error("Missing 400 schema");
    const errorSchema = badRequest.content?.["application/json"]?.schema;
    if (!errorSchema) throw new Error("Missing error schema");
    const errorValidator = z.fromJSONSchema(errorSchema as z.core.JSONSchema.JSONSchema, {
      defaultTarget: "openapi-3.0",
    });
    const invalid = await catalogRequest("/traceability/catalog/products", "POST", { name: "" });
    expect(invalid.status).toBe(400);
    const invalidBody: unknown = await invalid.json();
    expect(invalidBody).toMatchObject({
      code: "invalid_master_data",
      issues: [expect.objectContaining({ path: "name", message: expect.any(String) })],
    });
    expect(errorValidator.safeParse(invalidBody).success).toBe(true);
    expect(errorValidator.safeParse({ code: "us_invalid_body" }).success).toBe(true);
  });
});
