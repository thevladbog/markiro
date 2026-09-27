import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import { ConflictException, type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import {
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  transformationGenealogyResultSchema,
  transformationHttpErrorSchema,
  transformationHttpRecordSchema,
  transformationLifecycleReceiptSchema,
  transformationReadinessSchema,
  transformationRevisionListSchema,
} from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { zodApiSchema } from "../src/lib/openapi";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-transformation-password-42!";
const emptyDraft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [],
  outputs: [],
  documentIds: [],
};

describe.skipIf(!base)("US Transformation HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedFinalizableTransformation>>;

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
    c = await seedFinalizableTransformation(f);
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

  it("allowlists all typed routes in OpenAPI and protects reads", async () => {
    const paths = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    expect(paths?.["/traceability/transformation"]?.post).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}"]?.get).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}"]?.put).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}/readiness"]?.get).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}/finalize"]?.post).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}/amend"]?.post).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}/void"]?.post).toBeDefined();
    expect(paths?.["/traceability/transformation/{id}/revisions"]?.get).toBeDefined();
    expect(paths?.["/traceability/transformation/genealogy/query"]?.post).toBeDefined();
    const typedConflictSchema = zodApiSchema(transformationHttpErrorSchema);
    const createConflict = paths?.["/traceability/transformation"]?.post?.responses?.[409];
    const readinessConflict =
      paths?.["/traceability/transformation/{id}/readiness"]?.get?.responses?.[409];
    expect(
      createConflict && !("$ref" in createConflict)
        ? createConflict.content?.["application/json"]?.schema
        : undefined,
    ).toEqual(typedConflictSchema);
    expect(
      readinessConflict && !("$ref" in readinessConflict)
        ? readinessConflict.content?.["application/json"]?.schema
        : undefined,
    ).toEqual(typedConflictSchema);
    expect(paths?.["/boxes"]).toBeUndefined();
    const path = `/traceability/transformation/${c.saved.id}`;
    expect((await request(path, "GET", undefined, { cookie: "" })).status).toBe(401);
    const read = await request(path);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    transformationHttpRecordSchema.parse(await read.json());
    expect((await request("/boxes")).status).toBe(404);
  });

  it("creates incomplete drafts and saves, finalizes, amends and voids a complete revision", async () => {
    const createBody = { operationKey: randomUUID(), draft: emptyDraft };
    const created = await request("/traceability/transformation", "POST", createBody);
    expect(created.status).toBe(201);
    const incomplete = transformationDraftRecordSchema.parse(await created.json());
    const replay = await request("/traceability/transformation", "POST", createBody);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(incomplete);
    const rebound = await request("/traceability/transformation", "POST", {
      ...createBody,
      draft: { ...emptyDraft, notes: "Different intent" },
    });
    expect(rebound.status).toBe(409);
    expect(transformationHttpErrorSchema.parse(await rebound.json()).code).toBe(
      "transformation_operation_conflict",
    );
    const incompleteReadiness = await request(
      `/traceability/transformation/${incomplete.id}/readiness?expectedDraftVersion=1`,
    );
    expect(incompleteReadiness.status).toBe(200);
    const incompleteReady = transformationReadinessSchema.parse(await incompleteReadiness.json());
    expect(incompleteReady.state).toBe("incomplete");
    const incompleteFinal = await request(
      `/traceability/transformation/${incomplete.id}/finalize`,
      "POST",
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: incompleteReady.inputDigest,
      },
    );
    expect(incompleteFinal.status).toBe(409);
    const incompleteError = transformationHttpErrorSchema.parse(await incompleteFinal.json());
    expect(incompleteError.code).toBe("event_incomplete");
    if (incompleteError.code !== "event_incomplete") throw new Error("Expected readiness issues");
    expect(incompleteError.issues.length).toBeGreaterThan(0);

    const path = `/traceability/transformation/${c.saved.id}`;
    const saveBody = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.saved.draft, notes: "HTTP saved run" },
    };
    const save = await request(path, "PUT", saveBody);
    expect(save.status).toBe(200);
    const saved = transformationDraftRecordSchema.parse(await save.json());
    expect(saved.draftVersion).toBe(2);
    const saveReplay = await request(path, "PUT", saveBody);
    expect(saveReplay.status).toBe(200);
    expect(transformationDraftRecordSchema.parse(await saveReplay.json())).toEqual(saved);
    const readyResponse = await request(`${path}/readiness?expectedDraftVersion=2`);
    expect(readyResponse.status).toBe(200);
    const ready = transformationReadinessSchema.parse(await readyResponse.json());
    expect(ready.state).toBe("complete");
    const finalizeBody = {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
    };
    const finalize = await request(`${path}/finalize`, "POST", finalizeBody);
    expect(finalize.status).toBe(200);
    const final = transformationFinalizedRecordSchema.parse(await finalize.json());
    const finalizeReplay = await request(`${path}/finalize`, "POST", finalizeBody);
    expect(finalizeReplay.status).toBe(200);
    expect(transformationFinalizedRecordSchema.parse(await finalizeReplay.json())).toEqual(final);
    expect(transformationHttpRecordSchema.parse(await (await request(path)).json()).status).toBe(
      "finalized",
    );
    const amend = await request(`${path}/amend`, "POST", {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct synthetic run",
    });
    expect(amend.status).toBe(200);
    const amendment = transformationLifecycleReceiptSchema.parse(await amend.json());
    expect(amendment.record.status).toBe("draft");
    const revisions = await request(`${path}/revisions?limit=10&offset=0`);
    expect(revisions.status).toBe(200);
    expect(transformationRevisionListSchema.parse(await revisions.json()).items).toHaveLength(2);
    const voided = await request(`/traceability/transformation/${amendment.eventId}/void`, "POST", {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: 1,
      reason: "Cancel correction",
    });
    expect(voided.status).toBe(200);
    expect(transformationLifecycleReceiptSchema.parse(await voided.json()).record.status).toBe(
      "void",
    );
    expect(final.snapshot.eventId).toBe(c.saved.id);
  });

  it("queries current and pinned genealogy and preserves typed errors and HTTP boundaries", async () => {
    const current = await request("/traceability/transformation/genealogy/query", "POST", {
      mode: "current",
      startLotId: c.origin.snapshot.items[0]?.lotId,
      direction: "downstream",
      maxDepth: 2,
      maxNodes: 20,
    });
    expect(current.status).toBe(200);
    const result = transformationGenealogyResultSchema.parse(await current.json());
    expect(result.mode).toBe("current");
    const pinned = await request("/traceability/transformation/genealogy/query", "POST", {
      mode: "pinned",
      pinnedRevisionIds: [],
      startLotId: c.origin.snapshot.items[0]?.lotId,
      direction: "downstream",
      maxDepth: 2,
      maxNodes: 20,
    });
    expect(pinned.status).toBe(200);
    transformationGenealogyResultSchema.parse(await pinned.json());
    const conflict = await request(`/traceability/transformation/${c.saved.id}/finalize`, "POST", {
      operationKey: randomUUID(),
      expectedDraftVersion: 999,
      expectedInputDigest: "a".repeat(64),
    });
    expect(conflict.status).toBe(409);
    transformationHttpErrorSchema.parse(await conflict.json());
    expect((await request("/traceability/transformation/nope")).status).toBe(400);
    expect((await request(`/traceability/transformation/${randomUUID()}`)).status).toBe(404);
    expect((await request(`/traceability/transformation/${c.origin.id}`)).status).toBe(404);
    const foreign = await seedFinalizableTransformation(f);
    const foreignResponse = await request(`/traceability/transformation/${foreign.saved.id}`);
    expect(foreignResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual(
      await (await request(`/traceability/transformation/${randomUUID()}`)).json(),
    );
    expect(
      (
        await request(`/traceability/transformation/${c.saved.id}`, "GET", undefined, {
          host: "wrong.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/traceability/transformation/genealogy/query",
          "POST",
          {},
          { origin: "http://wrong.test" },
        )
      ).status,
    ).toBe(403);
    const oversize = {
      operationKey: randomUUID(),
      draft: { ...emptyDraft, notes: "x".repeat(17000) },
    };
    expect((await request("/traceability/transformation", "POST", oversize)).status).toBe(400);
    expect(
      (
        await request(`/traceability/transformation/${c.saved.id}/finalize`, "POST", {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          expectedInputDigest: "a".repeat(64),
          padding: "x".repeat(17000),
        })
      ).status,
    ).toBe(413);
    const largeDraft = {
      ...emptyDraft,
      inputs: Array.from({ length: 100 }, () => ({
        kind: "non_ftl",
        productId: null,
        sourceLocationId: null,
        reference: "x".repeat(2000),
        quantity: null,
        unitOfMeasure: null,
      })),
    };
    const largeCreate = await request("/traceability/transformation", "POST", {
      operationKey: randomUUID(),
      draft: largeDraft,
    });
    expect(largeCreate.status).toBe(201);
    const large = transformationDraftRecordSchema.parse(await largeCreate.json());
    const largeSave = await request(`/traceability/transformation/${large.id}`, "PUT", {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: largeDraft,
    });
    expect(largeSave.status).toBe(200);
    transformationDraftRecordSchema.parse(await largeSave.json());
    expect(
      (
        await request("/traceability/transformation", "POST", {
          operationKey: randomUUID(),
          draft: largeDraft,
          padding: "x".repeat(60000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(`/traceability/transformation/${large.id}`, "PUT", {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: largeDraft,
          padding: "x".repeat(60000),
        })
      ).status,
    ).toBe(413);
  });

  it("reloads roles and denies production changes to QA amendment drafts", async () => {
    const root = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.saved.draft,
          outputs: c.saved.draft.outputs.map((line) => ({ ...line, tlc: "HTTP-ROLE-ROOT" })),
        },
      },
      "role-root",
    );
    const rootReady = await c.store.checkReadiness(c.tenant, c.actor, root.id, {
      expectedDraftVersion: 1,
    });
    expect(rootReady.state).toBe("complete");
    await c.store.finalize(
      c.tenant,
      c.actor,
      root.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: rootReady.inputDigest,
      },
      "role-root-finalize",
    );
    const path = `/traceability/transformation/${root.id}`;
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    expect((await request(path)).status).toBe(200);
    expect(
      (
        await request("/traceability/transformation", "POST", {
          operationKey: randomUUID(),
          draft: emptyDraft,
        })
      ).status,
    ).toBe(403);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    expect(
      (
        await request(`${path}/finalize`, "POST", {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: "a".repeat(64),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/traceability/transformation/genealogy/query", "POST", {
          mode: "current",
          startLotId: c.origin.snapshot.items[0]?.lotId,
          direction: "downstream",
          maxDepth: 1,
          maxNodes: 10,
        })
      ).status,
    ).toBe(200);
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    const amend = await request(`${path}/amend`, "POST", {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Further correction",
    });
    expect(amend.status).toBe(200);
    const amendment = transformationLifecycleReceiptSchema.parse(await amend.json());
    if (amendment.record.status !== "draft") throw new Error("Expected amendment draft");
    const saveBody = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: amendment.record.draft,
    };
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    const deniedSave = await request(
      `/traceability/transformation/${amendment.eventId}`,
      "PUT",
      saveBody,
    );
    expect(deniedSave.status).toBe(403);
    expect(await deniedSave.json()).toEqual({ code: "insufficient_permission" });
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    const authorizedSave = await request(
      `/traceability/transformation/${amendment.eventId}`,
      "PUT",
      saveBody,
    );
    expect(authorizedSave.status).toBe(200);
    transformationDraftRecordSchema.parse(await authorizedSave.json());
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    expect(
      (await request(`/traceability/transformation/${amendment.eventId}`, "PUT", saveBody)).status,
    ).toBe(403);
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
  });

  it("bounds downstream conflict rows at HTTP while the command sees every consumer", async () => {
    const root = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.saved.draft,
          outputs: c.saved.draft.outputs.map((line) => ({ ...line, tlc: "HTTP-BLOCK-ROOT" })),
        },
      },
      "blocker-root",
    );
    const rootReady = await c.store.checkReadiness(c.tenant, c.actor, root.id, {
      expectedDraftVersion: 1,
    });
    expect(rootReady.state).toBe("complete");
    const finalizedRoot = await c.store.finalize(
      c.tenant,
      c.actor,
      root.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: rootReady.inputDigest,
      },
      "blocker-root-finalize",
    );
    const path = `/traceability/transformation/${root.id}`;
    const current = transformationFinalizedRecordSchema.parse(await (await request(path)).json());
    expect(current.id).toBe(finalizedRoot.id);
    const outputLotId = current.snapshot.outputs[0]?.lotId;
    if (!outputLotId) throw new Error("Expected output lot");
    for (let index = 0; index < 101; index++) {
      const child = await c.store.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: {
            ...root.draft,
            inputs: [
              { kind: "ftl_lot", lotId: outputLotId, quantity: "100", unitOfMeasure: "case" },
            ],
            outputs: root.draft.outputs.map((line) => ({ ...line, tlc: `HTTP-DOWN-${index}` })),
          },
        },
        `downstream-create-${index}`,
      );
      const readiness = await c.store.checkReadiness(c.tenant, c.actor, child.id, {
        expectedDraftVersion: 1,
      });
      expect(readiness.state).toBe("complete");
      await c.store.finalize(
        c.tenant,
        c.actor,
        child.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: readiness.inputDigest,
        },
        `downstream-finalize-${index}`,
      );
    }
    const lifecycle = transformationFinalizedRecordSchema.parse(
      await (await request(path)).json(),
    ).lifecycle;
    const body = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: lifecycle?.lifecycleVersion,
      reason: "Blocked by downstream production",
    };
    const internalError: unknown = await c.store
      .void(c.tenant, c.actor, root.id, body, "internal-check")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(internalError).toBeInstanceOf(ConflictException);
    if (!(internalError instanceof ConflictException)) throw new Error("Expected conflict");
    const internalResponse = internalError.getResponse();
    expect(internalResponse).toMatchObject({ code: "traceability_downstream_blocked" });
    if (
      typeof internalResponse !== "object" ||
      internalResponse === null ||
      !("blockers" in internalResponse) ||
      !Array.isArray(internalResponse.blockers)
    )
      throw new Error("Expected full internal blockers");
    expect(internalResponse.blockers).toHaveLength(101);
    const blocked = await request(`${path}/void`, "POST", body);
    expect(blocked.status).toBe(409);
    const response = transformationHttpErrorSchema.parse(await blocked.json());
    if (response.code !== "traceability_downstream_blocked") throw new Error("Expected blockers");
    expect(response.blockers).toHaveLength(100);
    expect(response.hasMore).toBe(true);
    expect(new Set(response.blockers.map((item) => item.eventId)).size).toBe(100);
  }, 180_000);
});
