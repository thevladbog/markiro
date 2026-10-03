import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { schema } from "@markiro/db";
import type { UsPlanSections } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { UsPlanInspectionStore } from "../src/modules/traceability/plans/us-plan-inspection";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import type { UsPlanDraftPdfModel } from "../src/modules/traceability/plans/us-plan-pdf";

const url = process.env.US_TEST_DATABASE_URL;
const confirmations = {
  procedures: true,
  backupAndRecovery: true,
  contact: true,
  nonFarmScope: true,
};
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Register",
    formats: ["PDF"],
    recordLocations: ["QA cabinet"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Operator reports backups",
    narrative: [],
  },
  ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
  tlcAssignment: { procedure: "Assign at processing" },
  pointOfContact: { name: "Example QA", title: "QA", phone: "+1 555 0100", email: null },
  farmActivity: { status: "no", explanation: "No farming" },
  reviewAndUpdate: { procedure: "Update on change" },
};
describe.skipIf(!url)("saved US plan inspection", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let drafts: UsPlanStore;
  let inspection: UsPlanInspectionStore;
  let tenant: string;
  let actor: string;
  let location: string;
  beforeAll(async () => {
    if (!url) throw new Error("Missing US test database");
    fixture = await createUsProfileTestDatabase(url);
    drafts = new UsPlanStore(fixture.db);
    inspection = new UsPlanInspectionStore(fixture.db, "artifact_storage_unconfigured");
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    tenant = randomUUID();
    actor = randomUUID();
    location = randomUUID();
    await fixture.db
      .insert(schema.user)
      .values({ id: actor, name: "QA", email: `${actor}@example.test` });
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenant, name: "Example foods", slug: tenant, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenant,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    const partyId = randomUUID();
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: tenant, name: "Source" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: location,
      tenantId: tenant,
      partyId,
      name: "Source",
      businessName: "Source",
      phoneNumber: "+1 555 0100",
      streetAddress: "10 Main",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["tlc_source"],
    });
  });
  const create = (value = sections) =>
    drafts.createDraft(tenant, actor, { sections: value, changeSummary: "" }, "create");
  const state = () =>
    Promise.all([
      fixture.db
        .select()
        .from(schema.traceabilityPlanVersions)
        .where(eq(schema.traceabilityPlanVersions.tenantId, tenant)),
      fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenant)),
    ]);
  it("validates and renders a real saved draft without storage or confirmation writes", async () => {
    const draft = await create();
    const before = await state();
    expect(
      await inspection.validate(tenant, actor, draft.id, { expectedRevision: 1, confirmations }),
    ).toEqual({
      versionId: draft.id,
      draftRevision: 1,
      issues: [],
      publicationAvailability: "artifact_storage_unconfigured",
    });
    const result = await inspection.preview(tenant, actor, draft.id, { expectedRevision: 1 });
    expect(result.draftRevision).toBe(1);
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      execFileSync("pdftotext", ["-", "-"], { input: result.bytes, encoding: "utf8" }),
    ).toContain("DRAFT — not effective");
    expect(await state()).toEqual(before);
    const validation = await inspection.validate(tenant, actor, draft.id, {
      expectedRevision: 1,
      confirmations: {
        procedures: false,
        backupAndRecovery: false,
        contact: false,
        nonFarmScope: false,
      },
    });
    expect(validation.issues).toHaveLength(4);
    expect(validation.issues.every((issue) => issue.code === "confirmation_required")).toBe(true);
  }, 20_000);
  it.each(["farm", "wording", "location"])(
    "returns %s findings and never renders invalid content",
    async (kind) => {
      const draft = await create(
        kind === "farm"
          ? { ...sections, farmActivity: { status: "unknown", explanation: "Unknown" } }
          : kind === "wording"
            ? { ...sections, tlcAssignment: { procedure: "FDA approved" } }
            : sections,
      );
      if (kind === "location")
        await fixture.db
          .update(schema.traceabilityLocations)
          .set({ phoneNumber: null })
          .where(eq(schema.traceabilityLocations.id, location));
      const render = vi.fn();
      const store = new UsPlanInspectionStore(fixture.db, "available", render);
      const result = await store.validate(tenant, actor, draft.id, {
        expectedRevision: 1,
        confirmations,
      });
      expect(result.issues).toEqual([
        expect.objectContaining({
          code:
            kind === "farm"
              ? "farm_scope_unsupported"
              : kind === "wording"
                ? "prohibited_claim"
                : "tlc_source_location_incomplete",
        }),
      ]);
      await expect(
        store.preview(tenant, actor, draft.id, { expectedRevision: 1 }),
      ).rejects.toMatchObject({
        response: { code: "us_plan_validation_failed", issues: result.issues },
      });
      expect(render).not.toHaveBeenCalled();
    },
  );
  it.each(["validate", "preview"] as const)(
    "rejects stale revision, forged input and revoked capability for %s",
    async (method) => {
      const draft = await create();
      const body =
        method === "validate" ? { expectedRevision: 1, confirmations } : { expectedRevision: 1 };
      await expect(
        inspection[method](tenant, actor, draft.id, { ...body, expectedRevision: 2 }),
      ).rejects.toMatchObject({ response: { code: "us_plan_revision_conflict" } });
      await expect(inspection[method](tenant, actor, randomUUID(), body)).rejects.toMatchObject({
        response: { code: "us_plan_version_not_found" },
      });
      await expect(
        inspection[method](tenant, actor, draft.id, { ...body, provenance: "trusted_synthetic" }),
      ).rejects.toMatchObject({ status: 400 });
      await fixture.db
        .update(schema.member)
        .set({ role: method === "validate" ? "traceability_auditor" : "traceability_receiving" })
        .where(eq(schema.member.organizationId, tenant));
      await expect(inspection[method](tenant, actor, draft.id, body)).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it("returns the captured revision and pending facts if a later save occurs during rendering", async () => {
    const draft = await create();
    const render = vi.fn(async (model: UsPlanDraftPdfModel) => {
      await drafts.saveDraft(
        tenant,
        actor,
        draft.id,
        {
          sections: {
            ...sections,
            pointOfContact: { ...sections.pointOfContact, name: "Later contact" },
          },
          changeSummary: "Later",
          expectedRevision: 1,
        },
        "edit",
      );
      expect(model.snapshot.sections.pointOfContact.name).toBe("Example QA");
      expect(JSON.stringify(model.factSources)).toContain("operator_pending");
      expect(JSON.stringify(model.factSources)).not.toContain("operator_confirmed");
      return Buffer.from("captured");
    });
    expect(
      await new UsPlanInspectionStore(fixture.db, "available", render).preview(
        tenant,
        actor,
        draft.id,
        { expectedRevision: 1 },
      ),
    ).toEqual({ bytes: Buffer.from("captured"), draftRevision: 1 });
    await expect(
      inspection.preview(tenant, actor, draft.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ response: { code: "us_plan_revision_conflict" } });
  });
  it("marks a trusted synthetic preview while leaving the saved draft untouched", async () => {
    const seed = await new UsDevelopmentOwnerStore(fixture.db).provision(
      "synthetic-test-password",
      "seed",
    );
    const [source] = await fixture.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, location));
    if (!source) throw new Error("Missing source fixture");
    tenant = seed.tenantId;
    actor = seed.userId;
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    const partyId = randomUUID();
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: tenant, name: "Source" });
    await fixture.db
      .insert(schema.traceabilityLocations)
      .values({ ...source, id: randomUUID(), tenantId: tenant, partyId });
    const draft = await create();
    const before = await state();
    const { bytes } = await inspection.preview(tenant, actor, draft.id, { expectedRevision: 1 });
    const pages = execFileSync("pdftotext", ["-", "-"], { input: bytes, encoding: "utf8" })
      .split("\f")
      .filter((page) => page.trim());
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page).toContain("Synthetic demo — not an operational record");
      expect(page).toContain("DRAFT — not effective");
    }
    expect(await state()).toEqual(before);
  }, 20_000);
  it("makes foreign and absent draft IDs indistinguishable", async () => {
    const draft = await create();
    const other = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: other, name: "Other", slug: other, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: other,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: other,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: other, timeZone: "America/Chicago" });
    for (const method of ["validate", "preview"] as const) {
      const body =
        method === "validate" ? { expectedRevision: 1, confirmations } : { expectedRevision: 1 };
      for (const id of [draft.id, randomUUID()])
        await expect(inspection[method](other, actor, id, body)).rejects.toMatchObject({
          status: 404,
          response: { code: "us_plan_version_not_found" },
        });
    }
  });
});
