import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import {
  usPlanApprovalResponseSchema,
  usPlanDraftCommandResponseSchema,
  usPlanDetailResponseSchema,
  usPlanListResponseSchema,
  usPlanValidationResponseSchema,
} from "@markiro/platform-contracts";
import type { UsPlanSections } from "@markiro/domain";
import { hashPassword } from "better-auth/crypto";
import supertest from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { UsRuntime } from "../src/deployment/us-runtime";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import type { UsPlanArtifactS3Transport } from "../src/modules/traceability/plans/us-plan-artifacts";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const path = "/traceability/plans";
const password = "Synthetic-US-plan-password-42!";
const confirmations = {
  procedures: true,
  backupAndRecovery: true,
  contact: true,
  nonFarmScope: true,
};
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Register",
    formats: ["PDF"],
    recordLocations: ["QA cabinet"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Operator reports backups",
    narrative: [],
  },
  ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
  tlcAssignment: { procedure: "Assign at processing" },
  pointOfContact: { name: "Example QA", title: "QA", phone: "+1 555 0100", email: null },
  farmActivity: { status: "no", explanation: "No farming" },
  reviewAndUpdate: { procedure: "Update on change" },
};

describe.skipIf(!base)("US plan HTTP boundary", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string, client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  const objects = new Map<string, Buffer>();
  const artifactTransport: UsPlanArtifactS3Transport = {
    async send(command) {
      const key = command.input.Key ?? "";
      if (command.constructor.name === "PutObjectCommand") {
        if (!("Body" in command.input) || !(command.input.Body instanceof Uint8Array))
          throw new Error("Invalid bytes");
        objects.set(key, Buffer.from(command.input.Body));
        return {};
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Missing object");
      return { Body: bytes, ContentLength: bytes.length, ContentType: "application/pdf" };
    },
  };
  async function transport(input: Request): Promise<Response> {
    const body = await input.text();
    return new Promise((resolve, reject) => {
      const headers = new Headers(input.headers);
      headers.set("host", "localhost:3100");
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
              if (Array.isArray(value)) for (const entry of value) resultHeaders.append(key, entry);
              else if (value !== undefined) resultHeaders.set(key, value);
            }
            resolve(
              new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers: resultHeaders,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  function request(url = path, method = "GET", body?: unknown, authenticated = true) {
    const headers = authenticated ? client.headers() : new Headers();
    headers.set("origin", "http://localhost:5174");
    headers.set("content-type", "application/json");
    headers.set("accept-language", "es-US");
    return transport(
      new Request(`http://localhost:3100${url}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function state() {
    return (
      await f.pool.query(
        `SELECT (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_plan_versions x WHERE tenant_id=$1) versions, (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tenant_audit_events x WHERE organization_id=$1) audits`,
        [c.tenant],
      )
    ).rows;
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(base);
    const identity = await f.pool.query("SELECT current_database() AS name");
    const url = new URL(base);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    app = await createUsDevelopmentApplication(
      {
        ...parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
        US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
        US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
        US_PLAN_ARTIFACT_S3_BUCKET: "us-plan-test",
        US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "plan-test",
        US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "plan-test-secret",
        US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
      },
      (_url, options) => createDb(url.toString(), options),
      artifactTransport,
    );
    await app.init();
    await listenOnLoopback(app);
    serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    c = await seedCompleteReceiving(f.db);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["tlc_source"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db.insert(schema.account).values({
      id: randomUUID(),
      userId: c.actor,
      accountId: c.actor,
      providerId: "credential",
      password: await hashPassword(password),
    });
    client = new UsAuthTestClient(transport);
    expect(
      (await client.request("/sign-in/email", { email: `${c.actor}@example.test`, password }))
        .status,
    ).toBe(200);
    const enrollment = await client.request("/two-factor/enable", { password });
    const data: unknown = await enrollment.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("totpURI" in data) ||
      typeof data.totpURI !== "string"
    )
      throw new Error("Invalid enrollment");
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(200);
    expect(
      (await client.request("/organization/set-active", { organizationId: c.tenant })).status,
    ).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await f?.close();
  });

  it("documents exactly nine canonical methods with explicit success and failure responses", () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    expect(JSON.stringify(document.paths[path]?.get?.responses["400"])).toContain(
      "us_invalid_query",
    );
    expect(
      JSON.stringify(document.paths[`${path}/{id}/preview`]?.post?.responses["409"]),
    ).toContain("issues");
    const paths = Object.fromEntries(
      Object.entries(document.paths).filter(([key]) => key.startsWith(path)),
    );
    expect(
      Object.fromEntries(
        Object.entries(paths).map(([key, value]) => [key, Object.keys(value).sort()]),
      ),
    ).toEqual({
      [path]: ["get", "post"],
      [`${path}/{id}`]: ["get", "put"],
      [`${path}/{id}/validate`]: ["post"],
      [`${path}/{id}/preview`]: ["post"],
      [`${path}/{id}/approve`]: ["post"],
      [`${path}/{id}/discard`]: ["post"],
      [`${path}/{id}/pdf`]: ["get"],
    });
    for (const value of Object.values(paths))
      for (const operation of Object.values(value)) {
        expect(Object.keys(operation.responses)).toEqual(
          expect.arrayContaining(["400", "401", "403", "404", "409", "413", "415", "503"]),
        );
        expect(
          operation.responses["200"] ?? operation.responses["201"] ?? operation.responses["204"],
        ).toBeDefined();
      }
  });
  it("preserves host, origin and JSON-only transport checks with no-store errors", async () => {
    for (const [host, origin, contentType, status] of [
      ["localhost:3000", "http://localhost:5174", "application/json", 403],
      ["localhost:3100", "http://localhost:5173", "application/json", 403],
      ["localhost:3100", "http://localhost:5174", "text/plain", 415],
    ] as const) {
      const result = await supertest(app.getHttpServer())
        .post(path)
        .set("Host", host)
        .set("Origin", origin)
        .set("Content-Type", contentType)
        .send("{}");
      expect(result.status).toBe(status);
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });
  it("rejects anonymous aliases and every query before session or database work", async () => {
    const ready = vi.spyOn(app.get(UsRuntime), "assertDatabaseReady");
    try {
      const id = randomUUID();
      for (const [method, suffix] of [
        ["GET", ""],
        ["POST", ""],
        ["GET", `/${id}`],
        ["PUT", `/${id}`],
        ...["validate", "preview", "approve", "discard"].map((action) => [
          "POST",
          `/${id}/${action}`,
        ]),
        ["GET", `/${id}/pdf`],
      ]) {
        if (!method || suffix === undefined) throw new Error("Missing route");
        const route = `${path}${suffix}`;
        expect((await request(route, method, undefined, false)).status).toBe(401);
        for (const [badPath, badMethod] of [
          [route, "HEAD"],
          [`${route}/`, method],
          [route.toUpperCase(), method],
          [route, "DELETE"],
          [`${route}/extra`, method],
        ]) {
          expect(
            (await request(badPath, badMethod, undefined, false)).status,
            `${badMethod} ${badPath}`,
          ).toBe(404);
        }
        for (const query of ["?foo=1", "?foo=1&foo=2", "?%66oo=1"])
          expect((await request(`${route}${query}`, method, undefined, false)).status).toBe(400);
      }
      expect(ready).not.toHaveBeenCalled();
    } finally {
      ready.mockRestore();
    }
  });
  it("saves, inspects and approves the saved revision, then downloads immutable English bytes", async () => {
    const created = await request(path, "POST", { sections, changeSummary: "" });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const draft = usPlanDraftCommandResponseSchema.parse(await created.json());
    expect(draft).toMatchObject({ status: "draft", draftRevision: 1 });
    const creationAudit = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, created.headers.get("x-request-id") ?? ""));
    expect(creationAudit).toHaveLength(1);
    expect(creationAudit[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.plan.draft_created",
      outcome: "success",
      targetType: "traceability_plan_version",
      targetId: draft.id,
      before: null,
      after: { versionNumber: 1, draftRevision: 1 },
    });
    const route = `${path}/${draft.id}`;
    expect(usPlanListResponseSchema.parse(await (await request()).json()).items).toHaveLength(1);
    expect(usPlanDetailResponseSchema.parse(await (await request(route)).json())).toEqual({
      ...draft,
      provenance: "operational",
    });
    const save = await request(route, "PUT", {
      sections,
      changeSummary: "Initial plan",
      expectedRevision: 1,
    });
    expect(save.status).toBe(200);
    expect(usPlanDraftCommandResponseSchema.parse(await save.json())).toMatchObject({
      draftRevision: 2,
    });
    expect(
      (await request(route, "PUT", { sections, changeSummary: "Stale", expectedRevision: 1 }))
        .status,
    ).toBe(409);
    const before = await state();
    const validation = await request(`${route}/validate`, "POST", {
      expectedRevision: 2,
      confirmations,
    });
    expect(validation.status).toBe(200);
    expect(usPlanValidationResponseSchema.parse(await validation.json())).toEqual({
      versionId: draft.id,
      draftRevision: 2,
      issues: [],
      publicationAvailability: "available",
    });
    const preview = await request(`${route}/preview`, "POST", { expectedRevision: 2 });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("x-plan-draft-revision")).toBe("2");
    expect(
      execFileSync("pdftotext", ["-", "-"], {
        input: Buffer.from(await preview.arrayBuffer()),
        encoding: "utf8",
      }),
    ).toContain("DRAFT — not effective");
    expect(await state()).toEqual(before);
    const approval = { expectedRevision: 2, idempotencyKey: randomUUID(), confirmations };
    const unconfirmed = await request(`${route}/approve`, "POST", {
      ...approval,
      confirmations: { ...confirmations, contact: false },
    });
    expect(unconfirmed.status).toBe(409);
    const approved = await request(`${route}/approve`, "POST", approval);
    expect(approved.status).toBe(200);
    const receipt = usPlanApprovalResponseSchema.parse(await approved.json());
    const detail = usPlanDetailResponseSchema.parse(await (await request(route)).json());
    if (detail.status === "draft") throw new Error("Approval remained draft");
    expect(JSON.stringify(detail)).not.toContain("objectKey");
    expect(await (await request(`${route}/approve`, "POST", approval)).json()).toEqual(receipt);
    expect(
      (await request(`${route}/approve`, "POST", { ...approval, expectedRevision: 1 })).status,
    ).toBe(409);
    const download = await request(`${route}/pdf`);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-type")).toContain("application/pdf");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(download.headers.get("content-length")).toBe(String(bytes.length));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(detail.artifact.sha256);
    expect([...objects.values()]).toContainEqual(bytes);
    expect(execFileSync("pdftotext", ["-", "-"], { input: bytes, encoding: "utf8" })).toContain(
      "Example QA",
    );
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed after approval" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    expect(Buffer.from(await (await request(`${route}/pdf`)).arrayBuffer())).toEqual(bytes);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, download.headers.get("x-request-id") ?? ""));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.plan.downloaded",
      targetType: "traceability_plan_version",
      targetId: draft.id,
      outcome: "success",
      before: null,
      after: { versionNumber: 1, sha256: detail.artifact.sha256 },
    });
    const next = await request(path, "POST", { sections, changeSummary: "Next" });
    const nextDraft = usPlanDraftCommandResponseSchema.parse(await next.json());
    expect(
      (await request(`${path}/${nextDraft.id}/discard`, "POST", { expectedRevision: 1 })).status,
    ).toBe(204);
    expect((await request(`${path}/${nextDraft.id}`)).status).toBe(404);
  }, 30_000);
  it("audits malformed approval bodies against the authoritative route target without publishing", async () => {
    const created = await request(path, "POST", { sections, changeSummary: "Audit rejection" });
    expect(created.status).toBe(201);
    const draft = usPlanDraftCommandResponseSchema.parse(await created.json());
    const objectsBefore = [...objects.entries()];
    for (const invalid of [{ versionId: randomUUID() }, { expectedRevision: 0 }]) {
      const rejected = await request(`${path}/${draft.id}/approve`, "POST", {
        expectedRevision: 1,
        confirmations,
        idempotencyKey: randomUUID(),
        ...invalid,
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "invalid_master_data" });
      const requestId = rejected.headers.get("x-request-id");
      expect(requestId).toBeTruthy();
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, requestId ?? ""));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        organizationId: c.tenant,
        actorUserId: c.actor,
        requestId,
        action: "traceability.plan.approved",
        targetType: "traceability_plan_version",
        targetId: draft.id,
        outcome: "rejected",
        before: null,
        after: { code: "invalid_master_data" },
      });
      expect(audits[0]?.after).toEqual({ code: "invalid_master_data" });
      expect(
        usPlanDetailResponseSchema.parse(await (await request(`${path}/${draft.id}`)).json()),
      ).toMatchObject({ status: "draft", draftRevision: 1 });
      expect([...objects.entries()]).toEqual(objectsBefore);
    }
    expect(
      (await request(`${path}/${draft.id}/discard`, "POST", { expectedRevision: 1 })).status,
    ).toBe(204);
  });
  it("enforces strict bodies, route limits, current capabilities and tenant lookup", async () => {
    const largeSections = {
      ...sections,
      recordMaintenance: {
        ...sections.recordMaintenance,
        narrative: Array.from({ length: 6 }, () => "x".repeat(4000)),
      },
    };
    const created = await request(path, "POST", {
      sections: largeSections,
      changeSummary: "Limits",
    });
    expect(created.status).toBe(201);
    const draft = usPlanDraftCommandResponseSchema.parse(await created.json());
    const route = `${path}/${draft.id}`;
    expect(
      (
        await request(route, "PUT", {
          sections: largeSections,
          changeSummary: "Large save",
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    for (const [url, method, body] of [
      [path, "POST", { sections, changeSummary: "", tenantId: c.tenant }],
      [
        route,
        "PUT",
        { sections, changeSummary: "", expectedRevision: 2, provenance: "trusted_synthetic" },
      ],
      [`${route}/validate`, "POST", { expectedRevision: 2, confirmations, sections }],
      [`${route}/preview`, "POST", { expectedRevision: 2, confirmations }],
      [
        `${route}/approve`,
        "POST",
        { expectedRevision: 2, confirmations, idempotencyKey: randomUUID(), versionId: draft.id },
      ],
      [`${route}/discard`, "POST", { expectedRevision: 2, actorId: c.actor }],
    ] as const)
      expect((await request(url, method, body)).status).toBe(400);
    for (const action of ["validate", "preview", "approve", "discard"])
      expect(
        (await request(`${route}/${action}`, "POST", { padding: "x".repeat(17000) })).status,
      ).toBe(413);
    for (const [url, method] of [
      [path, "POST"],
      [route, "PUT"],
    ] as const)
      expect((await request(url, method, { padding: "x".repeat(263000) })).status).toBe(413);
    const before = await state();
    expect((await request(`${route}/preview`, "POST", { expectedRevision: 1 })).status).toBe(409);
    const findings = await request(`${route}/validate`, "POST", {
      expectedRevision: 2,
      confirmations: {
        procedures: false,
        backupAndRecovery: false,
        contact: false,
        nonFarmScope: false,
      },
    });
    expect(usPlanValidationResponseSchema.parse(await findings.json()).issues).toHaveLength(4);
    for (const id of ["invalid", draft.id.toUpperCase(), "%30" + draft.id.slice(1)])
      expect((await request(`${path}/${id}`)).status).toBe(404);
    expect(await state()).toEqual(before);
    const other = await seedCompleteReceiving(f.db);
    const foreign = await app
      .get(UsRuntime)
      .planDrafts.createDraft(
        other.tenant,
        other.actor,
        { sections, changeSummary: "" },
        "foreign",
      );
    for (const id of [foreign.id, randomUUID()]) {
      expect((await request(`${path}/${id}`)).status).toBe(404);
      expect((await request(`${path}/${id}/preview`, "POST", { expectedRevision: 1 })).status).toBe(
        404,
      );
    }
    await f.db
      .update(schema.member)
      .set({ role: "traceability_receiving" })
      .where(eq(schema.member.id, c.member));
    try {
      for (const action of ["validate", "preview", "approve", "discard"])
        expect(
          (
            await request(`${route}/${action}`, "POST", {
              expectedRevision: 2,
              ...(action === "validate" || action === "approve" ? { confirmations } : {}),
              ...(action === "approve" ? { idempotencyKey: randomUUID() } : {}),
            })
          ).status,
        ).toBe(403);
    } finally {
      await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    }
    expect((await request(`${route}/discard`, "POST", { expectedRevision: 2 })).status).toBe(204);
  });
  it("keeps drafts available without a private store while refusing publication and download", async () => {
    const identity = await f.pool.query("SELECT current_database() AS name");
    if (!base) throw new Error("Missing isolated URL");
    const url = new URL(base);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    const withoutStorage = await createUsDevelopmentApplication(
      parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
      (_url, options) => createDb(url.toString(), options),
    );
    const originalUrl = serverUrl;
    try {
      await withoutStorage.init();
      await listenOnLoopback(withoutStorage);
      serverUrl = `http://127.0.0.1:${(withoutStorage.getHttpServer().address() as AddressInfo).port}`;
      const list = usPlanListResponseSchema.parse(await (await request()).json());
      expect(list.publicationAvailability).toBe("artifact_storage_unconfigured");
      const draft = usPlanDraftCommandResponseSchema.parse(
        await (await request(path, "POST", { sections, changeSummary: "Without store" })).json(),
      );
      const route = `${path}/${draft.id}`;
      expect((await request(route)).status).toBe(200);
      const before = await state();
      expect(
        (await request(`${route}/validate`, "POST", { expectedRevision: 1, confirmations })).status,
      ).toBe(200);
      expect((await request(`${route}/preview`, "POST", { expectedRevision: 1 })).status).toBe(200);
      expect(await state()).toEqual(before);
      for (const response of [
        await request(`${route}/approve`, "POST", {
          expectedRevision: 1,
          confirmations,
          idempotencyKey: randomUUID(),
        }),
        await request(`${path}/${list.items[0]?.id}/pdf`),
      ]) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "us_plan_artifact_storage_unconfigured" });
      }
      expect((await request(`${route}/discard`, "POST", { expectedRevision: 1 })).status).toBe(204);
    } finally {
      serverUrl = originalUrl;
      await withoutStorage.close();
    }
  }, 20_000);
  it("preserves trusted synthetic provenance across HTTP detail, preview and approved PDF", async () => {
    const seed = await new UsDevelopmentOwnerStore(f.db).provision(password, "http-seed");
    await f.db.insert(schema.traceabilityProfiles).values({
      tenantId: seed.tenantId,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await f.db
      .insert(schema.orgProfiles)
      .values({ tenantId: seed.tenantId, timeZone: "America/Chicago" });
    const party = randomUUID();
    await f.db
      .insert(schema.traceabilityParties)
      .values({ id: party, tenantId: seed.tenantId, name: "Source" });
    const [source] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!source) throw new Error("Missing source");
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...source, id: randomUUID(), tenantId: seed.tenantId, partyId: party });
    const [user] = await f.db.select().from(schema.user).where(eq(schema.user.id, seed.userId));
    if (!user) throw new Error("Missing seed user");
    client = new UsAuthTestClient(transport);
    expect((await client.request("/sign-in/email", { email: user.email, password })).status).toBe(
      200,
    );
    const enrollment: unknown = await (
      await client.request("/two-factor/enable", { password })
    ).json();
    if (
      typeof enrollment !== "object" ||
      enrollment === null ||
      !("totpURI" in enrollment) ||
      typeof enrollment.totpURI !== "string"
    )
      throw new Error("Invalid enrollment");
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(enrollment.totpURI) }))
        .status,
    ).toBe(200);
    expect(
      (await client.request("/organization/set-active", { organizationId: seed.tenantId })).status,
    ).toBe(200);
    const draft = usPlanDraftCommandResponseSchema.parse(
      await (await request(path, "POST", { sections, changeSummary: "" })).json(),
    );
    const route = `${path}/${draft.id}`;
    expect(usPlanDetailResponseSchema.parse(await (await request(route)).json()).provenance).toBe(
      "trusted_synthetic",
    );
    expect(
      usPlanListResponseSchema.parse(await (await request()).json()).items[0]?.provenance,
    ).toBe("trusted_synthetic");
    const preview = await request(`${route}/preview`, "POST", { expectedRevision: 1 });
    const approved = await request(`${route}/approve`, "POST", {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      confirmations: {
        procedures: false,
        backupAndRecovery: false,
        contact: false,
        nonFarmScope: false,
      },
    });
    expect(approved.status).toBe(200);
    expect(usPlanDetailResponseSchema.parse(await (await request(route)).json()).provenance).toBe(
      "trusted_synthetic",
    );
    for (const response of [preview, await request(`${route}/pdf`)]) {
      expect(response.status).toBe(200);
      const pages = execFileSync("pdftotext", ["-", "-"], {
        input: Buffer.from(await response.arrayBuffer()),
        encoding: "utf8",
      })
        .split("\f")
        .filter((page) => page.trim());
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages)
        expect(page).toContain("Synthetic demo — not an operational record");
    }
  }, 20_000);
});
