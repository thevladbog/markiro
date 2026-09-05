import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsAuth, handleUsAuth } from "../src/modules/traceability/auth/us-auth";
import { resolveUsPrincipal } from "../src/modules/traceability/auth/us-principal";

const url = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-US-password-42!";

describe.skipIf(!url)("US session and MFA boundary on isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let auth: ReturnType<typeof createUsAuth>;
  let client: UsAuthTestClient;
  let userId: string;
  let tenantId: string;
  let email: string;
  let passwordHash: string;
  let clock = Date.now();

  const newClient = () => new UsAuthTestClient((request) => handleUsAuth(auth, request));
  const principal = (target = client) => resolveUsPrincipal(fixture.db, auth, target.headers());
  const signIn = (target = client) => target.request("/sign-in/email", { email, password });
  async function selectOrganization(target = client) {
    expect(
      (await target.request("/organization/set-active", { organizationId: tenantId })).status,
    ).toBe(200);
  }
  async function enroll() {
    expect((await signIn()).status).toBe(200);
    const response = await client.request("/two-factor/enable", { password });
    expect(response.status).toBe(200);
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("totpURI" in data) ||
      typeof data.totpURI !== "string" ||
      !("backupCodes" in data) ||
      !Array.isArray(data.backupCodes)
    )
      throw new Error("Invalid enrollment response");
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(200);
    await selectOrganization();
    return { uri: data.totpURI, backupCode: String(data.backupCodes[0]) };
  }

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url);
    auth = createUsAuth(fixture.db, {
      secret: "synthetic-us-session-secret-42-characters-long",
      baseURL: "http://localhost:3100",
      trustedOrigins: ["http://localhost:5174"],
    });
    passwordHash = await hashPassword(password);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 60000);
  afterAll(async () => {
    vi.useRealTimers();
    await fixture?.close();
  });
  beforeEach(async () => {
    clock += 60000;
    vi.setSystemTime(clock);
    userId = randomUUID();
    tenantId = randomUUID();
    email = `${userId}@example.test`;
    await fixture.db.insert(schema.user).values({ id: userId, name: "Synthetic US owner", email });
    await fixture.db.insert(schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: passwordHash,
    });
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US", slug: tenantId, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      userId,
      organizationId: tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    client = newClient();
  });

  it("migrates existing identities with MFA disabled and rejects password-only access", async () => {
    const [identity] = await fixture.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(identity?.twoFactorEnabled).toBe(false);
    await expect(principal()).rejects.toMatchObject({ status: 401 });
    const response = await signIn();
    expect(response.status).toBe(200);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith("markiro-us.session_token=") &&
            cookie.includes("HttpOnly") &&
            cookie.includes("SameSite=Lax"),
        ),
    ).toBe(true);
    expect((await client.request("/organization/list")).status).toBe(403);
    expect(
      (await client.request("/organization/set-active", { organizationId: tenantId })).status,
    ).toBe(403);
    await expect(principal()).rejects.toMatchObject({ status: 403 });
  });

  it("authorizes the enrolled session but never upgrades another password-only session", async () => {
    const old = newClient();
    await signIn(old);
    const active = await auth.api.getSession({ headers: old.headers() });
    if (!active) throw new Error("Missing synthetic old session");
    await fixture.db
      .update(schema.session)
      .set({ activeOrganizationId: tenantId })
      .where(eq(schema.session.id, active.session.id));
    await enroll();
    expect(await principal()).toMatchObject({ userId, tenantId, sessionId: expect.any(String) });
    await expect(principal(old)).rejects.toMatchObject({ status: 403 });
    expect((await old.request("/two-factor/enable", { password })).status).toBe(403);
  });

  it("requires a fresh TOTP challenge on the next password login", async () => {
    const { uri } = await enroll();
    const next = newClient();
    const response = await signIn(next);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    await expect(principal(next)).rejects.toMatchObject({ status: 401 });
    expect((await next.request("/two-factor/verify-totp", { code: "invalid" })).status).toBe(401);
    await expect(principal(next)).rejects.toMatchObject({ status: 401 });
    expect(
      (await next.request("/two-factor/verify-totp", { code: currentUsTotp(uri) })).status,
    ).toBe(200);
    await selectOrganization(next);
    expect(await principal(next)).toMatchObject({ userId, tenantId });
  });

  it("requires old password sessions to sign in again rather than guessing MFA", async () => {
    const old = newClient();
    await signIn(old);
    const { uri } = await enroll();
    expect(
      (await old.request("/two-factor/verify-totp", { code: currentUsTotp(uri) })).status,
    ).toBe(403);
    await expect(principal(old)).rejects.toMatchObject({ status: 403 });
  });

  it("locks pending enrollment after ten failures even across request-rate windows", async () => {
    await signIn();
    const response = await client.request("/two-factor/enable", { password });
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("totpURI" in data) ||
      typeof data.totpURI !== "string"
    )
      throw new Error("Missing enrollment");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      vi.setSystemTime(Date.now() + 31000);
      expect((await client.request("/two-factor/verify-totp", { code: "invalid" })).status).toBe(
        401,
      );
    }
    vi.setSystemTime(Date.now() + 31000);
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(429);
    await expect(principal()).rejects.toMatchObject({ status: 403 });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(
      (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
        .status,
    ).toBe(200);
    await selectOrganization();
    expect(await principal()).toMatchObject({ userId, tenantId });
    const [factor] = await fixture.db
      .select({
        failed: schema.usTwoFactors.failedVerificationCount,
        lockedUntil: schema.usTwoFactors.lockedUntil,
      })
      .from(schema.usTwoFactors)
      .where(eq(schema.usTwoFactors.userId, userId));
    expect(factor).toEqual({ failed: 0, lockedUntil: null });
    clock = Date.now();
  });

  it("rejects trusted-device bypass and still requires the next login challenge", async () => {
    const { uri } = await enroll();
    const next = newClient();
    await signIn(next);
    expect(
      (
        await next.request("/two-factor/verify-totp", {
          code: currentUsTotp(uri),
          trustDevice: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await next.request("/two-factor/verify-backup-code", {
          code: "synthetic-unused",
          disableSession: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await next.request("/two-factor/verify-totp", { code: currentUsTotp(uri) })).status,
    ).toBe(200);
    expect(next.headers().get("cookie")).not.toContain("trust_device");
    const last = newClient();
    expect(await (await signIn(last)).json()).toMatchObject({ twoFactorRedirect: true });
  });

  it("enforces the request limiter in local development", async () => {
    const responses: Response[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      responses.push(
        await client.request("/sign-in/email", { email, password: "incorrect-synthetic-password" }),
      );
    expect(responses.some((response) => response.status === 429)).toBe(true);
  });

  it("never replaces a pending factor when enrollment is retried", async () => {
    await signIn();
    expect((await client.request("/two-factor/enable", { password })).status).toBe(200);
    const [before] = await fixture.db
      .select({ id: schema.usTwoFactors.id })
      .from(schema.usTwoFactors)
      .where(eq(schema.usTwoFactors.userId, userId));
    expect((await client.request("/two-factor/enable", { password })).status).toBe(409);
    expect(
      await fixture.db
        .select({ id: schema.usTwoFactors.id })
        .from(schema.usTwoFactors)
        .where(eq(schema.usTwoFactors.userId, userId)),
    ).toEqual([before]);
  });

  it("creates exactly one factor during concurrent enrollment without replacing it", async () => {
    await signIn();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => client.request("/two-factor/enable", { password })),
    );
    // The plugin's request limiter admits three concurrent enable requests;
    // the remaining two admitted requests conflict without replacing the factor.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 429]);
  });

  it("accepts a one-use backup code and denies its reuse", async () => {
    const { backupCode } = await enroll();
    const next = newClient();
    await signIn(next);
    expect(
      (await next.request("/two-factor/verify-backup-code", { code: backupCode })).status,
    ).toBe(200);
    await selectOrganization(next);
    expect(await principal(next)).toMatchObject({ userId, tenantId });
    const replay = newClient();
    await signIn(replay);
    expect(
      (await replay.request("/two-factor/verify-backup-code", { code: backupCode })).status,
    ).toBe(401);
    await expect(principal(replay)).rejects.toMatchObject({ status: 401 });
  });

  it("reloads membership and rejects a different tenant supplied during selection", async () => {
    await enroll();
    expect(
      (await client.request("/organization/set-active", { organizationId: randomUUID() })).status,
    ).toBe(403);
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, userId));
    await expect(principal()).rejects.toMatchObject({ status: 403 });
  });

  it("revokes access immediately and cascades assurance when the session is deleted", async () => {
    await enroll();
    const current = await principal();
    await fixture.db.delete(schema.session).where(eq(schema.session.id, current.sessionId));
    await expect(principal()).rejects.toMatchObject({ status: 401 });
    expect(
      await fixture.db
        .select()
        .from(schema.usSessionAssurances)
        .where(eq(schema.usSessionAssurances.sessionId, current.sessionId)),
    ).toEqual([]);
  });

  it("invalidates assurance when its factor is removed", async () => {
    await enroll();
    const current = await principal();
    await fixture.db.delete(schema.usTwoFactors).where(eq(schema.usTwoFactors.userId, userId));
    await expect(principal()).rejects.toMatchObject({ status: 403 });
    expect(
      await fixture.db
        .select()
        .from(schema.usSessionAssurances)
        .where(eq(schema.usSessionAssurances.sessionId, current.sessionId)),
    ).toEqual([]);
  });

  it("does not recognize a cookie under the RU namespace", async () => {
    await enroll();
    const headers = client.headers();
    headers.set("cookie", (headers.get("cookie") ?? "").replaceAll("markiro-us.", "better-auth."));
    await expect(resolveUsPrincipal(fixture.db, auth, headers)).rejects.toMatchObject({
      status: 401,
    });
  });

  it.each([null, "http://localhost:5173", "https://untrusted.example"])(
    "denies mutation from origin %s even in tests",
    async (origin) => {
      expect((await client.request("/sign-in/email", { email, password }, origin)).status).toBe(
        403,
      );
    },
  );

  it.each([
    "/sign-up/email",
    "/organization/create",
    "/api-key/create",
    "/two-factor/disable",
    "/two-factor/view-backup-codes",
  ])("does not expose %s", async (path) => {
    expect((await client.request(path, { email, password })).status).toBe(404);
  });

  it("rejects a wrong password without creating a session", async () => {
    expect(
      (await client.request("/sign-in/email", { email, password: "incorrect-synthetic-password" }))
        .status,
    ).toBe(401);
    await expect(principal()).rejects.toMatchObject({ status: 401 });
  });

  it.each(["", "short"])(
    "requires an explicit independent secret instead of environment fallback",
    (secret) => {
      expect(() =>
        createUsAuth(fixture.db, {
          secret,
          baseURL: "http://localhost:3100",
          trustedOrigins: ["http://localhost:5174"],
        }),
      ).toThrow("explicit secret");
    },
  );
});
