import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  UsDevelopmentViewerStore,
  type UsDevelopmentViewerContext,
} from "../src/deployment/us-development-viewer";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { UsProfileStore } from "../src/modules/traceability/profile/us-profile-store";
import { createUsAuth, handleUsAuth } from "../src/modules/traceability/auth/us-auth";
import { currentUsTotp, UsAuthTestClient } from "./support/us-auth-client";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const base = process.env.US_TEST_DATABASE_URL;
const password = "Synthetic-local-viewer-password-42!";
const email = "viewer@us-development.example.test";

// This is an actual owned-DB integration gate. An absent URL is an explicit skip,
// never acceptance evidence. The fixture creates/migrates/drops a random child.
describe.skipIf(!base)("reserved viewer in owned PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let context: UsDevelopmentViewerContext;
  let store: UsDevelopmentViewerStore;
  let ownedDatabaseName: string;

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test database");
    fixture = await createUsProfileTestDatabase(base);
    const identity = await fixture.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    ownedDatabaseName = identity.rows[0]?.name ?? "";
    if (!/^markiro_us_profile_[a-f0-9_]{36}$/.test(ownedDatabaseName))
      throw new Error("Invalid owned viewer database identity");
    console.info(`[viewer-owned-db] created and migrated ${ownedDatabaseName}`);
    store = new UsDevelopmentViewerStore(fixture.db);
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
    if (ownedDatabaseName)
      console.info(`[viewer-owned-db] normal DROP completed ${ownedDatabaseName}`);
  });
  beforeEach(async () => {
    await fixture.db.delete(schema.traceabilityProfiles);
    await fixture.db.delete(schema.orgProfiles);
    await fixture.db.delete(schema.tenantAuditEvents);
    await fixture.db.delete(schema.organization);
    await fixture.db.delete(schema.user);
    const owner = await new UsDevelopmentOwnerStore(fixture.db).provision(
      "Synthetic-local-owner-password-42!",
      randomUUID(),
    );
    context = { tenantId: owner.tenantId, originalOwnerId: owner.userId, requestId: randomUUID() };
    const profileSource = pathToFileURL(
      resolve(
        __dirname,
        "../../../tools/us-development/test/support/dataset-command-positive-fixture.mjs",
      ),
    ).href;
    const { datasetInstallationProfile } = (await import(profileSource)) as {
      datasetInstallationProfile(mode: "viewer"): unknown;
    };
    await new UsProfileStore(fixture.db).provision(
      context.tenantId,
      context.originalOwnerId,
      datasetInstallationProfile("viewer"),
      randomUUID(),
    );
  });

  async function snapshot() {
    // Exact rows, including timestamps and auth state: repairs and accidental
    // writes cannot hide behind aggregate counts or broad audit exclusions.
    // Hash secret-bearing rows so a failed comparison cannot print credentials,
    // session tokens or factor material into a test log.
    const accounts = await fixture.db.select().from(schema.account).orderBy(schema.account.id);
    const sessions = await fixture.db.select().from(schema.session).orderBy(schema.session.id);
    const factors = await fixture.db
      .select()
      .from(schema.usTwoFactors)
      .orderBy(schema.usTwoFactors.id);
    const digest = (row: unknown) => createHash("sha256").update(JSON.stringify(row)).digest("hex");
    return {
      users: await fixture.db.select().from(schema.user).orderBy(schema.user.id),
      organizations: await fixture.db
        .select()
        .from(schema.organization)
        .orderBy(schema.organization.id),
      members: await fixture.db.select().from(schema.member).orderBy(schema.member.id),
      accounts: accounts.map((row) => ({ id: row.id, userId: row.userId, digest: digest(row) })),
      audits: await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .orderBy(schema.tenantAuditEvents.id),
      profiles: await fixture.db.select().from(schema.traceabilityProfiles),
      orgProfiles: await fixture.db.select().from(schema.orgProfiles),
      sessions: sessions.map(digest),
      factors: factors.map(digest),
      assurances: await fixture.db.select().from(schema.usSessionAssurances),
    };
  }

  async function expectConflictNoWrites(chosenPassword = password, ctx = context) {
    const before = await snapshot();
    await expect(store.provision(ctx, chosenPassword)).rejects.toThrow(
      "us_development_viewer_conflict",
    );
    expect(await snapshot()).toEqual(before);
    await expect(store.verify(ctx, chosenPassword)).rejects.toThrow(
      "us_development_viewer_conflict",
    );
    expect(await snapshot()).toEqual(before);
  }

  it("creates exactly one auditor with an owner-attributed audit and Better Auth credential", async () => {
    const before = await snapshot();
    const result = await store.provision(context, password);
    expect(result).toEqual({
      status: "created",
      tenantId: context.tenantId,
      viewerUserId: expect.any(String),
      email,
      role: "traceability_auditor",
      synthetic: true,
      mfaRequired: true,
    });
    expect(result.viewerUserId).not.toBe(context.originalOwnerId);
    const [viewer] = await fixture.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, result.viewerUserId));
    expect(viewer).toEqual({
      id: result.viewerUserId,
      name: "Synthetic US development viewer",
      email,
      emailVerified: false,
      twoFactorEnabled: false,
      image: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const accounts = await fixture.db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, result.viewerUserId));
    expect(accounts.length).toBe(1);
    expect(
      accounts.map((row) => ({
        accountId: row.accountId,
        providerId: row.providerId,
        userId: row.userId,
      })),
    ).toEqual([
      { accountId: result.viewerUserId, providerId: "credential", userId: result.viewerUserId },
    ]);
    expect(await verifyPassword({ hash: accounts[0]?.password ?? "", password })).toBe(true);
    expect(
      await fixture.db
        .select()
        .from(schema.member)
        .where(eq(schema.member.userId, result.viewerUserId)),
    ).toEqual([
      {
        id: expect.any(String),
        organizationId: context.tenantId,
        userId: result.viewerUserId,
        role: "traceability_auditor",
        createdAt: expect.any(Date),
      },
    ]);
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.action, "us.development.viewer.provisioned"));
    expect(audits).toEqual([
      {
        id: expect.any(String),
        organizationId: context.tenantId,
        actorUserId: context.originalOwnerId,
        action: "us.development.viewer.provisioned",
        outcome: "success",
        targetType: "user",
        targetId: result.viewerUserId,
        requestId: context.requestId,
        before: null,
        after: {
          synthetic: true,
          seedVersion: "us-development-viewer-v1",
          tenantId: context.tenantId,
          originalOwnerId: context.originalOwnerId,
          viewerUserId: result.viewerUserId,
          email,
          role: "traceability_auditor",
        },
        createdAt: expect.any(Date),
      },
    ]);
    const after = await snapshot();
    expect(after.organizations).toEqual(before.organizations);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.orgProfiles).toEqual(before.orgProfiles);
    expect(after.users.filter((row) => row.id === context.originalOwnerId)).toEqual(before.users);
    expect(
      after.audits.filter((row) => row.action !== "us.development.viewer.provisioned"),
    ).toEqual(before.audits);
    expect(after.accounts.filter((row) => row.userId === context.originalOwnerId)).toEqual(
      before.accounts,
    );
    expect(after.members.filter((row) => row.userId === context.originalOwnerId)).toEqual(
      before.members,
    );
    expect(after.sessions).toEqual([]);
    expect(after.factors).toEqual([]);
    expect(after.assurances).toEqual([]);
    expect(JSON.stringify({ result, audits })).not.toContain(password);
    expect(JSON.stringify({ result, audits })).not.toContain(accounts[0]?.password);
  });

  it("never creates a missing viewer in verify mode", async () => {
    const before = await snapshot();
    await expect(store.verify(context, password)).rejects.toThrow("us_development_viewer_conflict");
    expect(await snapshot()).toEqual(before);
  });

  it("replays and verifies without writes after normal login/MFA/session evolution", async () => {
    const first = await store.provision(context, password);
    const auth = createUsAuth(fixture.db, {
      secret: "synthetic-viewer-auth-secret-long-enough",
      baseURL: "http://localhost:3100",
      trustedOrigins: ["http://localhost:5174"],
    });
    const client = new UsAuthTestClient((request) => handleUsAuth(auth, request));
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
      (await client.request("/organization/set-active", { organizationId: context.tenantId }))
        .status,
    ).toBe(200);
    await fixture.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, first.viewerUserId));
    const before = await snapshot();
    expect(before.factors).toHaveLength(1);
    expect(before.sessions.length).toBeGreaterThan(0);
    expect(before.assurances).toHaveLength(1);
    expect(await store.provision({ ...context, requestId: randomUUID() }, password)).toEqual({
      ...first,
      status: "already_exists",
    });
    expect(await store.verify({ ...context, requestId: randomUUID() }, password)).toEqual({
      ...first,
      status: "verified",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("serializes concurrent commands to one creator and exact replay", async () => {
    const results = await Promise.all([
      store.provision(context, password),
      store.provision({ ...context, requestId: randomUUID() }, password),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_exists", "created"]);
    expect(results[0]?.viewerUserId).toBe(results[1]?.viewerUserId);
    expect(
      await fixture.db.select().from(schema.user).where(eq(schema.user.email, email)),
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.action, "us.development.viewer.provisioned")),
    ).toHaveLength(1);
    const first = results[0];
    expect(await store.verify(context, password)).toEqual({ ...first, status: "verified" });
  });

  it("rolls back all viewer rows if the audit fails", async () => {
    const before = await snapshot();
    await fixture.db.execute(
      sql`ALTER TABLE tenant_audit_events ADD CONSTRAINT us_viewer_audit_failure CHECK (action <> 'us.development.viewer.provisioned')`,
    );
    try {
      await expect(store.provision(context, password)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE tenant_audit_events DROP CONSTRAINT us_viewer_audit_failure`,
      );
    }
  });

  it.each(["Existing person", "Synthetic US development viewer"])(
    "does not adopt colliding email/name %s",
    async (name) => {
      await fixture.db.insert(schema.user).values({ id: randomUUID(), name, email });
      await expectConflictNoWrites();
    },
  );

  it("rejects an orphan provisioning audit before fresh creation", async () => {
    await fixture.db.insert(schema.tenantAuditEvents).values({
      organizationId: context.tenantId,
      actorUserId: context.originalOwnerId,
      action: "us.development.viewer.provisioned",
      outcome: "success",
      targetType: "user",
      targetId: randomUUID(),
      before: null,
      after: null,
    });
    await expectConflictNoWrites();
  });

  it.each(["owner", "profile", "baseline", "retention", "timezone"])(
    "refuses fresh creation when the required %s is absent or wrong",
    async (change) => {
      switch (change) {
        case "owner":
          await fixture.db.delete(schema.user).where(eq(schema.user.id, context.originalOwnerId));
          break;
        case "profile":
          await fixture.db.delete(schema.traceabilityProfiles);
          break;
        case "baseline":
          await fixture.db.update(schema.traceabilityProfiles).set({ baselineVersion: "US-other" });
          break;
        case "retention":
          await fixture.db.update(schema.traceabilityProfiles).set({ retentionYears: 5 });
          break;
        case "timezone":
          await fixture.db.update(schema.orgProfiles).set({ timeZone: "Europe/Moscow" });
          break;
      }
      await expectConflictNoWrites();
    },
  );

  it.each([
    "duplicate audit",
    "missing audit",
    "foreign audit",
    "single foreign audit",
    "wrong actor",
    "wrong target",
    "wrong target type",
    "wrong outcome",
    "wrong before",
    "wrong after",
    "extra after field",
    "wrong seed",
    "wrong audit owner",
    "wrong audit tenant",
    "wrong audit viewer",
    "wrong audit email",
    "wrong audit role",
    "extra account",
    "extra credential",
    "wrong accountId",
    "wrong provider",
    "missing credential",
    "empty hash",
    "changed hash",
    "wrong password",
    "changed name",
    "changed email",
    "missing viewer",
    "missing member",
    "extra member",
    "foreign member",
    "comma role",
    "space role",
    "owner role",
    "QA role",
    "missing owner",
    "missing owner member",
    "missing profile",
    "missing timezone",
    "wrong profile",
    "wrong baseline",
    "wrong retention",
    "wrong timezone",
    "wrong context owner",
    "wrong context tenant",
  ])("refuses %s without repairing any rows", async (change) => {
    const viewer = await store.provision(context, password);
    const userWhere = eq(schema.user.id, viewer.viewerUserId);
    const accountWhere = eq(schema.account.userId, viewer.viewerUserId);
    const memberWhere = eq(schema.member.userId, viewer.viewerUserId);
    const auditWhere = eq(schema.tenantAuditEvents.action, "us.development.viewer.provisioned");
    const [audit] = await fixture.db.select().from(schema.tenantAuditEvents).where(auditWhere);
    if (!audit) throw new Error("Missing viewer audit fixture");
    switch (change) {
      case "duplicate audit":
        await fixture.db.insert(schema.tenantAuditEvents).values({ ...audit, id: randomUUID() });
        break;
      case "missing audit":
        await fixture.db.delete(schema.tenantAuditEvents).where(auditWhere);
        break;
      case "foreign audit":
      case "single foreign audit": {
        const foreignId = randomUUID();
        await fixture.db.insert(schema.organization).values({
          id: foreignId,
          name: "Synthetic foreign",
          slug: foreignId,
          createdAt: new Date(),
        });
        if (change === "single foreign audit") {
          await fixture.db
            .update(schema.tenantAuditEvents)
            .set({ organizationId: foreignId })
            .where(auditWhere);
        } else {
          await fixture.db
            .insert(schema.tenantAuditEvents)
            .values({ ...audit, id: randomUUID(), organizationId: foreignId });
        }
        break;
      }
      case "wrong actor":
        await fixture.db
          .update(schema.tenantAuditEvents)
          .set({ actorUserId: viewer.viewerUserId })
          .where(auditWhere);
        break;
      case "wrong target":
        await fixture.db
          .update(schema.tenantAuditEvents)
          .set({ targetId: context.originalOwnerId })
          .where(auditWhere);
        break;
      case "wrong target type":
        await fixture.db
          .update(schema.tenantAuditEvents)
          .set({ targetType: "tenant" })
          .where(auditWhere);
        break;
      case "wrong outcome":
        await fixture.db
          .update(schema.tenantAuditEvents)
          .set({ outcome: "failure" })
          .where(auditWhere);
        break;
      case "wrong before":
        await fixture.db.update(schema.tenantAuditEvents).set({ before: {} }).where(auditWhere);
        break;
      case "wrong after":
        await fixture.db.update(schema.tenantAuditEvents).set({ after: null }).where(auditWhere);
        break;
      case "extra after field":
      case "wrong seed":
      case "wrong audit owner":
      case "wrong audit tenant":
      case "wrong audit viewer":
      case "wrong audit email":
      case "wrong audit role": {
        const edits: Record<string, unknown> = {
          "extra after field": { extra: true },
          "wrong seed": { seedVersion: "other" },
          "wrong audit owner": { originalOwnerId: viewer.viewerUserId },
          "wrong audit tenant": { tenantId: randomUUID() },
          "wrong audit viewer": { viewerUserId: randomUUID() },
          "wrong audit email": { email: "other@example.test" },
          "wrong audit role": { role: "owner" },
        };
        await fixture.db
          .update(schema.tenantAuditEvents)
          .set({
            after: {
              ...(audit.after as Record<string, unknown>),
              ...(edits[change] as Record<string, unknown>),
            },
          })
          .where(auditWhere);
        break;
      }
      case "extra account":
      case "extra credential":
        await fixture.db.insert(schema.account).values({
          id: randomUUID(),
          userId: viewer.viewerUserId,
          accountId: viewer.viewerUserId,
          providerId: change === "extra account" ? "oidc" : "credential",
          password: "unrelated",
        });
        break;
      case "wrong accountId":
        await fixture.db
          .update(schema.account)
          .set({ accountId: context.originalOwnerId })
          .where(accountWhere);
        break;
      case "wrong provider":
        await fixture.db.update(schema.account).set({ providerId: "oidc" }).where(accountWhere);
        break;
      case "missing credential":
        await fixture.db.delete(schema.account).where(accountWhere);
        break;
      case "empty hash":
        await fixture.db.update(schema.account).set({ password: "" }).where(accountWhere);
        break;
      case "changed hash":
        await fixture.db
          .update(schema.account)
          .set({ password: "invalid-hash" })
          .where(accountWhere);
        break;
      case "changed name":
        await fixture.db.update(schema.user).set({ name: "Renamed viewer" }).where(userWhere);
        break;
      case "changed email":
        await fixture.db
          .update(schema.user)
          .set({ email: "renamed@example.test" })
          .where(userWhere);
        break;
      case "missing viewer":
        await fixture.db.delete(schema.user).where(userWhere);
        break;
      case "missing member":
        await fixture.db.delete(schema.member).where(memberWhere);
        break;
      case "extra member":
      case "foreign member": {
        let organizationId = context.tenantId;
        if (change === "foreign member") {
          organizationId = randomUUID();
          await fixture.db.insert(schema.organization).values({
            id: organizationId,
            name: "Synthetic foreign",
            slug: organizationId,
            createdAt: new Date(),
          });
        }
        await fixture.db.insert(schema.member).values({
          id: randomUUID(),
          userId: viewer.viewerUserId,
          organizationId,
          role: "traceability_auditor",
          createdAt: new Date(),
        });
        break;
      }
      case "comma role":
      case "space role":
      case "owner role":
      case "QA role": {
        const roles: Record<string, string> = {
          "comma role": "traceability_auditor,owner",
          "space role": " traceability_auditor ",
          "owner role": "owner",
          "QA role": "traceability_qa",
        };
        await fixture.db
          .update(schema.member)
          .set({ role: roles[change] ?? "" })
          .where(memberWhere);
        break;
      }
      case "missing owner":
        await fixture.db.delete(schema.user).where(eq(schema.user.id, context.originalOwnerId));
        break;
      case "missing owner member":
        await fixture.db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.userId, context.originalOwnerId),
              eq(schema.member.organizationId, context.tenantId),
            ),
          );
        break;
      case "missing profile":
        await fixture.db.delete(schema.traceabilityProfiles);
        break;
      case "missing timezone":
        await fixture.db.delete(schema.orgProfiles);
        break;
      case "wrong profile":
        await fixture.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_GENERIC_LOT_TRACEABILITY" });
        break;
      case "wrong baseline":
        await fixture.db.update(schema.traceabilityProfiles).set({ baselineVersion: "US-other" });
        break;
      case "wrong retention":
        await fixture.db.update(schema.traceabilityProfiles).set({ retentionYears: 5 });
        break;
      case "wrong timezone":
        await fixture.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
        break;
    }
    const ctx =
      change === "wrong context owner"
        ? { ...context, originalOwnerId: viewer.viewerUserId }
        : change === "wrong context tenant"
          ? { ...context, tenantId: randomUUID() }
          : context;
    await expectConflictNoWrites(
      change === "wrong password" ? "Different-viewer-password-42!" : password,
      ctx,
    );
  });
});
