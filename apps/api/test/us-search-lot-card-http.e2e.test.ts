import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import { type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createDb, schema } from "@markiro/db";
import {
  usTraceSearchPageSchema,
  usLotCardSchema,
  usLotCardEvidencePageSchema,
} from "@markiro/platform-contracts";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./support/listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { seedTwoByTwoGenealogy } from "./support/us-transformation-genealogy-fixture";
import * as operations from "../src/modules/traceability/transformation/us-transformation-operations";
import { seedShippingLifecycle } from "./support/us-shipping-lifecycle-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-transformation-password-42!";

describe.skipIf(!base)("US search and lot card HTTP", () => {
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

  const cardPath = () => `/traceability/lots/${c.revision.snapshot.outputs[0]!.lotId}/card`;
  const paths = () => ["/traceability/search", cardPath(), cardPath() + "/evidence"];
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

  it("returns strict search/card/evidence results and empty pages without business or audit writes", async () => {
    const before = (await counts()).rows;
    const responses = await Promise.all(paths().map((path) => request(path)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const search = usTraceSearchPageSchema.parse(await responses[0]!.json());
    expect(search.items.length).toBeGreaterThan(0);
    const card = usLotCardSchema.parse(await responses[1]!.json());
    expect(card.currentCteCount).toBeGreaterThan(0);
    const evidencePage = usLotCardEvidencePageSchema.parse(await responses[2]!.json());
    expect(evidencePage.items.map((item) => item.eventId)).toContain(c.revision.id);
    const empty = await request("/traceability/search?tlc=NOT-IN-SYNTHETIC-DATA");
    expect(empty.status).toBe(200);
    expect(usTraceSearchPageSchema.parse(await empty.json()).items).toEqual([]);
    const list = await request(
      "/traceability/search?tlcList=" +
        encodeURIComponent(JSON.stringify(["NOT-IN-SYNTHETIC-DATA"])),
    );
    expect(list.status).toBe(200);
    expect(usTraceSearchPageSchema.parse(await list.json()).appliedFilters.tlcList).toEqual([
      "NOT-IN-SYNTHETIC-DATA",
    ]);
    const first = usTraceSearchPageSchema.parse(
      await (await request("/traceability/search?limit=1")).json(),
    );
    expect(first.nextCursor).not.toBeNull();
    const next = await request("/traceability/search?limit=1&cursor=" + first.nextCursor);
    expect(next.status).toBe(200);
    expect(usTraceSearchPageSchema.parse(await next.json()).items[0]?.lotId).not.toBe(
      first.items[0]?.lotId,
    );
    const inputId = c.origin.snapshot.items[0]!.lotId;
    const evidencePath = `/traceability/lots/${inputId}/card/evidence?limit=1`;
    const firstEvidence = usLotCardEvidencePageSchema.parse(
      await (await request(evidencePath)).json(),
    );
    expect(firstEvidence.items.map((item) => item.eventId)).toEqual([c.origin.id]);
    expect(firstEvidence.nextCursor).not.toBeNull();
    const secondEvidence = await request(evidencePath + "&cursor=" + firstEvidence.nextCursor);
    expect(secondEvidence.status).toBe(200);
    expect(
      usLotCardEvidencePageSchema
        .parse(await secondEvidence.json())
        .items.map((item) => item.eventId),
    ).toEqual([c.revision.id]);
    expect((await counts()).rows).toEqual(before);
  });

  it("requires a verified session and reloads revoked membership on every read", async () => {
    for (const path of paths()) {
      const response = await request(path, "GET", undefined, { cookie: "" });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    await f.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, c.tenant));
    try {
      for (const path of paths()) {
        const response = await request(path);
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    } finally {
      await f.db
        .update(schema.member)
        .set({ role: "owner" })
        .where(eq(schema.member.organizationId, c.tenant));
    }
  });

  it("transports an approved 8 KiB JSON TLC list after URL expansion", async () => {
    const list = Array.from({ length: 40 }, (_, index) => "界".repeat(60) + index);
    const json = JSON.stringify(list);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(8192);
    const path = "/traceability/search?tlcList=" + encodeURIComponent(json);
    expect(Buffer.byteLength(path)).toBeGreaterThan(16 * 1024);
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = usTraceSearchPageSchema.parse(await response.json());
    expect(page.items).toEqual([]);
    expect(page.appliedFilters.tlcList).toEqual(list);
    const overflow = JSON.stringify(
      Array.from({ length: 50 }, (_, index) => "界".repeat(60) + index),
    );
    expect(Buffer.byteLength(overflow)).toBeGreaterThan(8192);
    const invalid = await request("/traceability/search?tlcList=" + encodeURIComponent(overflow));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    const maximumList = Array.from({ length: 44 }, (_, index) => "界".repeat(60) + index);
    maximumList[43] += "界".repeat(20) + "A";
    expect(Buffer.byteLength(JSON.stringify(maximumList))).toBe(8192);
    const maximumQuery = new URLSearchParams({
      q: "界".repeat(200),
      productText: "界".repeat(200),
      tlc: "𐐀".repeat(120),
      tlcFrom: "𐐀".repeat(120),
      tlcTo: "𐐀".repeat(120),
      tlcList: JSON.stringify(maximumList),
      documentType: "界".repeat(2000),
      documentNumber: "界".repeat(128),
      sourceReferenceValue: "https://example.test/" + "界".repeat(334) + "A",
      lotId: randomUUID(),
      productId: c.product,
      sourceLocationId: randomUUID(),
      locationId: randomUUID(),
      eventType: "transformation",
      eventDateFrom: "2026-01-01",
      eventDateTo: "2026-12-31",
      status: "active",
      limit: "100",
    });
    const maximumPath = "/traceability/search?" + maximumQuery.toString();
    expect(Buffer.byteLength(maximumPath)).toBeGreaterThan(50 * 1024);
    const expandedCookie =
      (client.headers().get("cookie") ?? "") + "; size_probe=" + "x".repeat(4096);
    const maximumResponse = await request(maximumPath, "GET", undefined, {
      cookie: expandedCookie,
    });
    expect(maximumResponse.status).toBe(200);
    expect(maximumResponse.headers.get("cache-control")).toBe("no-store");
    expect(
      usTraceSearchPageSchema.parse(await maximumResponse.json()).appliedFilters.tlcList,
    ).toEqual(maximumList);
  });

  it("hides foreign and missing cards/evidence with identical 404", async () => {
    const foreign = await seedShippingLifecycle(f.db);
    for (const suffix of ["", "/evidence"]) {
      const missing = await request(`/traceability/lots/${randomUUID()}/card${suffix}`);
      const other = await request(`/traceability/lots/${foreign.lot}/card${suffix}`);
      expect(missing.status).toBe(404);
      expect(other.status).toBe(404);
      expect(await missing.json()).toEqual(await other.json());
      expect(other.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rejects duplicate, malformed and untrusted query fields without writes", async () => {
    const invalid = [
      "/traceability/search?limit=1&limit=2",
      "/traceability/search?limit=1&%6cimit=2",
      "/traceability/search?tenantId=x",
      "/traceability/search?actorUserId=x",
      "/traceability/search?limit[]=1",
      "/traceability/search?limit=101",
      "/traceability/search?tlcList=not-json",
      "/traceability/search?tlcList=%5B%22A%22%2C%22A%22%5D",
      "/traceability/search?cursor=not-a-cursor",
      "/traceability/search?lotId=not-a-uuid",
      cardPath() + "?tenantId=x",
      cardPath() + "?limit=1",
      cardPath() + "/evidence?limit=51",
      cardPath() + "/evidence?limit=1&limit=2",
      cardPath() + "/evidence?cursor=not-a-cursor",
      cardPath() + "/evidence?tenantId=x",
      "/traceability/lots/not-a-uuid/card",
      "/traceability/lots/not-a-uuid/card/evidence",
    ];
    const before = (await counts()).rows;
    for (const path of invalid) {
      const response = await request(path);
      expect(response.status, path).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await counts()).rows).toEqual(before);
  });

  it("documents only the exact GET routes and rejects writes, suffixes and RU routes", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths;
    for (const path of [
      "/traceability/search",
      "/traceability/lots/{id}/card",
      "/traceability/lots/{id}/card/evidence",
    ]) {
      expect(Object.keys(document[path] ?? {})).toEqual(["get"]);
      expect(Object.keys(document[path]?.get?.responses ?? {}).sort()).toEqual([
        "200",
        "400",
        "401",
        "403",
        "404",
        "503",
      ]);
    }
    for (const path of paths()) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"])
        expect((await request(path, method, {})).status).toBe(404);
      expect((await request(path + "/extra")).status).toBe(404);
    }
    for (const path of ["/api/boxes", "/api/auth/get-session"])
      expect((await request(path)).status).toBe(404);
  });

  it("returns safe 503 for corrupt frozen evidence without writes", async () => {
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE transformation_event_roots SET event_number='TRN-26-9999' WHERE id=${c.original.id}`,
      );
    });
    try {
      const before = (await counts()).rows;
      for (const path of paths()) {
        const response = await request(path);
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      }
      expect((await counts()).rows).toEqual(before);
    } finally {
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE transformation_event_roots SET event_number=${c.original.eventNumber} WHERE id=${c.original.id}`,
        );
      });
    }
  });

  it("returns safe 503 after a real statement timeout without writes", async () => {
    const transaction = operations.transformationTransaction;
    vi.spyOn(operations, "transformationTransaction").mockImplementation((db, run) =>
      transaction(db, async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='1ms'`);
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
        return run(tx);
      }),
    );
    const before = (await counts()).rows;
    for (const path of paths()) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "us_database_unavailable" });
    }
    expect((await counts()).rows).toEqual(before);
  });
});
