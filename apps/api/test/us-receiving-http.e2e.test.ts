import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import {
  receivingCreateResultSchema,
  receivingFinalizeResultSchema,
  receivingLiveRecordSchema,
  receivingOperationReceiptV2Schema,
  receivingRevisionListSchema,
  receivingBasisSchema,
  receivingLifecycleErrorSchema,
} from "@markiro/platform-contracts";
import {
  receivingRevisionReadinessSchema,
  receivingLiveRecordListSchema,
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
function createdRecord(value: unknown) {
  const result = receivingCreateResultSchema.parse(value);
  if (!("receiptVersion" in result) || result.record.content.kind !== "draft")
    throw new Error("Expected new original draft acknowledgement");
  return result.record;
}
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
  async function revisionCommand(id: string, expectedDraftVersion = 1) {
    const response = await request(
      `/traceability/receiving/${id}/readiness?expectedDraftVersion=${expectedDraftVersion}`,
    );
    expect(response.status).toBe(200);
    const readiness = receivingRevisionReadinessSchema.parse(await response.json());
    return {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedDraftVersion,
      expectedLifecycleVersion: readiness.expectedLifecycleVersion,
      previousRevisionId: readiness.previousRevisionId,
      expectedInputDigest: readiness.inputDigest,
      reviewedExemptLines: readiness.exemptReviewRequiredLines,
    };
  }
  async function receipt(path: string, method: string, body: unknown, status = 200) {
    const response = await request(path, method, body, { "x-request-id": "forged" });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    return {
      value: receivingOperationReceiptV2Schema.parse(await response.json()),
      requestId: response.headers.get("x-request-id"),
    };
  }

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

  it("separates a versioned acknowledgement from the current read and lifecycle readiness", async () => {
    const body = createBody();
    const response = await request("/traceability/receiving", "POST", body);
    expect(response.status).toBe(201);
    const acknowledgement = receivingCreateResultSchema.parse(await response.json());
    if (!("receiptVersion" in acknowledgement))
      throw new Error("Expected versioned acknowledgement");
    expect(acknowledgement).toMatchObject({ receiptVersion: 2, command: "receiving.create" });
    const id = acknowledgement.record.id;
    expect(await (await request(`/traceability/receiving/${id}`)).json()).toMatchObject({
      recordVersion: 2,
      id,
      lifecycle: { rootId: id, lifecycleVersion: 1 },
      content: { kind: "draft" },
    });
    expect(
      await (
        await request(`/traceability/receiving/${id}/readiness?expectedDraftVersion=1`)
      ).json(),
    ).toMatchObject({
      ruleVersion: "receiving-readiness-v4",
      rootId: id,
      expectedLifecycleVersion: 1,
      previousRevisionId: null,
    });
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
    const acknowledgement = receivingCreateResultSchema.parse(await response.json());
    const created = createdRecord(acknowledgement);
    expect(
      receivingLiveRecordSchema.parse(
        await (await request(`/traceability/receiving/${created.id}`)).json(),
      ),
    ).toEqual(created);
    const saved = await request(`/traceability/receiving/${created.id}`, "PUT", {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...empty, notes: "saved" },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      receiptVersion: 2,
      command: "receiving.save",
      record: {
        id: created.id,
        draftVersion: 2,
        revision: 1,
        status: "draft",
      },
    });
    expect(await (await request("/traceability/receiving", "POST", body)).json()).toEqual(
      acknowledgement,
    );
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
  it.each(["legacy", "versioned"] as const)(
    "keeps %s acknowledgements historical after void while GET returns current status",
    async (format) => {
      const store = new UsReceivingStore(fixture.db);
      const complete = await seedCompleteReceiving(fixture.db, context);
      const create = { operationKey: randomUUID(), draft: complete.draft };
      const created =
        format === "legacy"
          ? await store.createDraft(context.tenant, context.actor, create, "legacy-create")
          : await (await request("/traceability/receiving", "POST", create)).json();
      const parsed = receivingCreateResultSchema.parse(created);
      const id = "receiptVersion" in parsed ? parsed.eventId : parsed.id;
      const path = `/traceability/receiving/${id}`;
      const readiness =
        format === "legacy"
          ? await store.checkReadiness(context.tenant, context.actor, id, {
              expectedDraftVersion: 1,
            })
          : receivingRevisionReadinessSchema.parse(
              await (await request(`${path}/readiness?expectedDraftVersion=1`)).json(),
            );
      const finalize = {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: readiness.inputDigest,
      };
      const acknowledged =
        format === "legacy"
          ? await store.finalize(context.tenant, context.actor, id, finalize, "legacy-finalize")
          : await (await request(`${path}/finalize`, "POST", finalize)).json();
      await store.void(
        context.tenant,
        context.actor,
        id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          expectedDraftVersion: null,
          reason: "Duplicate delivery",
        },
        "synthetic-void",
      );
      expect(await (await request("/traceability/receiving", "POST", create)).json()).toEqual(
        created,
      );
      expect(await (await request(`${path}/finalize`, "POST", finalize)).json()).toEqual(
        acknowledged,
      );
      const live = receivingLiveRecordSchema.parse(await (await request(path)).json());
      expect(live).toMatchObject({
        id,
        status: "void",
        lifecycle: { lifecycleVersion: 3, voidReason: "Duplicate delivery", currentEventId: null },
      });
      const receipt = receivingFinalizeResultSchema.parse(acknowledged);
      const snapshot =
        "receiptVersion" in receipt && receipt.record.content.kind === "finalized"
          ? receipt.record.content.snapshot
          : "snapshot" in receipt
            ? receipt.snapshot
            : null;
      expect(live.content).toMatchObject({ kind: "finalized", snapshot });
      expect(
        receivingLiveRecordListSchema.parse(
          await (await request("/traceability/receiving?history=all&status=void")).json(),
        ).items,
      ).toMatchObject([{ id, status: "void" }]);
      const refused = await request(`${path}/finalize`, "POST", {
        ...finalize,
        operationKey: randomUUID(),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        code: "receiving_lifecycle_conflict",
        rootId: id,
        lifecycleVersion: 3,
        currentEventId: null,
        pendingDraftId: null,
      });
    },
  );
  it("lists draft summaries through strict query parsing without caching or audit", async () => {
    const created = createdRecord(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const response = await request(
      `/traceability/receiving?search=${encodeURIComponent(`  ${created.eventNumber.toLowerCase()}  `)}&limit=1&offset=0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(receivingLiveRecordListSchema.parse(await response.json())).toEqual({
      items: [
        {
          id: created.id,
          recordVersion: 2,
          lifecycle: created.lifecycle,
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
    const created = createdRecord(
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
    const created = createdRecord(
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
    const created = createdRecord(
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
    const created = createdRecord(await response.json());
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
  it.each(["ordinary", "exempt"] as const)(
    "runs the %s revision lifecycle through HTTP without rewriting lots or historical acknowledgements",
    async (kind) => {
      const complete = await (kind === "exempt" ? seedExemptReceiving : seedCompleteReceiving)(
        fixture.db,
        context,
      );
      const created = createdRecord(
        await (
          await request("/traceability/receiving", "POST", {
            operationKey: randomUUID(),
            draft: complete.draft,
          })
        ).json(),
      );
      const rootPath = `/traceability/receiving/${created.id}`;
      const originalCommand = await revisionCommand(created.id);
      const original = await receipt(`${rootPath}/finalize`, "POST", originalCommand);
      const businessLots = async () =>
        (
          await fixture.pool.query(
            "SELECT to_jsonb(l)-'receiving_basis_version' AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
            [context.tenant],
          )
        ).rows;
      const beforeLots = await businessLots();
      const basisPath = `/traceability/lots/${context.lot}/receiving-basis`;
      const basis = receivingBasisSchema.parse(await (await request(basisPath)).json());
      expect(basis).toMatchObject({ state: "present", supportCount: 1 });
      const amendCommand = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "  Correct receipt notes  ",
      };
      const amended = await receipt(`${rootPath}/amend`, "POST", amendCommand, 201);
      expect(amended.value.record).toMatchObject({
        revision: 2,
        draftVersion: 1,
        status: "draft",
        lifecycle: {
          rootId: created.id,
          lifecycleVersion: 3,
          currentEventId: created.id,
          pendingDraftId: amended.value.eventId,
          previousRevisionId: created.id,
          amendmentReason: "Correct receipt notes",
        },
      });
      if (amended.value.record.content.kind !== "draft")
        throw new Error("Expected amendment draft");
      const amendmentPath = `/traceability/receiving/${amended.value.eventId}`;
      const saveCommand = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        draft: { ...amended.value.record.content.draft, notes: "Corrected receipt notes" },
      };
      const saved = await receipt(amendmentPath, "PUT", saveCommand);
      expect(saved.value.record).toMatchObject({ draftVersion: 2, revision: 2 });
      const finalizeCommand = await revisionCommand(amended.value.eventId, 2);
      const finalized = await receipt(`${amendmentPath}/finalize`, "POST", finalizeCommand);
      expect(finalized.value.record).toMatchObject({
        status: "finalized",
        lifecycle: {
          lifecycleVersion: 4,
          currentEventId: amended.value.eventId,
          pendingDraftId: null,
        },
      });
      expect(await businessLots()).toEqual(beforeLots);
      const currentBasis = receivingBasisSchema.parse(await (await request(basisPath)).json());
      expect(currentBasis).toMatchObject({
        state: "present",
        supportCount: 1,
        items: [{ rootId: created.id, eventId: amended.value.eventId, revision: 2 }],
      });
      const history = receivingRevisionListSchema.parse(
        await (await request(`${rootPath}/revisions?limit=1&offset=1`)).json(),
      );
      expect(history).toMatchObject({
        lifecycleVersion: 4,
        limit: 1,
        offset: 1,
        items: [{ id: amended.value.eventId, revision: 2, status: "finalized" }],
      });
      expect(await (await request(rootPath)).json()).toMatchObject({
        status: "amended",
        content: original.value.record.content,
      });
      const voidCommand = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        expectedDraftVersion: null,
        reason: "Receipt withdrawn",
      };
      const voided = await receipt(`${amendmentPath}/void`, "POST", voidCommand);
      expect(voided.value.record).toMatchObject({
        status: "void",
        lifecycle: { lifecycleVersion: 5, currentEventId: null, pendingDraftId: null },
        content: finalized.value.record.content,
      });
      expect(await businessLots()).toEqual(beforeLots);
      const missing = receivingBasisSchema.parse(await (await request(basisPath)).json());
      expect(missing).toMatchObject({ state: "missing", supportCount: 0, items: [] });
      expect(missing.basisVersion).toBe(currentBasis.basisVersion + 1);
      const audits = async () =>
        (
          await fixture.pool.query(
            "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 ORDER BY id",
            [context.tenant],
          )
        ).rows;
      const beforeReplay = await audits();
      for (const [commandPath, method, body, result, status] of [
        [`${rootPath}/finalize`, "POST", originalCommand, original, 200],
        [`${rootPath}/amend`, "POST", amendCommand, amended, 201],
        [amendmentPath, "PUT", saveCommand, saved, 200],
        [`${amendmentPath}/finalize`, "POST", finalizeCommand, finalized, 200],
        [`${amendmentPath}/void`, "POST", voidCommand, voided, 200],
      ] as const) {
        expect((await receipt(commandPath, method, body, status)).value).toEqual(result.value);
      }
      expect(await audits()).toEqual(beforeReplay);
      expect(await (await request(amendmentPath)).json()).toEqual(voided.value.record);
      for (const [action, result, before, reason, outcome] of [
        [
          "traceability.receiving.amendment_started",
          amended,
          original.value.record,
          "Correct receipt notes",
          "draft_started",
        ],
        [
          "traceability.receiving.voided",
          voided,
          finalized.value.record,
          "Receipt withdrawn",
          "voided",
        ],
      ] as const) {
        expect(beforeReplay.filter((entry) => entry.action === action)).toEqual([
          {
            organization_id: context.tenant,
            actor_user_id: context.actor,
            action,
            outcome: "success",
            target_type: "traceability_event",
            target_id: amended.value.eventId,
            before,
            after: {
              rootId: created.id,
              revision: 2,
              reason,
              result: outcome,
              record: result.value.record,
            },
            request_id: result.requestId,
          },
        ]);
      }
      await fixture.db
        .update(schema.member)
        .set({ role: "traceability_operator" })
        .where(eq(schema.member.id, context.member));
      for (const [commandPath, method, body] of [
        [`${rootPath}/amend`, "POST", amendCommand],
        [amendmentPath, "PUT", saveCommand],
        [`${amendmentPath}/finalize`, "POST", finalizeCommand],
        [`${amendmentPath}/void`, "POST", voidCommand],
      ] as const)
        expect((await request(commandPath, method, body)).status).toBe(403);
      expect(await audits()).toEqual(beforeReplay);
    },
  );
  it("protects lifecycle reads and writes with tenant, strict input, current MFA and transport boundaries", async () => {
    const foreign = await seedReceivingTenant(fixture.db);
    const other = await new UsReceivingStore(fixture.db).createDraft(
      foreign.tenant,
      foreign.actor,
      createBody(),
      "foreign",
    );
    const command = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      reason: "Cancel draft",
    };
    for (const [path, method, body] of [
      [`/traceability/receiving/${other.id}/amend`, "POST", command],
      [`/traceability/receiving/${other.id}/void`, "POST", { ...command, expectedDraftVersion: 1 }],
      [`/traceability/receiving/${other.id}/revisions`, "GET", undefined],
      [`/traceability/lots/${foreign.lot}/receiving-basis`, "GET", undefined],
    ] as const)
      expect((await request(path, method, body)).status).toBe(404);
    const created = createdRecord(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    const reads = [`${path}/revisions`, `/traceability/lots/${context.lot}/receiving-basis`];
    for (const read of reads) {
      expect((await request(read)).status).toBe(200);
      for (const query of [
        "limit=1&limit=2",
        "offset=0&offset=1",
        "limit=01",
        "offset=-1",
        "tenantId=forged",
        "limit=101",
      ])
        expect((await request(`${read}?${query}`)).status).toBe(400);
    }
    for (const suffix of ["amend", "void"]) {
      const body = suffix === "void" ? { ...command, expectedDraftVersion: 1 } : command;
      expect(
        (await request(`/traceability/receiving/not-a-uuid/${suffix}`, "POST", body)).status,
      ).toBe(400);
      for (const change of [
        { tenantId: foreign.tenant },
        { actor: "forged" },
        { commandVersion: 3 },
        { reason: " " },
      ])
        expect((await request(`${path}/${suffix}`, "POST", { ...body, ...change })).status).toBe(
          400,
        );
      for (const [headers, status] of [
        [{ host: "foreign.example" }, 403],
        [{ origin: "http://localhost:5173" }, 403],
        [{ "content-type": "text/plain" }, 415],
        [{ "content-encoding": "gzip" }, 415],
      ] as const)
        expect((await request(`${path}/${suffix}`, "POST", body, headers)).status).toBe(status);
      expect(
        (await request(`${path}/${suffix}`, "POST", { ...body, padding: "x".repeat(16384) }))
          .status,
      ).toBe(413);
    }
    const stale = await request(`${path}/void`, "POST", { ...command, expectedDraftVersion: 2 });
    expect(stale.status).toBe(409);
    expect(receivingLifecycleErrorSchema.parse(await stale.json())).toMatchObject({
      code: "receiving_draft_conflict",
    });
    const voidCommand = { ...command, expectedDraftVersion: 1 };
    const voided = await receipt(`${path}/void`, "POST", voidCommand);
    expect(voided.value.record).toMatchObject({
      status: "void",
      lifecycle: { lifecycleVersion: 2 },
    });
    const rebound = await request(`${path}/void`, "POST", {
      ...voidCommand,
      reason: "Different intent",
    });
    expect(rebound.status).toBe(409);
    expect(receivingLifecycleErrorSchema.parse(await rebound.json())).toMatchObject({
      code: "receiving_operation_conflict",
    });
    await fixture.pool.query(
      "DELETE FROM us_session_assurances WHERE session_id IN (SELECT id FROM session WHERE user_id=$1)",
      [context.actor],
    );
    for (const read of reads) {
      expect((await request(read)).status).toBe(403);
      expect((await request(read, "GET", undefined, { cookie: "" })).status).toBe(401);
    }
    expect((await request(`${path}/void`, "POST", voidCommand)).status).toBe(403);
  });
  it("cancels a pending amendment without losing current support and rejects stale or legacy revision writes", async () => {
    const complete = await seedCompleteReceiving(fixture.db, context);
    const created = createdRecord(
      await (
        await request("/traceability/receiving", "POST", {
          operationKey: randomUUID(),
          draft: complete.draft,
        })
      ).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    await receipt(`${path}/finalize`, "POST", await revisionCommand(created.id));
    const command = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct receipt",
    };
    const pending = await receipt(`${path}/amend`, "POST", command, 201);
    if (pending.value.record.content.kind !== "draft") throw new Error("Expected amendment draft");
    const pendingPath = `/traceability/receiving/${pending.value.eventId}`;
    const basisPath = `/traceability/lots/${context.lot}/receiving-basis`;
    const basis = await (await request(basisPath)).json();
    const save = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: 1,
      draft: pending.value.record.content.draft,
    };
    const beforeAudit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, context.tenant));
    expect((await receipt(pendingPath, "PUT", save)).value.record).toEqual(pending.value.record);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, context.tenant)),
    ).toEqual(beforeAudit);
    const finalize = await revisionCommand(pending.value.eventId);
    const { commandVersion, expectedLifecycleVersion, previousRevisionId, ...legacyFinalize } =
      finalize;
    void commandVersion;
    void expectedLifecycleVersion;
    void previousRevisionId;
    for (const [target, method, body, code] of [
      [
        `${path}/amend`,
        "POST",
        { ...command, operationKey: randomUUID() },
        "receiving_lifecycle_conflict",
      ],
      [
        `${path}/void`,
        "POST",
        {
          ...command,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 3,
          expectedDraftVersion: null,
        },
        "receiving_pending_amendment",
      ],
      [
        pendingPath,
        "PUT",
        { ...save, operationKey: randomUUID(), expectedLifecycleVersion: 2 },
        "receiving_lifecycle_conflict",
      ],
      [
        pendingPath,
        "PUT",
        { ...save, operationKey: randomUUID(), expectedDraftVersion: 2 },
        "receiving_draft_conflict",
      ],
      [`${pendingPath}/finalize`, "POST", legacyFinalize, "receiving_lifecycle_conflict"],
    ] as const) {
      const rejected = await request(target, method, body);
      expect(rejected.status).toBe(409);
      expect(receivingLifecycleErrorSchema.parse(await rejected.json())).toMatchObject({ code });
    }
    const voidCommand = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: 1,
      reason: "Cancel correction",
    };
    const cancelled = await receipt(`${pendingPath}/void`, "POST", voidCommand);
    expect(cancelled.value.record).toMatchObject({
      status: "void",
      content: pending.value.record.content,
      lifecycle: { lifecycleVersion: 4, currentEventId: created.id, pendingDraftId: null },
    });
    expect(await (await request(basisPath)).json()).toEqual(basis);
    const next = await receipt(
      `${path}/amend`,
      "POST",
      { ...command, operationKey: randomUUID(), expectedLifecycleVersion: 4 },
      201,
    );
    expect(next.value.record.revision).toBe(3);
    expect((await receipt(`${pendingPath}/void`, "POST", voidCommand)).value).toEqual(
      cancelled.value,
    );
    const history = receivingRevisionListSchema.parse(
      await (await request(`${pendingPath}/revisions`)).json(),
    );
    expect(history.items.map(({ revision, status }) => ({ revision, status }))).toEqual([
      { revision: 1, status: "finalized" },
      { revision: 2, status: "void" },
      { revision: 3, status: "draft" },
    ]);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_operator" })
      .where(eq(schema.member.id, context.member));
    // Versioned input must select QA authorization before validation, never fall
    // back to the less privileged original-save parser when it is malformed.
    for (const malformed of [
      { commandVersion: 3 },
      { commandVersion: null },
      { commandVersion: 2 },
    ])
      expect((await request(pendingPath, "PUT", malformed)).status).toBe(403);
    await fixture.db.delete(schema.member).where(eq(schema.member.id, context.member));
    for (const read of [`${path}/revisions`, basisPath])
      expect((await request(read)).status).toBe(403);
  });
  it("keeps import/delete routes closed and documents the lifecycle routes", async () => {
    const id = randomUUID();
    for (const path of ["/traceability/receiving/import"])
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
            oneOf: expect.arrayContaining([
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
    for (const [path, method, status] of [
      ["/traceability/receiving/{id}/amend", "post", "201"],
      ["/traceability/receiving/{id}/void", "post", "200"],
      ["/traceability/receiving/{id}/revisions", "get", "200"],
      ["/traceability/lots/{id}/receiving-basis", "get", "200"],
    ] as const) {
      expect(Object.keys(api.paths[path] ?? {})).toEqual([method]);
      expect(api.paths[path]?.[method]?.responses).toHaveProperty(status);
      expect(api.paths[path]?.[method]?.security).toEqual([{ "markiro-us.session_token": [] }]);
    }
  });
  it("finalizes with HTTP200 and replays with fresh QA and MFA while exposing frozen mixed reads", async () => {
    const complete = await seedCompleteReceiving(fixture.db, context);
    const created = createdRecord(
      await (
        await request("/traceability/receiving", "POST", {
          operationKey: randomUUID(),
          draft: complete.draft,
        })
      ).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    const check = receivingRevisionReadinessSchema.parse(
      await (await request(`${path}/readiness?expectedDraftVersion=1`)).json(),
    );
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: check.inputDigest,
    };
    const response = await request(`${path}/finalize`, "POST", command);
    expect(response.status).toBe(200);
    const result = receivingFinalizeResultSchema.parse(await response.json());
    if (!("receiptVersion" in result) || result.record.content.kind !== "finalized")
      throw new Error("Expected versioned frozen acknowledgement");
    expect(result.record.content.finalizedBy).toBe(context.actor);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const replay = await request(`${path}/finalize`, "POST", command);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(await (await request(path)).json()).toEqual(result.record);
    expect(
      receivingLiveRecordListSchema.parse(
        await (await request("/traceability/receiving?status=finalized")).json(),
      ).items,
    ).toMatchObject([{ id: created.id, status: "finalized" }]);
    expect((await request("/traceability/receiving?status=void")).status).toBe(200);
    expect((await request(`${path}/readiness?expectedDraftVersion=1`)).status).toBe(409);
    for (const invalid of [
      { ...command, actor: "forged" },
      { ...command, expectedDraftVersion: 2147483648 },
      {
        ...command,
        commandVersion: 2,
        expectedLifecycleVersion: 1,
        previousRevisionId: null,
      },
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
    const created = createdRecord(
      await (await request("/traceability/receiving", "POST", create)).json(),
    );
    const path = `/traceability/receiving/${created.id}`;
    const check = receivingRevisionReadinessSchema.parse(
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
    const result = receivingFinalizeResultSchema.parse(await response.json());
    if (!("receiptVersion" in result) || result.record.content.kind !== "finalized")
      throw new Error("Expected versioned frozen acknowledgement");
    expect(result.record.content.snapshot).toMatchObject({
      snapshotVersion: 3,
      items: [
        {
          receiptBasis: {
            kind: "exempt_assigned_tlc",
            reviewedBy: context.actor,
            reviewedAt: result.record.content.finalizedAt,
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
    const created = createdRecord(
      await (await request("/traceability/receiving", "POST", createBody())).json(),
    );
    const lifecycle = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      reason: "Unavailable storage",
    };
    await fixture.pool.query(
      "ALTER TABLE traceability_events RENAME TO us_test_missing_receiving_events",
    );
    try {
      for (const [path, method, body] of [
        ["/traceability/receiving", "POST", createBody()],
        [`/traceability/receiving/${randomUUID()}`, "GET", undefined],
        [`/traceability/receiving/${created.id}/revisions`, "GET", undefined],
        [`/traceability/lots/${context.lot}/receiving-basis`, "GET", undefined],
        [`/traceability/receiving/${created.id}/amend`, "POST", lifecycle],
        [
          `/traceability/receiving/${created.id}/void`,
          "POST",
          { ...lifecycle, expectedDraftVersion: 1 },
        ],
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
    const created = createdRecord(
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
