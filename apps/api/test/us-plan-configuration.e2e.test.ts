import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readUsPlanConfiguration } from "../src/modules/traceability/plans/us-plan-configuration";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!url)("US plan configuration in disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let tenantId: string;
  let otherTenantId: string;
  let locationIds: string[];
  let productIds: string[];
  let partyId: string;
  const read = () =>
    fixture.db.transaction((tx) => readUsPlanConfiguration(tx, tenantId), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    locationIds = [randomUUID(), randomUUID()].sort();
    productIds = [randomUUID(), randomUUID()].sort();
    partyId = randomUUID();
    for (const id of [tenantId, otherTenantId]) {
      await fixture.db.insert(schema.organization).values({
        id,
        name: id === tenantId ? "Synthetic plan foods" : "Other foods",
        slug: id,
        createdAt: new Date(),
      });
      await fixture.db.insert(schema.traceabilityProfiles).values({
        tenantId: id,
        code: "US_FSMA204_PROCESSOR",
        baselineVersion: "US-REG-2026-09-03",
        retentionYears: id === tenantId ? 5 : 7,
      });
      await fixture.db.insert(schema.orgProfiles).values({
        tenantId: id,
        timeZone: id === tenantId ? "America/Chicago" : "America/New_York",
      });
      const party = id === tenantId ? partyId : randomUUID();
      await fixture.db
        .insert(schema.traceabilityParties)
        .values({ id: party, tenantId: id, name: "Synthetic party" });
      for (const [index, locationId] of (id === tenantId
        ? [...locationIds].reverse()
        : [randomUUID()]
      ).entries()) {
        await fixture.db.insert(schema.traceabilityLocations).values({
          id: locationId,
          tenantId: id,
          partyId: party,
          name: `Source ${index}`,
          businessName: "Synthetic source",
          phoneNumber: "+1 555-0100",
          streetAddress: "10 Main St",
          city: "Chicago",
          stateOrRegion: "IL",
          zipOrPostalCode: "60601",
          countryCode: "US",
          roles: ["tlc_source", "processor"],
        });
      }
      await fixture.db.insert(schema.traceabilityLocations).values([
        {
          tenantId: id,
          partyId: party,
          name: "Archived source",
          businessName: "Archived",
          roles: ["tlc_source"],
          archived: true,
        },
        {
          tenantId: id,
          partyId: party,
          name: "Other role",
          businessName: "Recipient",
          roles: ["recipient"],
        },
      ]);
      for (const productId of id === tenantId ? [...productIds].reverse() : [randomUUID()]) {
        await fixture.db
          .insert(schema.products)
          .values({ id: productId, tenantId: id, name: "Synthetic product" });
        await fixture.db.insert(schema.productTraceabilityProfiles).values({
          tenantId: id,
          productId,
          productName: "Synthetic product",
          revision: 3,
          coverageStatus: "unknown",
        });
      }
    }
  });

  it("reads exact tenant facts in stable ID order and excludes archived/non-source locations", async () => {
    const result = await read();
    expect(result.facts).toEqual({
      tenantName: "Synthetic plan foods",
      profileCode: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      timeZone: "America/Chicago",
      retentionYears: 5,
      tlcSourceLocations: locationIds.map((id) => ({
        id,
        description: {
          partyId,
          businessName: "Synthetic source",
          phoneNumber: "+1 555-0100",
          addressKind: "street",
          streetAddress: "10 Main St",
          latitude: null,
          longitude: null,
          city: "Chicago",
          stateOrRegion: "IL",
          zipOrPostalCode: "60601",
          countryCode: "US",
        },
      })),
      productProfiles: productIds.map((productId) => ({
        productId,
        revision: 3,
        coverageStatus: "unknown",
      })),
    });
    expect(result.digest).toBe(canonicalExportDigest(result.facts));
    expect(await read()).toEqual(result);
    const other = await fixture.db.transaction((tx) => readUsPlanConfiguration(tx, otherTenantId), {
      isolationLevel: "repeatable read",
    });
    expect(other.facts.tenantName).toBe("Other foods");
    expect(other.facts.retentionYears).toBe(7);
    expect(other.facts.productProfiles).toHaveLength(1);
    expect(other.digest).not.toBe(result.digest);
  });

  it.each(["streetAddress", "phoneNumber"] as const)(
    "changes digest for one %s edit and preserves incomplete active sources",
    async (field) => {
      const before = await read();
      await fixture.db
        .update(schema.traceabilityLocations)
        .set({ [field]: null })
        .where(
          and(
            eq(schema.traceabilityLocations.tenantId, tenantId),
            eq(schema.traceabilityLocations.id, locationIds[0] ?? ""),
          ),
        );
      const after = await read();
      expect(after.facts.tlcSourceLocations).toHaveLength(2);
      expect(after.facts.tlcSourceLocations[0]?.description[field]).toBeNull();
      expect(after.digest).not.toBe(before.digest);
      expect(after.facts.productProfiles).toEqual(before.facts.productProfiles);
    },
  );

  it("observes one caller-owned snapshot across concurrent configuration updates", async () => {
    const before = await read();
    await fixture.db.transaction(
      async (tx) => {
        expect(await readUsPlanConfiguration(tx, tenantId)).toEqual(before);
        await fixture.db
          .update(schema.productTraceabilityProfiles)
          .set({ revision: 4 })
          .where(
            and(
              eq(schema.productTraceabilityProfiles.tenantId, tenantId),
              eq(schema.productTraceabilityProfiles.productId, productIds[0] ?? ""),
            ),
          );
        expect(await readUsPlanConfiguration(tx, tenantId)).toEqual(before);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    const after = await read();
    expect(after.facts.productProfiles[0]?.revision).toBe(4);
    expect(after.digest).not.toBe(before.digest);
  });

  it("preserves decimal text and observes every configured fact from the same statement", async () => {
    const before = await read();
    const nextParty = randomUUID();
    await fixture.db.transaction(async (tx) => {
      await tx
        .insert(schema.traceabilityParties)
        .values({ id: nextParty, tenantId, name: "Next party" });
      await tx
        .update(schema.organization)
        .set({ name: "Next tenant" })
        .where(eq(schema.organization.id, tenantId));
      await tx
        .update(schema.traceabilityProfiles)
        .set({ baselineVersion: "US-REG-2026-10-03", retentionYears: 7 })
        .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
      await tx
        .update(schema.orgProfiles)
        .set({ timeZone: "America/New_York" })
        .where(eq(schema.orgProfiles.tenantId, tenantId));
      await tx
        .update(schema.traceabilityLocations)
        .set({
          partyId: nextParty,
          businessName: "Next source",
          phoneNumber: "+1 555-0199",
          addressKind: "coordinates",
          streetAddress: null,
          latitude: "40.123456",
          longitude: "-74.100000",
          city: "New York",
          stateOrRegion: "NY",
          zipOrPostalCode: "10001",
          countryCode: "CA",
        })
        .where(eq(schema.traceabilityLocations.tenantId, tenantId));
      await tx
        .update(schema.productTraceabilityProfiles)
        .set({
          revision: 4,
          coverageStatus: "covered",
          reviewedBy: "synthetic-reviewer",
          reviewedAt: new Date("2026-10-02T12:00:00Z"),
        })
        .where(eq(schema.productTraceabilityProfiles.tenantId, tenantId));
    });
    const after = await read();
    expect(after.facts).toEqual({
      tenantName: "Next tenant",
      profileCode: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-10-03",
      retentionYears: 7,
      timeZone: "America/New_York",
      tlcSourceLocations: locationIds.map((id) => ({
        id,
        description: {
          partyId: nextParty,
          businessName: "Next source",
          phoneNumber: "+1 555-0199",
          addressKind: "coordinates",
          streetAddress: null,
          latitude: "40.123456",
          longitude: "-74.100000",
          city: "New York",
          stateOrRegion: "NY",
          zipOrPostalCode: "10001",
          countryCode: "CA",
        },
      })),
      productProfiles: productIds.map((productId) => ({
        productId,
        revision: 4,
        coverageStatus: "covered",
      })),
    });
    expect(after.digest).toBe(canonicalExportDigest(after.facts));
    expect(after.digest).not.toBe(before.digest);
  });

  it("returns empty arrays when all configured collection members are removed", async () => {
    const before = await read();
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ archived: true })
      .where(eq(schema.traceabilityLocations.tenantId, tenantId));
    await fixture.db
      .delete(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.tenantId, tenantId));
    const after = await read();
    expect(after.facts.tlcSourceLocations).toEqual([]);
    expect(after.facts.productProfiles).toEqual([]);
    expect(after.digest).not.toBe(before.digest);
  });

  it("fails closed for a processor configuration lacking a baseline", async () => {
    // Corrupt-storage specimen only in this invocation's owned disposable DB.
    await fixture.pool.query(
      "ALTER TABLE traceability_profiles DROP CONSTRAINT traceability_profiles_baseline_for_us",
    );
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ baselineVersion: null })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(read()).rejects.toMatchObject({
      response: { code: "us_plan_configuration_invalid" },
    });
  });
});
