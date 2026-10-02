import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import { usReadinessResultSchema } from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { UsRuntime } from "../src/deployment/us-runtime";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-readiness-password-42!";
const path = "/traceability/readiness";
const dates = "eventDateFrom=2026-09-01&eventDateTo=2026-09-28";

describe.skipIf(!base)("US readiness HTTP", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication, serverUrl: string;
  let client: UsAuthTestClient;
  let c: Awaited<ReturnType<typeof seedShippingLifecycle>>;
  let shipment: Awaited<ReturnType<typeof finalizeFixtureShipment>>;

  async function transport(input: Request): Promise<Response> {
    const body = await input.text();
    return new Promise((resolve, reject) => {
      const headers = new Headers(input.headers);
      headers.set("host", "localhost:3100");
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
              if (Array.isArray(value)) for (const entry of value) resultHeaders.append(key, entry);
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
    });
  }

  function request(url = path, method = "GET", authenticated = true) {
    const headers = authenticated ? client.headers() : new Headers();
    headers.set("origin", "http://localhost:5174");
    headers.set("content-type", "application/json");
    return transport(new Request(`http://localhost:3100${url}`, { method, headers }));
  }

  async function state() {
    const result = await f.pool.query(
      `SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_events x WHERE tenant_id=$1) events,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_lots x WHERE tenant_id=$1) lots,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tenant_audit_events x WHERE organization_id=$1) audits,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM receiving_event_roots x WHERE tenant_id=$1) receiving,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM shipping_event_roots x WHERE tenant_id=$1) shipping,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY event_id,line_no) FROM receiving_event_items x WHERE tenant_id=$1) receiving_items,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY event_id,line_no) FROM shipping_event_items x WHERE tenant_id=$1) shipping_items,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM trace_lot_boxes x WHERE tenant_id=$1) boxes`,
      [c.tenant],
    );
    return result.rows[0];
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
    c = await seedShippingLifecycle(f.db);
    shipment = await finalizeFixtureShipment(c, "20");
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

  it("returns complete no-store results with exact date/product/lot filters and no writes", async () => {
    const before = await state();
    const defaultResponse = await request();
    expect(defaultResponse.status).toBe(200);
    expect(defaultResponse.headers.get("cache-control")).toBe("no-store");
    expect(usReadinessResultSchema.parse(await defaultResponse.json()).scope.defaulted).toBe(true);
    const response = await request(`${path}?${dates}&productId=${c.product}&lotId=${c.lot}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(usReadinessResultSchema.parse(await response.json())).toMatchObject({
      scope: {
        eventDateFrom: "2026-09-01",
        eventDateTo: "2026-09-28",
        productId: c.product,
        lotId: c.lot,
        defaulted: false,
      },
      state: "assessed",
      recordsChecked: { events: 2, lots: 2 },
      findings: [],
      counts: { error: 0, warning: 0, info: 0 },
    });
    const narrow = await request(
      `${path}?eventDateFrom=2026-09-27&eventDateTo=2026-09-27&lotId=${c.lot}`,
    );
    expect(narrow.status).toBe(200);
    expect(usReadinessResultSchema.parse(await narrow.json())).toMatchObject({
      recordsChecked: { events: 1, lots: 1 },
      dependenciesChecked: 1,
    });
    const empty = await request(`${path}?eventDateFrom=2020-01-01&eventDateTo=2020-01-31`);
    expect(empty.status).toBe(200);
    expect(usReadinessResultSchema.parse(await empty.json())).toMatchObject({
      state: "empty",
      recordsChecked: { events: 0, lots: 0 },
      findings: [],
    });
    expect(await state()).toEqual(before);
  });

  it("requires a verified session and rejects a reader whose current capability was revoked", async () => {
    const anonymous = await request(path, "GET", false);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    await f.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, c.actor));
    try {
      const before = await state();
      const denied = await request();
      expect(denied.status).toBe(403);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(await state()).toEqual(before);
    } finally {
      await f.db
        .update(schema.member)
        .set({ role: "owner" })
        .where(eq(schema.member.userId, c.actor));
    }
  });

  it("rejects duplicate decoded keys and strict invalid queries without writes", async () => {
    const before = await state();
    for (const query of [
      "eventDateFrom=2026-01-01",
      "eventDateTo=2026-09-28",
      "eventDateFrom=2026-02-30&eventDateTo=2026-03-01",
      "eventDateFrom=2026-09-28&eventDateTo=2026-09-01",
      "eventDateFrom=2024-09-01&eventDateTo=2026-09-28",
      "eventDateFrom=2026-9-01&eventDateTo=2026-09-28",
      "lotId=not-a-uuid",
      "productId=not-a-uuid",
      "tenantId=x",
      "actorUserId=x",
      "profileCode=US_GENERIC_LOT_TRACEABILITY",
      "lotId[]=x",
      `${dates}&eventDateFrom=2026-09-02`,
      `${dates}&%65ventDateFrom=2026-09-02`,
      `lotId=${c.lot}&%6cotId=${c.lot}`,
      `productId=${c.product}&productId=${c.product}`,
    ]) {
      const response = await request(`${path}?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await state()).toEqual(before);
  });

  it("hides foreign and missing explicit lot/product IDs behind identical 404s", async () => {
    const foreign = await seedShippingLifecycle(f.db);
    const before = await state();
    for (const [key, id] of [
      ["lotId", foreign.lot],
      ["productId", foreign.product],
    ]) {
      const missing = await request(`${path}?${dates}&${key}=${randomUUID()}`);
      const other = await request(`${path}?${dates}&${key}=${id}`);
      expect(missing.status).toBe(404);
      expect(other.status).toBe(404);
      expect(await missing.json()).toEqual({ code: "us_readiness_scope_not_found" });
      expect(await other.json()).toEqual({ code: "us_readiness_scope_not_found" });
      expect(other.headers.get("cache-control")).toBe("no-store");
    }
    expect(await state()).toEqual(before);
  });

  it("rejects anonymous method/path aliases before authentication and never invokes the read", async () => {
    const runtime = app.get(UsRuntime);
    const read = vi.spyOn(runtime.trace, "readiness");
    const databaseReady = vi.spyOn(runtime, "assertDatabaseReady");
    const before = await state();
    try {
      for (const [url, method] of [
        [path, "HEAD"],
        [path + "/", "GET"],
        ["/traceability/Readiness", "GET"],
        ["/Traceability/readiness", "GET"],
        [path + "/extra", "GET"],
        [path, "POST"],
        [path, "PUT"],
        [path, "PATCH"],
        [path, "DELETE"],
      ] as const) {
        const response = await request(url, method, false);
        expect(response.status, `${method} ${url}`).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(databaseReady).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      const exactAnonymous = await request(path, "GET", false);
      expect(exactAnonymous.status).toBe(401);
      expect(exactAnonymous.headers.get("cache-control")).toBe("no-store");
      expect(read).not.toHaveBeenCalled();
      const exactAuthenticated = await request(`${path}?${dates}`);
      expect(exactAuthenticated.status).toBe(200);
      expect(exactAuthenticated.headers.get("cache-control")).toBe("no-store");
      expect(usReadinessResultSchema.parse(await exactAuthenticated.json()).state).toBe("assessed");
      expect(read).toHaveBeenCalledOnce();
      expect(await state()).toEqual(before);
    } finally {
      read.mockRestore();
      databaseReady.mockRestore();
    }
  });

  it("documents only GET and refuses other methods, suffixes, alternate paths and RU routes", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    expect(Object.keys(document[path] ?? {})).toEqual(["get"]);
    expect(Object.keys(document[path]?.get?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "503",
    ]);
    expect(document[path]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "eventDateFrom", in: "query" }),
        expect.objectContaining({ name: "eventDateTo", in: "query" }),
        expect.objectContaining({ name: "productId", in: "query" }),
        expect.objectContaining({ name: "lotId", in: "query" }),
      ]),
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
      expect((await request(path, method)).status, method).toBe(404);
    for (const url of [
      path + "/extra",
      path + "/",
      "/traceability/Readiness",
      "/api/boxes",
      "/api/auth/get-session",
      "/api/traceability/readiness",
    ])
      expect((await request(url)).status, url).toBe(404);
  });

  it("sanitizes corrupt saved snapshots as 503 without a partial response or writes", async () => {
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: { secret: "not-for-response" } })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
    });
    try {
      const before = await state();
      const response = await request(`${path}?${dates}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      expect(await state()).toEqual(before);
    } finally {
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: shipment.snapshot })
          .where(eq(schema.traceabilityEvents.id, shipment.id));
      });
    }
  });

  it("returns a sanitized no-store 503 for an actual database lock timeout", async () => {
    const before = await state();
    const locker = await f.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE receiving_event_roots IN ACCESS EXCLUSIVE MODE");
      const response = await request(`${path}?${dates}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect(await state()).toEqual(before);
  }, 15_000);

  it("returns the narrow-scope 503 for 10001 real current roots without success truncation", async () => {
    const [event] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(
        and(
          eq(schema.traceabilityEvents.tenantId, c.tenant),
          eq(schema.traceabilityEvents.type, "receiving"),
        ),
      );
    if (!event || event.type !== "receiving") throw new Error("Missing seed receipt");
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, event.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, event.id));
    if (!root) throw new Error("Missing seed root");
    for (let offset = 0; offset < 10000; offset += 250) {
      const copies = Array.from({ length: 250 }, (_, index) => ({
        id: randomUUID(),
        number: `REC-26-${100000 + offset + index}`,
      }));
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.insert(schema.traceabilityEvents).values(
          copies.map(({ id, number }) => ({
            ...event,
            id,
            rootEventId: id,
            eventNumber: number,
          })),
        );
        await tx.insert(schema.receivingEventRoots).values(
          copies.map(({ id, number }) => ({
            ...root,
            id,
            currentEventId: id,
            eventNumber: number,
          })),
        );
        await tx
          .insert(schema.receivingEventItems)
          .values(copies.flatMap(({ id }) => items.map((item) => ({ ...item, eventId: id }))));
      });
    }
    const counts = () =>
      f.pool.query(
        `SELECT (SELECT count(*) FROM traceability_events) events, (SELECT count(*) FROM traceability_lots) lots, (SELECT count(*) FROM tenant_audit_events) audits`,
      );
    const before = (await counts()).rows;
    const response = await request(`${path}?eventDateFrom=2026-09-07&eventDateTo=2026-09-07`);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "us_readiness_scope_too_large" });
    expect((await counts()).rows).toEqual(before);
  }, 60_000);
});
