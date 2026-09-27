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
  shippingHistoricalRecordSchema,
  shippingLifecycleReceiptSchema,
  shippingDraftRecordSchema,
  shippingHttpErrorSchema,
  shippingReadinessSchema,
  shippingRevisionListSchema,
  shippingBalanceResponseSchema,
} from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { zodApiSchema } from "../src/lib/openapi";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-shipping-password-42!";
const emptyDraft = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};

describe.skipIf(!base)("US Shipping HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedReceivingTenant>>;

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
    f = await createUsProfileTestDatabase(base!);
    const identity = await f.pool.query("SELECT current_database() AS name");
    const url = new URL(base!);
    url.pathname = `/${String(identity.rows[0]?.name)}`;
    app = await createUsDevelopmentApplication(
      parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
      (_url, options) => createDb(url.toString(), options),
    );
    await app.init();
    await listenOnLoopback(app);
    serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    c = await seedReceivingTenant(f.db);
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

  it("exposes typed lifecycle routes and protected reads", async () => {
    const paths = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    expect(paths?.["/traceability/shipments"]?.post).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}"]?.get).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}"]?.put).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}/readiness"]?.get).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}/finalize"]?.post).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}/amend"]?.post).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}/void"]?.post).toBeDefined();
    expect(paths?.["/traceability/shipments/{id}/revisions"]?.get).toBeDefined();
    expect(paths?.["/traceability/lots/{id}/shipping-balance"]?.get).toBeDefined();
    const conflict = paths?.["/traceability/shipments/{id}/finalize"]?.post?.responses?.[409];
    expect(
      conflict && !("$ref" in conflict)
        ? conflict.content?.["application/json"]?.schema
        : undefined,
    ).toEqual(zodApiSchema(shippingHttpErrorSchema));
    expect(
      (await request(`/traceability/shipments/${randomUUID()}`, "GET", undefined, { cookie: "" }))
        .status,
    ).toBe(401);
  });

  it("exposes a read-only lot balance with strict query and tenant scope", async () => {
    const path = `/traceability/lots/${c.lot}/shipping-balance`;
    const result = await request(path);
    expect(result.status).toBe(200);
    expect(shippingBalanceResponseSchema.parse(await result.json())).toEqual({
      lotId: c.lot,
      originUom: null,
      balance: { state: "unknown", reason: "no_current_origin" },
    });
    expect((await request(`${path}?contextDraftId=${randomUUID()}`)).status).toBe(400);
    expect((await request(`${path}?excludedEventId=${randomUUID()}`)).status).toBe(400);
    expect((await request(`/traceability/lots/${randomUUID()}/shipping-balance`)).status).toBe(404);
    expect((await request(path, "GET", undefined, { cookie: "" })).status).toBe(401);
  });

  it("creates, replays, replaces, checks readiness and blocks incomplete finalization", async () => {
    const createBody = { operationKey: randomUUID(), draft: emptyDraft };
    const created = await request("/traceability/shipments", "POST", createBody);
    expect(created.status).toBe(201);
    const saved = shippingDraftRecordSchema.parse(await created.json());
    expect((await request("/traceability/shipments", "POST", createBody)).status).toBe(201);
    expect((await request(`/traceability/shipments/${saved.id}`)).status).toBe(200);
    const save = await request(`/traceability/shipments/${saved.id}`, "PUT", {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...emptyDraft, notes: "HTTP saved draft" },
    });
    expect(save.status).toBe(200);
    expect(shippingDraftRecordSchema.parse(await save.json()).draftVersion).toBe(2);
    const readinessResponse = await request(
      `/traceability/shipments/${saved.id}/readiness?expectedDraftVersion=2`,
    );
    expect(readinessResponse.status).toBe(200);
    const ready = shippingReadinessSchema.parse(await readinessResponse.json());
    expect(ready.state).toBe("incomplete");
    const final = await request(`/traceability/shipments/${saved.id}/finalize`, "POST", {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
    });
    expect(final.status).toBe(409);
    expect(shippingHttpErrorSchema.parse(await final.json()).code).toBe("event_incomplete");
    expect(
      (
        await request(`/traceability/shipments/${saved.id}`, "PUT", {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          draft: { ...emptyDraft, tlc: "forbidden" },
        })
      ).status,
    ).toBe(400);
    expect((await request(`/traceability/shipments/${saved.id}/amend`, "POST", {})).status).toBe(
      400,
    );
    const history = await request(
      `/traceability/shipments/${saved.id}/revisions?limit=10&offset=0`,
    );
    expect(history.status).toBe(200);
    expect(shippingRevisionListSchema.parse(await history.json()).items).toMatchObject([
      { id: saved.id, status: "draft" },
    ]);
    expect(
      (await request(`/traceability/shipments/${saved.id}/revisions?limit=101&offset=0`)).status,
    ).toBe(400);
    const voided = await request(`/traceability/shipments/${saved.id}/void`, "POST", {
      operationKey: randomUUID(),
      expectedLifecycleVersion: saved.lifecycle?.lifecycleVersion,
      expectedDraftVersion: 2,
      reason: "Cancel incomplete draft",
    });
    expect(voided.status).toBe(200);
    expect(shippingLifecycleReceiptSchema.parse(await voided.json()).record.status).toBe("void");
    const historical = await request(`/traceability/shipments/${saved.id}`);
    expect(historical.status).toBe(200);
    expect(shippingHistoricalRecordSchema.parse(await historical.json()).status).toBe("void");
  });
});
