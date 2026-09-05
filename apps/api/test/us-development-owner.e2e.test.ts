import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import * as ownerModule from "../src/deployment/us-development-owner";
import { createUsAuth, handleUsAuth } from "../src/modules/traceability/auth/us-auth";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-local-owner-password-42!";

describe.skipIf(!base)("local US synthetic owner provisioning", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test database");
    fixture = await createUsProfileTestDatabase(base);
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.db.delete(schema.tenantAuditEvents);
    await fixture.db.delete(schema.organization);
    await fixture.db.delete(schema.user);
  });

  it("atomically creates a synthetic owner with a hashed credential, no MFA bypass and exact audit", async () => {
    const requestId = randomUUID();
    const store = new ownerModule.UsDevelopmentOwnerStore(fixture.db);
    const result = await store.provision(password, requestId);
    expect(result.status).toBe("created");
    expect(result.email).toBe("owner@us-development.example.test");
    const [user] = await fixture.db.select().from(schema.user);
    expect(user).toMatchObject({
      id: result.userId,
      email: result.email,
      emailVerified: false,
      twoFactorEnabled: false,
    });
    const [account] = await fixture.db.select().from(schema.account);
    expect(account?.password).not.toBe(password);
    expect(await verifyPassword({ hash: account?.password ?? "", password })).toBe(true);
    expect(await fixture.db.select().from(schema.member)).toMatchObject([
      { organizationId: result.tenantId, userId: result.userId, role: "owner" },
    ]);
    expect(await fixture.db.select().from(schema.session)).toEqual([]);
    expect(await fixture.db.select().from(schema.usSessionAssurances)).toEqual([]);
    expect(await fixture.db.select().from(schema.traceabilityProfiles)).toEqual([]);
    const [audit] = await fixture.db.select().from(schema.tenantAuditEvents);
    expect(audit).toMatchObject({
      organizationId: result.tenantId,
      actorUserId: result.userId,
      action: "us.development.owner.provisioned",
      outcome: "success",
      targetType: "tenant",
      targetId: result.tenantId,
      requestId,
      before: null,
      after: { synthetic: true, seedVersion: "us-development-owner-v1" },
    });
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("retries without resetting MFA or adding another credential, membership or audit", async () => {
    const store = new ownerModule.UsDevelopmentOwnerStore(fixture.db);
    const first = await store.provision(password, randomUUID());
    await fixture.db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, first.userId));
    expect(await store.provision(password, randomUUID())).toEqual({
      ...first,
      status: "already_exists",
    });
    expect(await fixture.db.select().from(schema.account)).toHaveLength(1);
    expect(await fixture.db.select().from(schema.member)).toHaveLength(1);
    expect(await fixture.db.select().from(schema.tenantAuditEvents)).toHaveLength(1);
    expect(
      await fixture.db.select({ enabled: schema.user.twoFactorEnabled }).from(schema.user),
    ).toEqual([{ enabled: true }]);
  });

  it("serializes concurrent creation to one owner", async () => {
    const store = new ownerModule.UsDevelopmentOwnerStore(fixture.db);
    const results = await Promise.all([
      store.provision(password, randomUUID()),
      store.provision(password, randomUUID()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_exists", "created"]);
    expect(results[0]?.tenantId).toBe(results[1]?.tenantId);
    expect(await fixture.db.select().from(schema.user)).toHaveLength(1);
    expect(await fixture.db.select().from(schema.tenantAuditEvents)).toHaveLength(1);
  });

  it("creates credentials accepted by US auth while preserving the mandatory MFA boundary", async () => {
    const result = await new ownerModule.UsDevelopmentOwnerStore(fixture.db).provision(
      password,
      randomUUID(),
    );
    const auth = createUsAuth(fixture.db, {
      secret: "synthetic-local-owner-auth-secret-long-enough",
      baseURL: "http://localhost:3100",
      trustedOrigins: ["http://localhost:5174"],
    });
    const client = new UsAuthTestClient((request) => handleUsAuth(auth, request));
    expect((await client.request("/sign-in/email", { email: result.email, password })).status).toBe(
      200,
    );
    expect(
      (await client.request("/organization/set-active", { organizationId: result.tenantId }))
        .status,
    ).toBe(403);
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
      (await client.request("/organization/set-active", { organizationId: result.tenantId }))
        .status,
    ).toBe(200);
  });

  it("rolls back identities and membership when the audit insert fails", async () => {
    // Temporary constraint in this test's disposable database, not shared state.
    await fixture.db.execute(
      sql`ALTER TABLE tenant_audit_events ADD CONSTRAINT us_owner_test_audit_failure CHECK (action <> 'us.development.owner.provisioned')`,
    );
    try {
      await expect(
        new ownerModule.UsDevelopmentOwnerStore(fixture.db).provision(password, randomUUID()),
      ).rejects.toThrow();
      expect(await fixture.db.select().from(schema.user)).toEqual([]);
      expect(await fixture.db.select().from(schema.organization)).toEqual([]);
      expect(await fixture.db.select().from(schema.account)).toEqual([]);
      expect(await fixture.db.select().from(schema.member)).toEqual([]);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE tenant_audit_events DROP CONSTRAINT us_owner_test_audit_failure`,
      );
    }
  });

  it("never resets an existing password", async () => {
    const store = new ownerModule.UsDevelopmentOwnerStore(fixture.db);
    await store.provision(password, randomUUID());
    await expect(store.provision("Different-synthetic-password-42!", randomUUID())).rejects.toThrow(
      "us_development_owner_conflict",
    );
    const [account] = await fixture.db.select().from(schema.account);
    expect(await verifyPassword({ hash: account?.password ?? "", password })).toBe(true);
    expect(await fixture.db.select().from(schema.tenantAuditEvents)).toHaveLength(1);
  });

  it("refuses to take over a colliding existing email", async () => {
    const id = randomUUID();
    await fixture.db
      .insert(schema.user)
      .values({ id, name: "Existing user", email: "owner@us-development.example.test" });
    await expect(
      new ownerModule.UsDevelopmentOwnerStore(fixture.db).provision(password, randomUUID()),
    ).rejects.toThrow("us_development_owner_conflict");
    expect(await fixture.db.select({ id: schema.user.id }).from(schema.user)).toEqual([{ id }]);
    expect(await fixture.db.select().from(schema.organization)).toEqual([]);
    expect(await fixture.db.select().from(schema.account)).toEqual([]);
  });

  it("refuses to take over a colliding organization slug", async () => {
    const id = randomUUID();
    await fixture.db.insert(schema.organization).values({
      id,
      name: "Existing organization",
      slug: "us-development-demo",
      createdAt: new Date(),
    });
    await expect(
      new ownerModule.UsDevelopmentOwnerStore(fixture.db).provision(password, randomUUID()),
    ).rejects.toThrow("us_development_owner_conflict");
    expect(await fixture.db.select().from(schema.user)).toEqual([]);
    expect(
      await fixture.db.select({ id: schema.organization.id }).from(schema.organization),
    ).toEqual([{ id }]);
  });

  it("does not restore revoked owner permissions on retry", async () => {
    const store = new ownerModule.UsDevelopmentOwnerStore(fixture.db);
    await store.provision(password, randomUUID());
    await fixture.db.update(schema.member).set({ role: "member" });
    await expect(store.provision(password, randomUUID())).rejects.toThrow(
      "us_development_owner_conflict",
    );
    expect(await fixture.db.select({ role: schema.member.role }).from(schema.member)).toEqual([
      { role: "member" },
    ]);
  });

  it.each(["", "short", "x".repeat(129)])(
    "rejects invalid password length without creating data",
    async (invalid) => {
      await expect(
        new ownerModule.UsDevelopmentOwnerStore(fixture.db).provision(invalid, randomUUID()),
      ).rejects.toThrow("us_development_password_invalid");
      expect(await fixture.db.select().from(schema.user)).toEqual([]);
      expect(await fixture.db.select().from(schema.organization)).toEqual([]);
    },
  );
});
