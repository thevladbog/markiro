import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { UsProfileStore } from "../src/modules/traceability/profile/us-profile-store";

const url = process.env.US_TEST_DATABASE_URL;
const input = { code: "US_FSMA204_PROCESSOR", timeZone: "America/Chicago" };

describe.skipIf(!url)("US profile store with real isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsProfileStore;
  let tenantId: string;
  let actorUserId: string;
  let memberId: string;

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsProfileStore(fixture.db);
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    tenantId = randomUUID();
    actorUserId = randomUUID();
    memberId = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US", slug: tenantId, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actorUserId, name: "Synthetic owner", email: `${actorUserId}@example.test` });
    await fixture.db.insert(schema.member).values({
      id: memberId,
      organizationId: tenantId,
      userId: actorUserId,
      role: "owner",
      createdAt: new Date(),
    });
  });

  it("does not silently fall back to RU when the profile is absent", async () => {
    await expect(store.read(tenantId, actorUserId)).rejects.toMatchObject({ status: 503 });
  });

  it("atomically stores explicit timezone, profile and the exact audit snapshot", async () => {
    const profile = await store.provision(tenantId, actorUserId, input, "us-profile-test");
    expect(profile).toEqual({
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      effectiveAt: expect.any(String),
      retentionYears: 5,
      timeZone: "America/Chicago",
    });
    expect(await store.read(tenantId, actorUserId)).toEqual(profile);
    const [row] = await fixture.db
      .select()
      .from(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    expect(row).toMatchObject({ tenantId, updatedByUserId: actorUserId, retentionYears: 5 });
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      id: expect.any(String),
      organizationId: tenantId,
      actorUserId,
      action: "traceability.profile.updated",
      outcome: "success",
      targetType: "tenant",
      targetId: tenantId,
      before: null,
      after: profile,
      requestId: "us-profile-test",
      createdAt: expect.any(Date),
    });
  });

  it("serializes concurrent identical provisioning and emits only one audit event", async () => {
    const profiles = await Promise.all(
      Array.from({ length: 4 }, () => store.provision(tenantId, actorUserId, input, "retry")),
    );
    expect(
      profiles.every((profile) => JSON.stringify(profile) === JSON.stringify(profiles[0])),
    ).toBe(true);
    expect(await store.provision(tenantId, actorUserId, input, "later-retry")).toEqual(profiles[0]);
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audits).toHaveLength(1);
  });

  it.each([
    { ...input, code: "US_GENERIC_LOT_TRACEABILITY" },
    { ...input, timeZone: "America/New_York" },
    { ...input, retentionYears: 2 },
  ])("refuses a conflicting retry without altering stored identity %j", async (changed) => {
    const original = await store.provision(tenantId, actorUserId, input, "first");
    await expect(store.provision(tenantId, actorUserId, changed, "conflict")).rejects.toMatchObject(
      { status: 409 },
    );
    expect(await store.read(tenantId, actorUserId)).toEqual(original);
  });

  it.each(["manager", "member", "unknown"])("denies settings access to role %s", async (role) => {
    await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
    await expect(store.provision(tenantId, actorUserId, input, "denied")).rejects.toMatchObject({
      status: 403,
    });
    await expect(store.read(tenantId, actorUserId)).rejects.toMatchObject({ status: 403 });
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityProfiles)
        .where(eq(schema.traceabilityProfiles.tenantId, tenantId)),
    ).toHaveLength(0);
  });

  it("never reads or writes another tenant and reloads revoked membership", async () => {
    await store.provision(tenantId, actorUserId, input, "first");
    const other = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: other, name: "Other synthetic tenant", slug: other, createdAt: new Date() });
    await expect(store.read(other, actorUserId)).rejects.toMatchObject({ status: 403 });
    await expect(store.provision(other, actorUserId, input, "cross-tenant")).rejects.toMatchObject({
      status: 403,
    });
    await expect(store.read(tenantId, "unknown-user")).rejects.toMatchObject({ status: 403 });
    await fixture.db.delete(schema.member).where(eq(schema.member.id, memberId));
    await expect(store.read(tenantId, actorUserId)).rejects.toMatchObject({ status: 403 });
    await expect(store.provision(tenantId, actorUserId, input, "revoked")).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    { code: "RU_CHZ", timeZone: "America/Chicago" },
    { code: "US_FSMA204_PROCESSOR" },
    { ...input, retentionYears: 1 },
    { ...input, baselineVersion: "injected" },
  ])(
    "rejects invalid input without partial profile, timezone or audit rows %j",
    async (invalid) => {
      await expect(
        store.provision(tenantId, actorUserId, invalid, "invalid"),
      ).rejects.toMatchObject({ status: 400 });
      for (const table of [schema.traceabilityProfiles, schema.orgProfiles]) {
        expect(
          await fixture.db.select().from(table).where(eq(table.tenantId, tenantId)),
        ).toHaveLength(0);
      }
      expect(
        await fixture.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, tenantId)),
      ).toHaveLength(0);
    },
  );

  it("allows an admin to provision the generic boundary without FTR promotion", async () => {
    await fixture.db
      .update(schema.member)
      .set({ role: "admin" })
      .where(eq(schema.member.id, memberId));
    expect(
      await store.provision(
        tenantId,
        actorUserId,
        { ...input, code: "US_GENERIC_LOT_TRACEABILITY", retentionYears: 2 },
        "generic",
      ),
    ).toMatchObject({ code: "US_GENERIC_LOT_TRACEABILITY", retentionYears: 2 });
  });

  it("rolls back profile and timezone when the audit write fails", async () => {
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId, timeZone: "America/Denver", gln: "synthetic-existing-value" });
    await fixture.pool.query(
      `CREATE FUNCTION reject_profile_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'rollback-proof' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
    );
    await fixture.pool.query(
      `CREATE TRIGGER reject_profile_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_profile_audit()`,
    );
    try {
      await expect(
        store.provision(tenantId, actorUserId, input, "rollback-proof"),
      ).rejects.toMatchObject({ cause: { code: "P0001" } });
      expect(
        await fixture.db
          .select()
          .from(schema.traceabilityProfiles)
          .where(eq(schema.traceabilityProfiles.tenantId, tenantId)),
      ).toHaveLength(0);
      const [zone] = await fixture.db
        .select()
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId));
      expect(zone).toMatchObject({ timeZone: "America/Denver", gln: "synthetic-existing-value" });
      expect(
        await fixture.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, tenantId)),
      ).toHaveLength(0);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_profile_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_profile_audit()");
    }
  });

  it("fails closed for a persisted RU profile and a missing timezone", async () => {
    await fixture.db.insert(schema.traceabilityProfiles).values({ tenantId, code: "RU_CHZ" });
    await expect(store.read(tenantId, actorUserId)).rejects.toMatchObject({ status: 503 });
    await expect(
      store.provision(tenantId, actorUserId, input, "wrong-edition"),
    ).rejects.toMatchObject({ status: 503 });
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await store.provision(tenantId, actorUserId, input, "first");
    await fixture.db.delete(schema.orgProfiles).where(eq(schema.orgProfiles.tenantId, tenantId));
    await expect(store.read(tenantId, actorUserId)).rejects.toMatchObject({ status: 503 });
  });
});
