import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { hashPassword } from "better-auth/crypto";
import { createDb, schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { listenOnLoopback } from "./support/listen-loopback";
import { z } from "zod";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-http-password-42!";
const profile = { code: "US_FSMA204_PROCESSOR", timeZone: "America/Chicago" };

// Node Fetch replaces Host with the socket destination. Use HTTP directly so an
// ephemeral listener can exercise the exact configured origin and cookie scope.
function httpFetch(
  url: string,
  init: { method?: string; headers?: Headers | Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestHeaders = new Headers(init.headers);
    // Node does not default DELETE to chunked framing. Without a length,
    // Express sees no body and the test stops at media-type validation.
    if (init.body !== undefined) {
      requestHeaders.set("content-length", String(Buffer.byteLength(init.body)));
    }
    const request = httpRequest(
      url,
      { method: init.method ?? "GET", headers: Object.fromEntries(requestHeaders) },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(key, item);
            else if (value !== undefined) headers.set(key, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(init.body);
  });
}

describe.skipIf(!base)("US HTTP auth and profile composition", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  let serverUrl: string;
  let scratchUrl: string;
  let userId: string;
  let tenantId: string;
  let email: string;
  let hash: string;
  let clock = Date.now();
  let client: UsAuthTestClient;
  const env = () => parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));

  async function transport(input: Request): Promise<Response> {
    const headers = new Headers(input.headers);
    headers.set("host", "localhost:3100");
    return httpFetch(`${serverUrl}${new URL(input.url).pathname}`, {
      method: input.method,
      headers,
      ...(input.method === "GET" ? {} : { body: await input.text() }),
    });
  }
  function profileRequest(method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    const headers = client.headers();
    headers.set("host", "localhost:3100");
    headers.set("origin", "http://localhost:5174");
    if (body !== undefined) headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return httpFetch(`${serverUrl}/traceability/profile`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login() {
    expect((await client.request("/sign-in/email", { email, password })).status).toBe(200);
    const enrollment = await client.request("/two-factor/enable", { password });
    expect(enrollment.status).toBe(200);
    const data: unknown = await enrollment.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("totpURI" in data) ||
      typeof data.totpURI !== "string"
    )
      throw new Error("Invalid synthetic enrollment");
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
    scratchUrl = url.toString();
    app = await createUsDevelopmentApplication(env(), (_url, options) => {
      connection = createDb(scratchUrl, options);
      return connection;
    });
    await app.init();
    await listenOnLoopback(app);
    const address: AddressInfo = app.getHttpServer().address();
    serverUrl = `http://127.0.0.1:${address.port}`;
    hash = await hashPassword(password);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 60000);
  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    clock += 60000;
    vi.setSystemTime(clock);
    userId = randomUUID();
    tenantId = randomUUID();
    email = `${userId}@example.test`;
    await fixture.db
      .insert(schema.user)
      .values({ id: userId, name: "Synthetic HTTP owner", email });
    await fixture.db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: hash,
    });
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US HTTP", slug: tenantId, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      userId,
      organizationId: tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    client = new UsAuthTestClient(transport);
  });

  it("rejects anonymous and password-only profile access", async () => {
    expect((await profileRequest()).status).toBe(401);
    expect((await client.request("/sign-in/email", { email, password })).status).toBe(200);
    expect((await profileRequest()).status).toBe(403);
    expect((await profileRequest("PUT", profile)).status).toBe(403);
  });

  it("connects the browser client to real US HTTP through password, MFA, organization and profile", async () => {
    // Runtime import keeps the API compiler inside its package root. The small
    // test-only port deliberately returns unknown; assertions validate real data.
    type BrowserTestPort = Record<
      | "session"
      | "signIn"
      | "organizations"
      | "enroll"
      | "verifyTotp"
      | "selectOrganization"
      | "profile"
      | "provisionProfile"
      | "signOut"
      | "verifyBackupCode",
      (input?: unknown) => Promise<unknown>
    >;
    const { createUsBrowserClient } = await vi.importActual<{
      createUsBrowserClient: (send: typeof fetch) => BrowserTestPort;
    }>("../../admin/src/us/client.ts");
    // Test-only same-origin proxy/cookie jar. A browser transport is not allowed
    // to set Cookie/Host itself; actual browser/proxy validation is a later gate.
    const cookies = new Map<string, string>();
    const send: typeof fetch = async (input, init) => {
      if (typeof input !== "string" || !input.startsWith("/api/us"))
        throw new Error("Unexpected browser route");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost:3100");
      headers.set("origin", "http://localhost:5174");
      headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      const path = input.startsWith("/api/us/") ? input.slice("/api/us".length) : input;
      const response = await httpFetch(`${serverUrl}${path}`, {
        method: init?.method ?? "GET",
        headers,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0] ?? "";
        const split = pair.indexOf("=");
        const key = pair.slice(0, split);
        const value = pair.slice(split + 1);
        if (value) cookies.set(key, value);
        else cookies.delete(key);
      }
      return response;
    };
    const browser = createUsBrowserClient(send);
    expect(await browser.session()).toBeNull();
    expect(await browser.signIn({ email, password })).toEqual({ step: "password_session" });
    await expect(browser.organizations()).rejects.toMatchObject({ code: "forbidden" });
    const enrollment = z
      .object({ totpURI: z.string(), backupCodes: z.array(z.string()).min(1) })
      .parse(await browser.enroll({ password }));
    await browser.verifyTotp({ code: currentUsTotp(enrollment.totpURI) });
    expect(await browser.organizations()).toEqual([
      { id: tenantId, name: "Synthetic US HTTP", slug: tenantId },
    ]);
    await browser.selectOrganization({ organizationId: tenantId });
    expect(await browser.session()).toMatchObject({ activeOrganizationId: tenantId });
    await expect(browser.profile()).rejects.toMatchObject({ code: "profile_not_provisioned" });
    const created = await browser.provisionProfile(profile);
    expect(created).toMatchObject({
      ...profile,
      retentionYears: 5,
      baselineVersion: "US-REG-2026-09-03",
    });
    expect(await browser.profile()).toEqual(created);
    await browser.signOut();
    expect(await browser.session()).toBeNull();
    expect(await browser.signIn({ email, password })).toEqual({ step: "mfa_required" });
    await expect(browser.profile()).rejects.toMatchObject({ code: "session_required" });
    await browser.verifyBackupCode({ code: enrollment.backupCodes[0] });
    await browser.selectOrganization({ organizationId: tenantId });
    expect(await browser.profile()).toEqual(created);
  });

  it("runs password, MFA and initial profile provisioning over real HTTP with exact audit", async () => {
    await login();
    const missing = await profileRequest();
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "traceability_profile_not_provisioned" });
    const response = await profileRequest("PUT", profile, {
      "x-request-id": "untrusted-client-request-id",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId).not.toBe("untrusted-client-request-id");
    const stored: unknown = await response.json();
    expect(stored).toMatchObject({
      ...profile,
      retentionYears: 5,
      baselineVersion: "US-REG-2026-09-03",
      effectiveAt: expect.any(String),
    });
    const read = await profileRequest();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(stored);
    const retry = await profileRequest("PUT", profile);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(stored);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId)),
    ).toEqual([
      {
        id: expect.any(String),
        organizationId: tenantId,
        actorUserId: userId,
        action: "traceability.profile.updated",
        outcome: "success",
        targetType: "tenant",
        targetId: tenantId,
        before: null,
        after: stored,
        requestId,
        createdAt: expect.any(Date),
      },
    ]);
    expect((await profileRequest("PUT", { ...profile, timeZone: "America/Denver" })).status).toBe(
      409,
    );
  });

  it.each(["tenantId", "actorUserId", "baselineVersion"])(
    "rejects client-owned %s without writing a profile",
    async (field) => {
      await login();
      expect((await profileRequest("PUT", { ...profile, [field]: "forged" })).status).toBe(400);
      expect(
        await fixture.db
          .select()
          .from(schema.traceabilityProfiles)
          .where(eq(schema.traceabilityProfiles.tenantId, tenantId)),
      ).toEqual([]);
    },
  );

  it("reloads role and membership for every profile request", async () => {
    await login();
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(eq(schema.member.userId, userId));
    expect((await profileRequest("PUT", profile)).status).toBe(403);
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    expect((await profileRequest()).status).toBe(403);
  });

  it("allows an MFA-verified US auditor to read but never provision a profile", async () => {
    await login();
    expect((await profileRequest("PUT", profile)).status).toBe(200);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, userId));
    const response = await profileRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(profile);
    expect((await profileRequest("PUT", profile)).status).toBe(403);
    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, userId));
    expect((await profileRequest()).status).toBe(403);
  });

  it("rejects selecting a tenant outside the current membership", async () => {
    await login();
    const other = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: other, name: "Other synthetic tenant", slug: other, createdAt: new Date() });
    expect(
      (await client.request("/organization/set-active", { organizationId: other })).status,
    ).toBe(403);
    // Better Auth clears active organization after a denied selection. No
    // business write is allowed until an authorized organization is reselected.
    expect((await profileRequest("PUT", profile)).status).toBe(403);
    expect(
      (await client.request("/organization/set-active", { organizationId: tenantId })).status,
    ).toBe(200);
    expect((await profileRequest("PUT", profile)).status).toBe(200);
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityProfiles)
        .where(eq(schema.traceabilityProfiles.tenantId, other)),
    ).toEqual([]);
  });

  it("denies untrusted origins and hosts before business writes", async () => {
    await login();
    expect((await profileRequest("PUT", profile, { origin: "http://localhost:5173" })).status).toBe(
      403,
    );
    expect((await profileRequest("PUT", profile, { host: "untrusted.example" })).status).toBe(403);
    expect((await profileRequest("PUT", profile, { origin: "" })).status).toBe(403);
  });

  it("ignores spoofed forwarding headers without changing the auth origin", async () => {
    const response = await httpFetch(`${serverUrl}/api/us-auth/get-session`, {
      headers: {
        host: "localhost:3100",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "untrusted.example",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("applies the HTTP boundary to case-insensitive and trailing-slash profile routes", async () => {
    for (const path of ["/Traceability/Profile", "/traceability/profile/"]) {
      const response = await httpFetch(`${serverUrl}${path}`, {
        headers: { host: "untrusted.example" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "us_host_required" });
    }
  });

  it.each([
    "/sign-up/email",
    "/organization/create",
    "/organization/delete",
    "/delete-user",
    "/two-factor/disable",
    "/request-password-reset",
  ])("does not expose the auth plugin route %s", async (path) => {
    expect((await client.request(path, {})).status).toBe(404);
  });

  it("does not expose profile deletion even to an authenticated owner", async () => {
    await login();
    expect((await profileRequest("DELETE", {})).status).toBe(404);
    expect(
      await fixture.db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, tenantId)),
    ).toEqual([{ id: tenantId }]);
  });

  it("requires JSON for profile mutations", async () => {
    const response = await httpFetch(`${serverUrl}/traceability/profile`, {
      method: "PUT",
      headers: {
        host: "localhost:3100",
        origin: "http://localhost:5174",
        "content-type": "text/plain",
      },
      body: "not-json",
    });
    expect(response.status).toBe(415);
  });

  it("rejects oversized and malformed JSON without leaking the body", async () => {
    const headers = {
      host: "localhost:3100",
      origin: "http://localhost:5174",
      "content-type": "application/json",
    };
    const oversized = await httpFetch(`${serverUrl}/api/us-auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "x".repeat(17000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain("xxx");
    const malformed = await httpFetch(`${serverUrl}/traceability/profile`, {
      method: "PUT",
      headers,
      body: "{invalid",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("{invalid");
  });

  it("fails closed on an incomplete schema without affecting process liveness", async () => {
    await fixture.pool.query(
      "ALTER TABLE us_session_assurances RENAME TO us_session_assurances_temporarily_missing",
    );
    try {
      const response = await client.request("/sign-in/email", { email, password });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "us_database_unavailable" });
      expect((await fetch(`${serverUrl}/health/live`)).status).toBe(200);
    } finally {
      await fixture.pool.query(
        "ALTER TABLE us_session_assurances_temporarily_missing RENAME TO us_session_assurances",
      );
    }
  });

  it("redacts auth failures after preflight, including credential-bearing session queries", async () => {
    expect((await client.request("/sign-in/email", { email, password })).status).toBe(200);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const query = vi.spyOn(connection.pool, "query");
    try {
      for (const [path, body] of [
        ["/get-session", undefined],
        ["/sign-in/email", { email, password }],
      ] as const) {
        // Preflight succeeds; the actual auth operation then loses its database.
        query
          .mockRejectedValue(new Error("synthetic_connection_failure"))
          .mockResolvedValueOnce(undefined);
        const response = await client.request(path, body);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "us_database_unavailable" });
      }
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
      expect(logs).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      errors.mockRestore();
      warnings.mockRestore();
      logs.mockRestore();
    }
  });

  it("closes its owned pool with the application", async () => {
    const owned = createDb(scratchUrl);
    const other = await createUsDevelopmentApplication(env(), () => owned);
    await other.init();
    await other.close();
    await expect(owned.pool.query("SELECT 1")).rejects.toThrow(
      "Cannot use a pool after calling end",
    );
    // Closing a sibling application must not close this application's connection.
    expect((await connection.pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
  });

  it("cancels work on the database server and returns a rolled-back connection after timeout", async () => {
    expect((await connection.pool.query("SHOW statement_timeout")).rows).toEqual([
      { statement_timeout: "5s" },
    ]);
    let backendPid = 0;
    await expect(
      connection.db.transaction(
        async (tx) => {
          const identity = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          backendPid = identity.rows[0]?.pid ?? 0;
          await tx.execute(sql`SET LOCAL statement_timeout = '50ms'`);
          await tx.execute(sql`SELECT pg_sleep(0.2)`);
        },
        { accessMode: "read only" },
      ),
    ).rejects.toThrow();
    expect(backendPid).toBeGreaterThan(0);
    const state = await fixture.pool.query(
      "SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1",
      [backendPid],
    );
    expect(state.rows).toEqual([{ state: "idle", xact_start: null }]);
    expect((await connection.pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
  });
});
