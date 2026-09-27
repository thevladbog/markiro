import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import {
  caseLinkResultSchema,
  caseListResultSchema,
  caseLookupResultSchema,
} from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { seedCaseBridge } from "./support/us-case-bridge-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-case-password-42!";
describe.skipIf(!base)("US case HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let c: Awaited<ReturnType<typeof seedCaseBridge>>;
  let client: UsAuthTestClient;

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
    c = await seedCaseBridge(f);
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

  it("registers only US routes and schemas and protects every response", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    expect(document.paths?.[`/traceability/lots/{lotId}/cases`]?.get).toBeDefined();
    expect(document.paths?.[`/traceability/lots/{lotId}/cases`]?.post).toBeDefined();
    expect(
      document.paths?.[`/traceability/lots/{lotId}/cases/{linkId}/unlink`]?.post,
    ).toBeDefined();
    expect(document.paths?.["/traceability/cases/lookup"]?.get).toBeDefined();
    expect(document.paths?.["/boxes"]).toBeUndefined();
    const denied = await request(`/traceability/lots/${c.lotId}/cases`, "GET", undefined, {
      cookie: "",
    });
    expect(denied.status).toBe(401);
    const list = await request(`/traceability/lots/${c.lotId}/cases`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(caseListResultSchema.parse(await list.json()).activeCount).toBe(0);
    expect((await request("/boxes")).status).toBe(404);
  });

  it("links, replays, looks up, rejects strict input and enforces HTTP limits", async () => {
    const path = `/traceability/lots/${c.lotId}/cases`;
    const body = { operationKey: randomUUID(), ssccs: [c.codes[0]] };
    const first = await request(path, "POST", body);
    expect(first.status).toBe(200);
    const result = caseLinkResultSchema.parse(await first.json());
    expect(result.created).toHaveLength(1);
    const replay = await request(path, "POST", body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    const conflict = await request(path, "POST", { ...body, ssccs: [c.codes[1]] });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "case_operation_conflict" });
    const lookup = await request(`/traceability/cases/lookup?sscc=(00)${c.codes[0]}`);
    expect(lookup.status).toBe(200);
    expect(caseLookupResultSchema.parse(await lookup.json()).activeLink?.linkId).toBe(
      result.created[0]?.linkId,
    );
    const unlinkPath = `${path}/${result.created[0]?.linkId}/unlink`;
    const unlinkBody = { operationKey: randomUUID(), reason: "Correct linked case" };
    const unlinked = await request(unlinkPath, "POST", unlinkBody);
    expect(unlinked.status).toBe(200);
    expect((await request(unlinkPath, "POST", unlinkBody)).status).toBe(200);
    const stale = await request(unlinkPath, "POST", { ...unlinkBody, operationKey: randomUUID() });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "case_link_stale" });
    const invalid = await request(path, "POST", {
      ...body,
      operationKey: randomUUID(),
      extra: true,
    });
    expect(invalid.status).toBe(400);
    expect((await request(`/traceability/cases/lookup?sscc=invalid`)).status).toBe(400);
    expect(
      (await request(`/traceability/cases/lookup?sscc=${c.codes[0]}&tenantId=${c.tenant}`)).status,
    ).toBe(400);
    expect((await request(`${path}?cursor=invalid`)).status).toBe(400);
    expect((await request(path, "POST", body, { origin: "http://wrong.test" })).status).toBe(403);
    expect((await request(path, "POST", body, { host: "wrong.test" })).status).toBe(403);
    expect(
      (
        await request(path, "POST", {
          operationKey: randomUUID(),
          ssccs: [c.codes[1]],
          padding: "x".repeat(17000),
        })
      ).status,
    ).toBe(413);
  });

  it("reloads role on reads and writes, and does not disclose foreign tenant cases", async () => {
    const path = `/traceability/lots/${c.lotId}/cases`;
    await f.pool.query("UPDATE member SET role='traceability_auditor' WHERE id=$1", [c.member]);
    expect((await request(path)).status).toBe(200);
    const denied = await request(path, "POST", { operationKey: randomUUID(), ssccs: [c.codes[1]] });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: "insufficient_permission" });
    await f.pool.query("UPDATE member SET role='traceability_qa' WHERE id=$1", [c.member]);
    const qa = await request(path, "POST", { operationKey: randomUUID(), ssccs: [c.codes[1]] });
    expect(qa.status).toBe(200);
    const foreign = await seedCaseBridge(f);
    const foreignList = await request(`/traceability/lots/${foreign.lotId}/cases`);
    expect(foreignList.status).toBe(404);
    const missingList = await request(`/traceability/lots/${randomUUID()}/cases`);
    expect(await foreignList.json()).toEqual(await missingList.json());
    const foreignCode = buildSscc(0, "7654321", 123);
    await f.pool.query("UPDATE boxes SET sscc=$1 WHERE tenant_id=$2 AND id=$3", [
      foreignCode,
      foreign.tenant,
      foreign.boxes[0]?.id,
    ]);
    const unknown = await request(`/traceability/cases/lookup?sscc=${foreignCode}`);
    expect(unknown.status).toBe(404);
    const missingCode = buildSscc(0, "7654321", 124);
    const missing = await request(`/traceability/cases/lookup?sscc=${missingCode}`);
    expect(await unknown.json()).toEqual(await missing.json());
    await f.pool.query("UPDATE member SET role='member' WHERE id=$1", [c.member]);
    expect((await request(path)).status).toBe(403);
    await f.pool.query("DELETE FROM member WHERE id=$1", [c.member]);
    expect((await request(path)).status).toBe(403);
  });
});
