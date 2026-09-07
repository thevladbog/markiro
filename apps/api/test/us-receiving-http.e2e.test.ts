import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import { receivingDraftListSchema, receivingDraftRecordSchema } from "@markiro/platform-contracts";
import {
  receivingFinalizedRecordSchema,
  receivingReadinessSchema,
  receivingRecordListSchema,
} from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  emptyReceivingDraft as empty,
  emptyReceivingItem as item,
  seedReceivingTenant,
  seedCompleteReceiving,
  seedExemptReceiving,
} from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-receiving-password-42!";
describe.skipIf(!base)("US receiving HTTP with real MFA", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string, hash: string;
  let context: Awaited<ReturnType<typeof seedReceivingTenant>>;
  let client: UsAuthTestClient;
  let clock = Date.now();

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
    const headers = client.headers();
    headers.set("origin", "http://localhost:5174");
    if (body !== undefined) headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return transport(
      new Request(`http://localhost:3100${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  const createBody = () => ({ operationKey: randomUUID(), draft: empty });

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(base);
    const identity = await fixture.pool.query("SELECT current_database() AS name");
    const url = new URL(base);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    app = await createUsDevelopmentApplication(
      parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
      (_url, options) => createDb(url.toString(), options),
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
    context = await seedReceivingTenant(fixture.db);
    await fixture.db.insert(schema.account).values({
      id: randomUUID(),
      userId: context.actor,
      accountId: context.actor,
      providerId: "credential",
      password: hash,
    });
    client = new UsAuthTestClient(transport);
    expect(
      (await client.request("/sign-in/email", { email: `${context.actor}@example.test`, password }))
        .status,
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
      throw new Error("Invalid synthetic enrollment");
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(200);
    expect(
      (await client.request("/organization/set-active", { organizationId: context.tenant })).status,
    ).toBe(200);
  });

  it("creates, reads, saves and replays drafts with server request IDs and exact audit", async () => {
    const body = { ...createBody(), draft: { ...empty, documentIds: [context.document] } };
    const response = await request("/traceability/receiving", "POST", body, {
      "x-request-id": "forged",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const created = receivingDraftRecordSchema.parse(await response.json());
    expect(await (await request(`/traceability/receiving/${created.id}`)).json()).toEqual(created);
    const saved = await request(`/traceability/receiving/${created.id}`, "PUT", {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...empty, notes: "saved" },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      id: created.id,
      draftVersion: 2,
      revision: 1,
      status: "draft",
    });
    expect(await (await request("/traceability/receiving", "POST", body)).json()).toEqual(created);
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, created.id));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      organizationId: context.tenant,
      actorUserId: context.actor,
      targetId: created.id,
      action: "traceability.receiving.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      requestId,
      before: null,
      after: created,
    });
  });
  it("lists draft summaries through strict query parsing without caching or audit", async () => {
    const created = receivingDraftRecordSchema.parse(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const response = await request(
      `/traceability/receiving?search=${encodeURIComponent(`  ${created.eventNumber.toLowerCase()}  `)}&limit=1&offset=0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(receivingDraftListSchema.parse(await response.json())).toEqual({
      items: [
        {
          id: created.id,
          eventNumber: created.eventNumber,
          status: "draft",
          revision: 1,
          draftVersion: 1,
          timeZone: created.timeZone,
          createdBy: context.actor,
          updatedBy: context.actor,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          dateReceived: null,
          locationId: null,
          previousSourceLocationId: null,
          lineCount: 0,
          documentCount: 0,
        },
      ],
      limit: 1,
      offset: 0,
    });
    expect((await request("/traceability/receiving?unknown=value")).status).toBe(400);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, created.id)),
    ).toHaveLength(1);
  });
  it("requires current role and MFA even on retries; readers cannot write", async () => {
    const body = createBody();
    const created = receivingDraftRecordSchema.parse(
      await (await request("/traceability/receiving", "POST", body)).json(),
    );
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, context.member));
    expect((await request("/traceability/receiving")).status).toBe(200);
    expect((await request(`/traceability/receiving/${created.id}`)).status).toBe(200);
    expect((await request("/traceability/receiving", "POST", body)).status).toBe(403);
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id=$1)",
      [context.actor],
    );
    expect((await request("/traceability/receiving")).status).toBe(403);
    expect((await request(`/traceability/receiving/${created.id}`)).status).toBe(403);
    expect(
      (await request(`/traceability/receiving/${created.id}`, "GET", undefined, { cookie: "" }))
        .status,
    ).toBe(401);
  });
  it("reads saved readiness with strict version, current read permission, MFA and no writes", async () => {
    const created = receivingDraftRecordSchema.parse(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const path = `/traceability/receiving/${created.id}/readiness`;
    const response = await request(`${path}?expectedDraftVersion=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      eventId: created.id,
      draftVersion: 1,
      state: "blocked",
    });
    const stale = await request(`${path}?expectedDraftVersion=2`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "receiving_draft_conflict" });
    for (const query of [
      "",
      "?expectedDraftVersion=0",
      "?expectedDraftVersion=01",
      "?expectedDraftVersion=1&expectedDraftVersion=1",
      "?expectedDraftVersion=1&tenantId=forged",
    ])
      expect((await request(`${path}${query}`)).status).toBe(400);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, context.member));
    expect((await request(`${path}?expectedDraftVersion=1`)).status).toBe(200);
    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.id, context.member));
    expect((await request(`${path}?expectedDraftVersion=1`)).status).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, context.member));
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id=$1)",
      [context.actor],
    );
    expect((await request(`${path}?expectedDraftVersion=1`)).status).toBe(403);
    expect(
      (await request(`${path}?expectedDraftVersion=1`, "GET", undefined, { cookie: "" })).status,
    ).toBe(401);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, created.id)),
    ).toHaveLength(1);
  });
  it("rejects tenant injection, foreign targets and stale saves with precise safe errors", async () => {
    expect(
      (await request("/traceability/receiving", "POST", { ...createBody(), tenantId: "forged" }))
        .status,
    ).toBe(400);
    expect((await request("/traceability/receiving/not-a-uuid")).status).toBe(400);
    const foreign = await seedReceivingTenant(fixture.db);
    const foreignDraft = await new UsReceivingStore(fixture.db).createDraft(
      foreign.tenant,
      foreign.actor,
      createBody(),
      "foreign-request",
    );
    expect((await request(`/traceability/receiving/${foreignDraft.id}`)).status).toBe(404);
    expect(
      (await request(`/traceability/receiving/${foreignDraft.id}/readiness?expectedDraftVersion=1`))
        .status,
    ).toBe(404);
    expect(
      (
        await request(`/traceability/receiving/${foreignDraft.id}`, "PUT", {
          ...createBody(),
          expectedDraftVersion: 1,
        })
      ).status,
    ).toBe(404);
    const created = receivingDraftRecordSchema.parse(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const stale = await request(`/traceability/receiving/${created.id}`, "PUT", {
      ...createBody(),
      expectedDraftVersion: 2,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "receiving_draft_conflict" });
  });
  it("supports 100 incomplete rows only on exact receiving write paths and retains transport protections", async () => {
    const body = {
      ...createBody(),
      draft: { ...empty, items: Array.from({ length: 100 }, () => item) },
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(16384);
    const response = await request("/TRACEABILITY/RECEIVING/", "POST", body);
    expect(response.status).toBe(201);
    const created = receivingDraftRecordSchema.parse(await response.json());
    expect(
      (
        await request(`/traceability/receiving/${created.id}/`, "PUT", {
          ...body,
          expectedDraftVersion: 1,
        })
      ).status,
    ).toBe(200);
    for (const [headers, status] of [
      [{ host: "foreign.example" }, 403],
      [{ origin: "http://localhost:5173" }, 403],
      [{ "content-type": "text/plain" }, 415],
      [{ "content-encoding": "gzip" }, 415],
    ] as const) {
      expect((await request("/traceability/receiving", "POST", createBody(), headers)).status).toBe(
        status,
      );
    }
    for (const path of [
      "/traceability/reference-documents",
      "/api/us-auth/sign-in/email",
      "/traceability/receiving/not-a-uuid",
      `/traceability/receiving/${created.id}/finalize`,
    ]) {
      expect((await request(path, "POST", body)).status).toBe(413);
    }
    expect(
      (
        await request("/traceability/receiving", "POST", {
          ...body,
          draft: { ...body.draft, notes: "x".repeat(262144) },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request("/traceability/receiving", "POST", {
          ...body,
          draft: { ...body.draft, items: [...body.draft.items, item] },
        })
      ).status,
    ).toBe(400);
  });
  it("keeps unsupported lifecycle/delete routes closed and documents the list and editor routes", async () => {
    const id = randomUUID();
    for (const path of [
      `/traceability/receiving/${id}/amend`,
      `/traceability/receiving/${id}/void`,
      "/traceability/receiving/import",
    ])
      expect((await request(path, "POST", {})).status).toBe(404);
    expect((await request(`/traceability/receiving/${id}`, "DELETE", {})).status).toBe(404);
    const api = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("US synthetic").build(),
    );
    expect(Object.keys(api.paths["/traceability/receiving"] ?? {}).sort()).toEqual(["get", "post"]);
    expect(api.paths["/traceability/receiving"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "query", name: "search", required: false }),
        expect.objectContaining({ in: "query", name: "limit" }),
        expect.objectContaining({ in: "query", name: "offset" }),
      ]),
    );
    expect(api.paths["/traceability/receiving"]?.get?.responses).toHaveProperty("200");
    expect(Object.keys(api.paths["/traceability/receiving/{id}"] ?? {}).sort()).toEqual([
      "get",
      "put",
    ]);
    expect(api.paths["/traceability/receiving/{id}"]?.put?.responses).toHaveProperty("409");
    expect(api.paths["/traceability/receiving/{id}/finalize"]?.post?.responses).toHaveProperty(
      "200",
    );
    expect(
      api.paths["/traceability/receiving/{id}/finalize"]?.post?.responses["409"],
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                required: ["code", "issues"],
                properties: expect.objectContaining({
                  issues: expect.objectContaining({ type: "array" }),
                }),
              }),
            ]),
          },
        },
      },
    });
    expect(Object.keys(api.paths["/traceability/receiving/{id}/readiness"] ?? {})).toEqual(["get"]);
    expect(api.paths["/traceability/receiving/{id}/readiness"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "query", name: "expectedDraftVersion", required: true }),
      ]),
    );
  });
  it("finalizes with HTTP200 and replays with fresh QA and MFA while exposing frozen mixed reads", async () => {
    const complete = await seedCompleteReceiving(fixture.db, context);
    const created = receivingDraftRecordSchema.parse(
      await (
        await request("/traceability/receiving", "POST", {
          operationKey: randomUUID(),
          draft: complete.draft,
        })
      ).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    const check = receivingReadinessSchema.parse(
      await (await request(`${path}/readiness?expectedDraftVersion=1`)).json(),
    );
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: check.inputDigest,
    };
    const response = await request(`${path}/finalize`, "POST", command);
    expect(response.status).toBe(200);
    const result = receivingFinalizedRecordSchema.parse(await response.json());
    expect(result.finalizedBy).toBe(context.actor);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const replay = await request(`${path}/finalize`, "POST", command);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(await (await request(path)).json()).toEqual(result);
    expect(
      receivingRecordListSchema.parse(
        await (await request("/traceability/receiving?status=finalized")).json(),
      ).items,
    ).toMatchObject([{ id: created.id, status: "finalized" }]);
    expect((await request("/traceability/receiving?status=void")).status).toBe(400);
    expect((await request(`${path}/readiness?expectedDraftVersion=1`)).status).toBe(409);
    for (const invalid of [
      { ...command, actor: "forged" },
      { ...command, expectedDraftVersion: 2147483648 },
    ])
      expect((await request(`${path}/finalize`, "POST", invalid)).status).toBe(400);
    const foreign = await seedReceivingTenant(fixture.db);
    const foreignDraft = await new UsReceivingStore(fixture.db).createDraft(
      foreign.tenant,
      foreign.actor,
      createBody(),
      "foreign",
    );
    expect(
      (
        await request(`/traceability/receiving/${foreignDraft.id}/finalize`, "POST", {
          ...command,
          operationKey: randomUUID(),
        })
      ).status,
    ).toBe(404);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_operator" })
      .where(eq(schema.member.id, context.member));
    expect((await request(`${path}/finalize`, "POST", command)).status).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, context.member));
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id=$1)",
      [context.actor],
    );
    expect((await request(`${path}/finalize`, "POST", command)).status).toBe(403);
    expect((await request(`${path}/finalize`, "POST", command, { cookie: "" })).status).toBe(401);
  });
  it("requires strict receipt-specific reviews over real HTTP with fresh QA and MFA", async () => {
    const complete = await seedExemptReceiving(fixture.db, context);
    const create = { operationKey: randomUUID(), draft: complete.draft };
    const first = complete.draft.items[0];
    if (!first) throw new Error("Missing exempt line");
    for (const extension of [
      { ...first.exemptReceipt, tlcHandling: "automatic" },
      { ...first.exemptReceipt, reviewedBy: context.actor },
      { ...first.exemptReceipt, reviewedAt: new Date().toISOString() },
    ]) {
      expect(
        (
          await request("/traceability/receiving", "POST", {
            ...create,
            draft: { ...complete.draft, items: [{ ...first, exemptReceipt: extension }] },
          })
        ).status,
      ).toBe(400);
    }
    const created = receivingDraftRecordSchema.parse(
      await (await request("/traceability/receiving", "POST", create)).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    const check = receivingReadinessSchema.parse(
      await (await request(`${path}/readiness?expectedDraftVersion=1`)).json(),
    );
    expect(check).toMatchObject({ state: "complete", exemptReviewRequiredLines: [1] });
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: check.inputDigest,
      reviewedExemptLines: [1],
    };
    for (const change of [
      { reviewedExemptLines: [1, 1] },
      { reviewedExemptLines: [2, 1] },
      { reviewedExemptLines: [0] },
      { reviewedExemptLines: [101] },
      { reviewedBy: context.actor },
      { reviewedAt: new Date().toISOString() },
      { approved: true },
    ]) {
      expect((await request(`${path}/finalize`, "POST", { ...command, ...change })).status).toBe(
        400,
      );
    }
    for (const reviews of [[], [2], [1, 2]]) {
      const rejected = await request(`${path}/finalize`, "POST", {
        ...command,
        reviewedExemptLines: reviews,
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        code: "event_incomplete",
        issues: expect.arrayContaining([
          expect.objectContaining({ field: "exemption", code: "exemption_review_required" }),
        ]),
      });
    }
    for (const [headers, status] of [
      [{ host: "foreign.example" }, 403],
      [{ origin: "http://localhost:5173" }, 403],
      [{ "content-type": "text/plain" }, 415],
    ] as const)
      expect((await request(`${path}/finalize`, "POST", command, headers)).status).toBe(status);
    expect(
      (await request(`${path}/finalize`, "POST", { ...command, padding: "x".repeat(16384) }))
        .status,
    ).toBe(413);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_operator" })
      .where(eq(schema.member.id, context.member));
    expect((await request(`${path}/finalize`, "POST", command)).status).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, context.member));
    const response = await request(`${path}/finalize`, "POST", command);
    expect(response.status).toBe(200);
    const result = receivingFinalizedRecordSchema.parse(await response.json());
    expect(result.snapshot).toMatchObject({
      snapshotVersion: 2,
      items: [
        {
          receiptBasis: {
            kind: "exempt_assigned_tlc",
            reviewedBy: context.actor,
            reviewedAt: result.finalizedAt,
          },
        },
        { receiptBasis: { kind: "ordinary" } },
      ],
    });
    expect(await (await request(`${path}/finalize`, "POST", command)).json()).toEqual(result);
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id=$1)",
      [context.actor],
    );
    expect((await request(`${path}/finalize`, "POST", command)).status).toBe(403);
  });
  it("fails closed when storage is unavailable without exposing SQL", async () => {
    await fixture.pool.query(
      "ALTER TABLE traceability_events RENAME TO us_test_missing_receiving_events",
    );
    try {
      for (const [path, method, body] of [
        ["/traceability/receiving", "POST", createBody()],
        [`/traceability/receiving/${randomUUID()}`, "GET", undefined],
        [
          `/traceability/receiving/${randomUUID()}/readiness?expectedDraftVersion=1`,
          "GET",
          undefined,
        ],
      ] as const) {
        const response = await request(path, method, body);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      }
    } finally {
      await fixture.pool.query(
        "ALTER TABLE us_test_missing_receiving_events RENAME TO traceability_events",
      );
    }
  });
  it("returns sanitized 503 when a referenced-data read fails instead of a complete result", async () => {
    const created = receivingDraftRecordSchema.parse(
      await (
        await request("/traceability/receiving", "POST", {
          ...createBody(),
          draft: { ...empty, items: [{ ...item, productId: context.product }] },
        })
      ).json(),
    );
    await fixture.pool.query(
      "ALTER TABLE product_traceability_profiles RENAME TO us_test_missing_readiness_profiles",
    );
    try {
      const response = await request(
        `/traceability/receiving/${created.id}/readiness?expectedDraftVersion=1`,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
    } finally {
      await fixture.pool.query(
        "ALTER TABLE us_test_missing_readiness_profiles RENAME TO product_traceability_profiles",
      );
    }
  });
});
