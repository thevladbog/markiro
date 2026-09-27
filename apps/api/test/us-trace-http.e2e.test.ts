import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import { type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import { usCurrentTraceResultSchema, usTraceHistoryPageSchema } from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { seedTwoByTwoGenealogy } from "./support/us-transformation-genealogy-fixture";
import * as evidence from "../src/modules/traceability/trace/us-trace-evidence";
import { seedShippingLifecycle } from "./support/us-shipping-lifecycle-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-transformation-password-42!";

describe.skipIf(!base)("US current trace HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedTwoByTwoGenealogy>>;

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
    c = await seedTwoByTwoGenealogy(f);
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

  afterEach(() => vi.restoreAllMocks());
  const path = () => `/traceability/lots/${c.revision.snapshot.outputs[0]!.lotId}/trace`;

  it("returns current evidence and excluded history without writing business or audit rows", async () => {
    const counts = () =>
      f.pool.query(`SELECT
      (SELECT count(*) FROM tenant_audit_events) AS audit,
      (SELECT count(*) FROM traceability_events) AS events,
      (SELECT count(*) FROM traceability_lots) AS lots,
      (SELECT count(*) FROM lot_genealogy_edges) AS edges,
      (SELECT count(*) FROM trace_lot_boxes) AS boxes,
      (SELECT count(*) FROM transformation_event_roots) AS transformations,
      (SELECT count(*) FROM receiving_event_roots) AS receiving,
      (SELECT count(*) FROM shipping_event_roots) AS shipping`);
    const before = (await counts()).rows;
    const response = await request(path());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = usCurrentTraceResultSchema.parse(await response.json());
    expect(result.currentEvents.map((event) => event.id)).toEqual([c.origin.id, c.revision.id]);
    expect(result.edges.filter((edge) => edge.kind === "receiving")).toMatchObject([
      { eventId: c.origin.id, lineNo: 1, locationDisplay: "Synthetic supplier" },
      { eventId: c.origin.id, lineNo: 2, locationDisplay: "Synthetic supplier" },
    ]);
    expect(result.nodes.find((node) => node.kind === "location")).toMatchObject({
      display: "Synthetic supplier",
      displayEdgeId: `${c.origin.id}:receiving:2`,
    });
    expect(result.excludedSummary).toEqual({ count: 1 });
    const history = await request(path() + "/history?limit=1");
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(
      usTraceHistoryPageSchema.parse(await history.json()).items.map((item) => item.eventId),
    ).toEqual([c.original.id]);
    expect((await counts()).rows).toEqual(before);
  });

  it.each(["", "/history"])(
    "requires a verified session and current read capability: %s",
    async (suffix) => {
      expect((await request(path() + suffix, "GET", undefined, { cookie: "" })).status).toBe(401);
      await f.db
        .update(schema.member)
        .set({ role: "member" })
        .where(eq(schema.member.organizationId, c.tenant));
      try {
        expect((await request(path() + suffix)).status).toBe(403);
      } finally {
        await f.db
          .update(schema.member)
          .set({ role: "owner" })
          .where(eq(schema.member.organizationId, c.tenant));
      }
    },
  );

  it.each(["", "/history"])("hides foreign and absent lots identically: %s", async (suffix) => {
    const foreign = await seedShippingLifecycle(f.db);
    const missing = await request(`/traceability/lots/${randomUUID()}/trace${suffix}`);
    const other = await request(`/traceability/lots/${foreign.lot}/trace${suffix}`);
    expect(missing.status).toBe(404);
    expect(other.status).toBe(404);
    expect(await missing.json()).toEqual(await other.json());
  });

  it.each([
    "?maxDepth=1&maxDepth=2",
    "?direction=both&direction=both",
    "?maxDepth=1&%6daxDepth=2",
    "?tenantId=x",
    "?maxNodes=501",
    "?maxDepth=21",
    "?maxDepth=01",
    "?maxNodes=0",
    "?direction=other",
    "/history?limit=101",
    "/history?limit=1&limit=2",
    "/history?cursor=not-a-cursor",
    "/history?cursor=a&cursor=b",
    "/history?tenantId=x",
  ])("rejects invalid strict raw query %s", async (query) => {
    expect((await request(path() + query)).status).toBe(400);
  });

  it("validates UUIDs and exposes only the two read routes with documented errors", async () => {
    const paths = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    for (const suffix of ["", "/history"]) {
      const route = paths[`/traceability/lots/{id}/trace${suffix}`];
      expect(Object.keys(route ?? {})).toEqual(["get"]);
      expect(Object.keys(route?.get?.responses ?? {}).sort()).toEqual([
        "200",
        "400",
        "401",
        "403",
        "404",
        "503",
      ]);
      expect((await request("/traceability/lots/not-a-uuid/trace" + suffix)).status).toBe(400);
      expect((await request(path() + suffix, "POST", {})).status).toBe(404);
      expect((await request(path() + suffix + "/extra")).status).toBe(404);
    }
  });

  it("returns sanitized 503 for inconsistent persisted evidence", async () => {
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE transformation_event_roots SET event_number='TRN-26-9999' WHERE id=${c.original.id}`,
      );
    });
    try {
      for (const suffix of ["", "/history"]) {
        const response = await request(path() + suffix);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      }
    } finally {
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE transformation_event_roots SET event_number=${c.original.eventNumber} WHERE id=${c.original.id}`,
        );
      });
    }
  });

  it("returns 503 rather than a partial graph after a real database statement timeout", async () => {
    vi.spyOn(evidence, "readCurrentTraceFrontier").mockImplementation(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='1ms'`);
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      return { events: [], hasMore: false };
    });
    const response = await request(path());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "us_database_unavailable" });
  });
});
