import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { UsPlanSections } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "",
    formats: [],
    recordLocations: [],
    responsibleRoles: [],
    backupAndRecovery: "",
    narrative: ["Private operator text"],
  },
  ftlIdentification: { procedure: "", reviewCadence: "" },
  tlcAssignment: { procedure: "" },
  pointOfContact: { name: "", title: "", phone: "", email: null },
  farmActivity: { status: "unknown", explanation: "" },
  reviewAndUpdate: { procedure: "" },
};
const input = { sections, changeSummary: "" };

describe.skipIf(!url)("US plan internal drafts in disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsPlanStore;
  let tenant: string;
  let otherTenant: string;
  let actor: string;
  let member: string;
  const create = (request = "create") => store.createDraft(tenant, actor, input, request);
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenant));
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US test database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsPlanStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    tenant = randomUUID();
    otherTenant = randomUUID();
    actor = randomUUID();
    member = randomUUID();
    await fixture.db
      .insert(schema.user)
      .values({ id: actor, name: "Synthetic QA", email: `${actor}@example.test` });
    for (const id of [tenant, otherTenant]) {
      await fixture.db
        .insert(schema.organization)
        .values({ id, name: "Synthetic", slug: id, createdAt: new Date() });
      await fixture.db.insert(schema.member).values({
        id: id === tenant ? member : randomUUID(),
        organizationId: id,
        userId: actor,
        role: "owner",
        createdAt: new Date(),
      });
      await fixture.db.insert(schema.traceabilityProfiles).values({
        tenantId: id,
        code: "US_FSMA204_PROCESSOR",
        baselineVersion: "US-REG-2026-09-03",
        retentionYears: 5,
      });
      await fixture.db
        .insert(schema.orgProfiles)
        .values({ tenantId: id, timeZone: "America/Chicago" });
    }
  });

  it("creates v1, reads and lists only this tenant and writes exact metadata-only success audit", async () => {
    const draft = await create();
    expect(draft).toMatchObject({
      versionNumber: 1,
      draftRevision: 1,
      sections,
      changeSummary: "",
      status: "draft",
      statementOwnership: "operator_pending",
    });
    expect(await store.getVersion(tenant, actor, draft.id, "read")).toEqual(draft);
    expect(await store.listVersions(tenant, actor, "list")).toEqual({ items: [draft] });
    expect(await store.listVersions(otherTenant, actor, "list")).toEqual({ items: [] });
    const [audit] = await audits();
    expect(audit).toMatchObject({
      organizationId: tenant,
      actorUserId: actor,
      action: "traceability.plan.draft_created",
      outcome: "success",
      targetType: "traceability_plan_version",
      targetId: draft.id,
      before: null,
      after: { versionNumber: 1, draftRevision: 1 },
      requestId: "create",
    });
    expect(JSON.stringify(audit)).not.toContain("Private operator text");
  });

  it("serializes concurrent first creates and audits the losing business rejection exactly", async () => {
    const results = await Promise.allSettled([create("a"), create("b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.getResponse() : null).toEqual({
      code: "us_plan_draft_exists",
    });
    expect(await audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: tenant,
          actorUserId: actor,
          action: "traceability.plan.draft_created",
          outcome: "conflict",
          targetType: "traceability_plan_version",
          targetId: null,
          before: null,
          after: { code: "us_plan_draft_exists" },
          requestId: expect.stringMatching(/^[ab]$/),
        }),
      ]),
    );
  });

  it("checks stale revisions before no-op, serializes saves, and preserves no-op revision/time/audit", async () => {
    const draft = await create();
    const save = { ...input, expectedRevision: 1, changeSummary: "changed" };
    const results = await Promise.allSettled([
      store.saveDraft(tenant, actor, draft.id, save, "a"),
      store.saveDraft(tenant, actor, draft.id, save, "b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = await store.getVersion(tenant, actor, draft.id, "read");
    expect(current.draftRevision).toBe(2);
    await expect(store.saveDraft(tenant, actor, draft.id, save, "stale")).rejects.toMatchObject({
      response: { code: "us_plan_revision_conflict" },
    });
    const before = await audits();
    const staleAudit = before.find((audit) => audit.requestId === "stale");
    expect(staleAudit).toMatchObject({
      organizationId: tenant,
      actorUserId: actor,
      action: "traceability.plan.draft_updated",
      outcome: "conflict",
      targetType: "traceability_plan_version",
      targetId: draft.id,
      before: null,
      after: { code: "us_plan_revision_conflict" },
    });
    expect(staleAudit?.after).toEqual({ code: "us_plan_revision_conflict" });
    expect(
      await store.saveDraft(tenant, actor, draft.id, { ...save, expectedRevision: 2 }, "noop"),
    ).toEqual(current);
    expect(await audits()).toEqual(before);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "traceability.plan.draft_updated",
          outcome: "success",
          targetId: draft.id,
          before: { versionNumber: 1, draftRevision: 1 },
          after: { versionNumber: 1, draftRevision: 2 },
        }),
      ]),
    );
  });

  it("denies cross-tenant IDs and malformed IDs/bodies without touching the draft", async () => {
    const draft = await create();
    await expect(store.getVersion(otherTenant, actor, draft.id, "read")).rejects.toMatchObject({
      response: { code: "us_plan_version_not_found" },
    });
    await expect(
      store.saveDraft(otherTenant, actor, draft.id, { ...input, expectedRevision: 1 }, "wrong"),
    ).rejects.toMatchObject({ response: { code: "us_plan_version_not_found" } });
    await expect(
      store.discardDraft(otherTenant, actor, draft.id, { expectedRevision: 1 }, "wrong"),
    ).rejects.toMatchObject({ response: { code: "us_plan_version_not_found" } });
    await expect(store.getVersion(tenant, actor, "bad", "read")).rejects.toMatchObject({
      response: { code: "invalid_master_data" },
    });
    await expect(
      store.saveDraft(tenant, actor, "bad", { ...input, expectedRevision: 1 }, "bad-id"),
    ).rejects.toMatchObject({ response: { code: "invalid_master_data" } });
    await expect(
      store.createDraft(tenant, actor, { sections: {}, changeSummary: "" }, "bad-json"),
    ).rejects.toMatchObject({ response: { code: "invalid_master_data" } });
    await expect(
      store.saveDraft(
        tenant,
        actor,
        draft.id,
        { ...input, expectedRevision: 1, syntheticDemo: true },
        "forged",
      ),
    ).rejects.toMatchObject({ response: { code: "invalid_master_data" } });
    expect(await store.getVersion(tenant, actor, draft.id, "read")).toEqual(draft);
    expect(JSON.stringify(await audits())).not.toContain("Private operator text");
  });

  it("reloads roles for reads/mutations and rejects generic profiles", async () => {
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, member));
    expect(await store.listVersions(tenant, actor, "read")).toEqual({ items: [] });
    await expect(create()).rejects.toMatchObject({ response: { code: "insufficient_permission" } });
    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.id, member));
    await expect(store.listVersions(tenant, actor, "read")).rejects.toMatchObject({
      response: { code: "insufficient_permission" },
    });
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, member));
    await fixture.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await fixture.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
    await expect(create()).rejects.toMatchObject({
      response: { code: "us_plan_profile_unsupported" },
    });
    await expect(store.listVersions(tenant, actor, "read")).rejects.toMatchObject({
      response: { code: "us_plan_profile_unsupported" },
    });
    await fixture.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await fixture.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
    await expect(create()).rejects.toMatchObject({
      response: { code: "traceability_profile_invalid" },
    });
  });

  it("discards only revision-matching drafts with exact audit", async () => {
    const draft = await create();
    await expect(
      store.discardDraft(tenant, actor, draft.id, { expectedRevision: 2 }, "stale"),
    ).rejects.toMatchObject({ response: { code: "us_plan_revision_conflict" } });
    await store.discardDraft(tenant, actor, draft.id, { expectedRevision: 1 }, "discard");
    expect(await store.listVersions(tenant, actor, "read")).toEqual({ items: [] });
    expect(await audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: actor,
          organizationId: tenant,
          action: "traceability.plan.draft_discarded",
          outcome: "success",
          targetId: draft.id,
          targetType: "traceability_plan_version",
          before: { versionNumber: 1, draftRevision: 1 },
          after: null,
          requestId: "discard",
        }),
      ]),
    );
  });

  it("allocates v2 after retained v1 and exposes only published metadata; published writes conflict", async () => {
    const draft = await create();
    await fixture.db
      .update(schema.traceabilityPlanVersions)
      .set({
        status: "effective",
        approvedBy: actor,
        approvedAt: new Date(),
        configSnapshot: { private: "frozen" },
        configDigest: "a".repeat(64),
        pdfObjectKey: "private/key",
        pdfSha256: "b".repeat(64),
        pdfByteSize: 10,
        rendererVersion: "test",
      })
      .where(
        and(
          eq(schema.traceabilityPlanVersions.tenantId, tenant),
          eq(schema.traceabilityPlanVersions.id, draft.id),
        ),
      );
    const published = await store.getVersion(tenant, actor, draft.id, "read");
    expect(published).toMatchObject({
      id: draft.id,
      versionNumber: 1,
      status: "effective",
      approvedBy: actor,
    });
    expect(published).not.toHaveProperty("sections");
    expect(published).not.toHaveProperty("pdfObjectKey");
    expect((await create()).versionNumber).toBe(2);
    await expect(
      store.discardDraft(tenant, actor, draft.id, { expectedRevision: 1 }, "published"),
    ).rejects.toMatchObject({ response: { code: "us_plan_not_draft" } });
    await expect(
      store.saveDraft(tenant, actor, draft.id, { ...input, expectedRevision: 1 }, "published"),
    ).rejects.toMatchObject({ response: { code: "us_plan_not_draft" } });
  });

  it("fails closed for corrupted stored sections", async () => {
    const draft = await create();
    await fixture.db
      .update(schema.traceabilityPlanVersions)
      .set({ sections: {} })
      .where(eq(schema.traceabilityPlanVersions.id, draft.id));
    await expect(store.getVersion(tenant, actor, draft.id, "read")).rejects.toMatchObject({
      response: { code: "us_plan_stored_draft_invalid" },
    });
  });

  it("rolls back a mutation and its success audit on infrastructure failure", async () => {
    await fixture.pool.query(
      "CREATE FUNCTION reject_plan_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'traceability.plan.draft_created' THEN RAISE EXCEPTION 'synthetic infrastructure failure'; END IF; RETURN NEW; END $$",
    );
    await fixture.pool.query(
      "CREATE TRIGGER reject_plan_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_plan_audit()",
    );
    try {
      await expect(create()).rejects.toThrow();
      expect(await store.listVersions(tenant, actor, "read")).toEqual({ items: [] });
      expect(await audits()).toEqual([]);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_plan_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_plan_audit()");
    }
  });

  it("rolls back save/discard including audit, and propagates storage failure without business relabelling", async () => {
    const draft = await create();
    const before = await audits();
    await fixture.pool.query(
      "CREATE FUNCTION reject_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('traceability.plan.draft_updated', 'traceability.plan.draft_discarded') THEN RAISE EXCEPTION 'synthetic infrastructure failure'; END IF; RETURN NEW; END $$",
    );
    await fixture.pool.query(
      "CREATE TRIGGER reject_edit_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_edit_audit()",
    );
    try {
      await expect(
        store.saveDraft(
          tenant,
          actor,
          draft.id,
          { ...input, expectedRevision: 1, changeSummary: "changed" },
          "rollback-save",
        ),
      ).rejects.toThrow();
      expect(await store.getVersion(tenant, actor, draft.id, "read")).toEqual(draft);
      await expect(
        store.discardDraft(tenant, actor, draft.id, { expectedRevision: 1 }, "rollback-discard"),
      ).rejects.toThrow();
      expect(await store.getVersion(tenant, actor, draft.id, "read")).toEqual(draft);
      expect(await audits()).toEqual(before);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_edit_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_edit_audit()");
    }
  });

  it.each([
    ["traceability_plan_one_draft_uq", "us_plan_draft_exists"],
    ["traceability_plan_tenant_version_uq", "us_plan_version_conflict"],
  ])(
    "maps the final %s uniqueness guard to a bounded audited conflict",
    async (constraint, code) => {
      await fixture.pool.query(
        "CREATE FUNCTION reject_plan_unique() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE unique_violation USING CONSTRAINT = TG_ARGV[0]; END $$",
      );
      await fixture.pool.query(
        `CREATE TRIGGER reject_plan_unique BEFORE INSERT ON traceability_plan_versions FOR EACH ROW EXECUTE FUNCTION reject_plan_unique('${constraint}')`,
      );
      try {
        await expect(create("unique")).rejects.toMatchObject({ response: { code } });
        expect(await store.listVersions(tenant, actor, "read")).toEqual({ items: [] });
        const [audit] = await audits();
        expect(audit).toMatchObject({
          organizationId: tenant,
          actorUserId: actor,
          action: "traceability.plan.draft_created",
          outcome: "conflict",
          targetType: "traceability_plan_version",
          targetId: null,
          before: null,
          after: { code },
          requestId: "unique",
        });
        expect(audit?.after).toEqual({ code });
      } finally {
        await fixture.pool.query("DROP TRIGGER reject_plan_unique ON traceability_plan_versions");
        await fixture.pool.query("DROP FUNCTION reject_plan_unique()");
      }
    },
  );
});
