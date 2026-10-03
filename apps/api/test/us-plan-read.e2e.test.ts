import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  buildUsPlanApprovedEvidence,
  buildUsPlanDraftFactSources,
  buildUsPlanSnapshot,
  canonicalExportDigest,
  type UsPlanSections,
} from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsPlanReadStore } from "../src/modules/traceability/plans/us-plan-read";
import { readUsPlanConfiguration } from "../src/modules/traceability/plans/us-plan-configuration";
import * as configuration from "../src/modules/traceability/plans/us-plan-configuration";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Register",
    formats: ["PDF"],
    recordLocations: ["QA"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Operator statement",
    narrative: [],
  },
  ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
  tlcAssignment: { procedure: "Assign at processing" },
  pointOfContact: { name: "QA", title: "QA", phone: "5550100", email: null },
  farmActivity: { status: "no", explanation: "No farming" },
  reviewAndUpdate: { procedure: "Update on change" },
};
describe.skipIf(!url)("US plan authorized read projection in disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsPlanReadStore;
  let tenant: string;
  let actor: string;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsPlanReadStore(fixture.db, "artifact_storage_unconfigured");
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    tenant = randomUUID();
    actor = randomUUID();
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
  });
  async function draft(number = 1) {
    const [row] = await fixture.db
      .insert(schema.traceabilityPlanVersions)
      .values({
        tenantId: tenant,
        versionNumber: number,
        createdBy: actor,
        sections,
        changeSummary: "Updated",
      })
      .returning();
    if (!row) throw new Error("Missing draft");
    return row;
  }
  async function publish(
    number: number,
    existing?: Awaited<ReturnType<typeof draft>>,
    synthetic = false,
  ) {
    const row = existing ?? (await draft(number));
    const { facts } = await fixture.db.transaction((tx) => readUsPlanConfiguration(tx, tenant));
    const snapshot = buildUsPlanSnapshot(
      facts,
      sections,
      synthetic ? "trusted_synthetic" : "operational",
    );
    const approvedAt = new Date("2026-10-03T01:00:00.000Z");
    const seed = synthetic
      ? await new UsDevelopmentOwnerStore(fixture.db).verifyTrustedSeed(tenant, approvedAt)
      : null;
    const evidence = buildUsPlanApprovedEvidence(
      snapshot,
      buildUsPlanDraftFactSources(facts, sections),
      {
        kind: synthetic ? "synthetic" : "operational",
        actorId: actor,
        confirmedAt: approvedAt.toISOString(),
        confirmations: {
          procedures: true,
          backupAndRecovery: true,
          contact: true,
          nonFarmScope: true,
        },
        ...(seed ? { trustedSeed: seed } : {}),
      },
    );
    await fixture.db
      .update(schema.traceabilityPlanVersions)
      .set({
        status: "effective",
        approvedBy: actor,
        approvedAt,
        configSnapshot: snapshot,
        configDigest: canonicalExportDigest(snapshot),
        approvedEvidence: evidence,
        idempotencyKeyHash: createHash("sha256").update(row.id).digest("hex"),
        approvalRequestDigest: "b".repeat(64),
        pdfObjectKey: `us/plans/${tenant}/${row.id}/${randomUUID()}.pdf`,
        pdfSha256: "c".repeat(64),
        pdfByteSize: 100,
        rendererVersion: "us-plan-pdf-v1",
      })
      .where(eq(schema.traceabilityPlanVersions.id, row.id));
    return row.id;
  }
  it("lists v1/v2/draft and preserves frozen v1 with separately labelled current impact", async () => {
    const first = await publish(1);
    const next = await draft(2);
    await fixture.db
      .update(schema.traceabilityPlanVersions)
      .set({
        status: "superseded",
        supersededById: next.id,
        supersededAt: new Date("2026-10-03T01:00:00.000Z"),
        retainThrough: "2031-10-03",
      })
      .where(eq(schema.traceabilityPlanVersions.id, first));
    await fixture.db
      .update(schema.organization)
      .set({ name: "New name" })
      .where(eq(schema.organization.id, tenant));
    await publish(2, next);
    await draft(3);
    const list = await store.list(tenant, actor);
    expect(list.items.map((x) => x.status)).toEqual(["draft", "effective", "superseded"]);
    expect(list.effectiveImpact).toEqual({
      changedSections: [],
      changedLocationIds: [],
      changedProductIds: [],
    });
    expect(list.publicationAvailability).toBe("artifact_storage_unconfigured");
    const detail = await store.get(tenant, actor, first);
    expect(detail.status).toBe("superseded");
    if (detail.status === "draft") throw new Error("Expected published");
    expect(detail.snapshot.configured.tenantName).toBe("Example foods");
    expect(detail.comparisonAgainstCurrentConfiguredFacts.changedSections).toEqual(["tenant"]);
    expect(detail.artifact.sha256).toBe("c".repeat(64));
    expect(detail.retainThrough).toBe("2031-10-03");
    expect(JSON.stringify({ list, detail })).not.toMatch(/objectKey|trustedSeed|verifiedBy|seedId/);
  });
  it("returns indistinguishable missing and foreign IDs, and rechecks revoked membership", async () => {
    const row = await draft();
    await expect(store.get(tenant, actor, randomUUID())).rejects.toMatchObject({
      status: 404,
      response: { code: "us_plan_version_not_found" },
    });
    const foreignTenant = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: foreignTenant, name: "Foreign", slug: foreignTenant, createdAt: new Date() });
    const foreignId = randomUUID();
    await fixture.db.insert(schema.traceabilityPlanVersions).values({
      id: foreignId,
      tenantId: foreignTenant,
      versionNumber: 1,
      createdBy: actor,
      sections,
    });
    await expect(store.get(tenant, actor, foreignId)).rejects.toMatchObject({
      status: 404,
      response: { code: "us_plan_version_not_found" },
    });
    expect((await store.list(tenant, actor)).items.map((item) => item.id)).toEqual([row.id]);
    await fixture.db.delete(schema.member).where(eq(schema.member.userId, actor));
    await expect(store.list(tenant, actor)).rejects.toMatchObject({ status: 403 });
    await expect(store.get(tenant, actor, row.id)).rejects.toMatchObject({ status: 403 });
  });
  it("denies generic profiles safely", async () => {
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await expect(store.list(tenant, actor)).rejects.toMatchObject({ status: 403 });
  });
  it("reports exact changed location and product IDs without rewriting frozen facts", async () => {
    const partyId = randomUUID();
    const locationId = randomUUID();
    const productId = randomUUID();
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: tenant, name: "Source" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: locationId,
      tenantId: tenant,
      partyId,
      name: "Source",
      businessName: "Source",
      streetAddress: "10 Main",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["tlc_source"],
    });
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId: tenant, name: "Food" });
    await fixture.db
      .insert(schema.productTraceabilityProfiles)
      .values({ tenantId: tenant, productId, productName: "Food" });
    const id = await publish(1);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "New source" })
      .where(eq(schema.traceabilityLocations.id, locationId));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({ revision: 2 })
      .where(eq(schema.productTraceabilityProfiles.productId, productId));
    const impact = {
      changedSections: ["tlcSourceLocations", "productProfiles"],
      changedLocationIds: [locationId],
      changedProductIds: [productId],
    };
    expect((await store.list(tenant, actor)).effectiveImpact).toEqual(impact);
    const detail = await store.get(tenant, actor, id);
    if (detail.status === "draft") throw new Error("Expected published");
    expect(detail.comparisonAgainstCurrentConfiguredFacts).toEqual(impact);
    expect(detail.snapshot.configured.tlcSourceLocations[0]?.description.businessName).toBe(
      "Source",
    );
    expect(detail.snapshot.configured.productProfiles[0]?.revision).toBe(1);
    expect(detail.confirmations.contact).toEqual({
      origin: "operator_confirmed",
      actorId: actor,
      confirmedAt: "2026-10-03T01:00:00.000Z",
    });
  });
  it("keeps collection rows and current facts in one snapshot across a concurrent commit", async () => {
    const id = await publish(1);
    const original = configuration.readUsPlanConfiguration;
    vi.spyOn(configuration, "readUsPlanConfiguration").mockImplementationOnce(
      async (tx, tenantId) => {
        const captured = await original(tx, tenantId);
        await fixture.db
          .update(schema.organization)
          .set({ name: "Concurrent name" })
          .where(eq(schema.organization.id, tenant));
        await draft(2);
        return captured;
      },
    );
    const list = await store.list(tenant, actor);
    expect(list.items.map((item) => item.id)).toEqual([id]);
    expect(list.effectiveImpact).toEqual({
      changedSections: [],
      changedLocationIds: [],
      changedProductIds: [],
    });
    vi.restoreAllMocks();
    expect((await store.list(tenant, actor)).items).toHaveLength(2);
  });
  it("keeps detail rows in the same snapshot as current facts across a concurrent draft edit", async () => {
    const row = await draft();
    const original = configuration.readUsPlanConfiguration;
    vi.spyOn(configuration, "readUsPlanConfiguration").mockImplementationOnce(
      async (tx, tenantId) => {
        const captured = await original(tx, tenantId);
        await fixture.db
          .update(schema.traceabilityPlanVersions)
          .set({
            sections: {
              ...sections,
              pointOfContact: { ...sections.pointOfContact, name: "Concurrent QA" },
            },
            draftRevision: 2,
          })
          .where(eq(schema.traceabilityPlanVersions.id, row.id));
        return captured;
      },
    );
    const detail = await store.get(tenant, actor, row.id);
    expect(detail).toMatchObject({
      status: "draft",
      draftRevision: 1,
      sections: { pointOfContact: { name: "QA" } },
    });
    vi.restoreAllMocks();
    expect(await store.get(tenant, actor, row.id)).toMatchObject({ draftRevision: 2 });
  });
  it("marks only an exactly verified seed draft synthetic", async () => {
    const owner = await new UsDevelopmentOwnerStore(fixture.db).provision(
      "synthetic-password-long",
      "seed",
    );
    tenant = owner.tenantId;
    actor = owner.userId;
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    const row = await draft();
    expect(await store.get(tenant, actor, row.id)).toMatchObject({
      provenance: "trusted_synthetic",
      statementOwnership: "operator_pending",
    });
    await publish(1, row, true);
    const frozen = await store.get(tenant, actor, row.id);
    expect(frozen).toMatchObject({
      provenance: "trusted_synthetic",
      confirmations: { contact: { origin: "synthetic_fixture" } },
    });
    expect(JSON.stringify(frozen)).not.toMatch(/trustedSeed|verifiedBy|seedId|objectKey/);
    await fixture.db
      .update(schema.organization)
      .set({ name: "Synthetic US development forged" })
      .where(eq(schema.organization.id, tenant));
    const next = await draft(2);
    expect(await store.get(tenant, actor, next.id)).toMatchObject({ provenance: "operational" });
    expect(await store.get(tenant, actor, row.id)).toMatchObject({
      provenance: "trusted_synthetic",
    });
    expect(JSON.stringify(await store.list(tenant, actor))).not.toMatch(
      /trustedSeed|verifiedBy|seedId/,
    );
  });
});
