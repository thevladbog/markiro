import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { canonicalExportDigest, validateLocationDescription } from "@markiro/domain";
import {
  createUsLocationSchema,
  createUsPartySchema,
  createUsProductSchema,
  putProductTraceabilityProfileSchema,
  referenceDocumentInputSchema,
} from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsDemoReferenceSeedStore } from "../src/modules/traceability/demo/us-demo-reference-seed";
import {
  makeUsDemoReferenceRecipe,
  parseUsDemoReferenceResult,
} from "../src/modules/traceability/demo/us-demo-reference-recipe";
import { UsDemoJournalStore } from "../src/modules/traceability/demo/us-demo-journal";
import type { UsDemoJournalContext } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsProfileStore } from "../src/modules/traceability/profile/us-profile-store";
import { createUsDemoJournalFixture } from "./support/us-demo-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const partyKeys = ["previous_source", "processor", "recipient"];
const numbers = [
  "ASN-2026-0914-001",
  "BOL-0914-A",
  "WO-2026-0915-APPLECUP",
  "BATCH-2026-0915-01",
  "BOL-0916-H",
  "INV-2026-0916-047",
];

describe("US reference recipe without database configuration", () => {
  it("produces complete service-valid synthetic inputs and civil dates", () => {
    const recipe = makeUsDemoReferenceRecipe();
    expect(recipe.parties.map((p) => p.key)).toEqual(partyKeys);
    expect(recipe.parties.map((p) => p.input)).toEqual([
      {
        name: "Orchard Slice Supply LLC",
        legalName: "Orchard Slice Supply LLC",
        contactPhone: "+1 509-555-0101",
        contactName: null,
        contactEmail: null,
        notes: null,
      },
      {
        name: "North River Fresh Foods LLC",
        legalName: "North River Fresh Foods LLC",
        contactPhone: "+1 503-555-0120",
        contactName: null,
        contactEmail: null,
        notes: null,
      },
      {
        name: "Harbor Market Distribution Center",
        legalName: "Harbor Market Distribution Center",
        contactPhone: "+1 206-555-0147",
        contactName: null,
        contactEmail: null,
        notes: null,
      },
    ]);
    for (const { input } of recipe.parties) expect(createUsPartySchema.parse(input)).toEqual(input);
    for (const { input } of recipe.locations) {
      expect(createUsLocationSchema.parse({ ...input, partyId: randomUUID() })).toMatchObject(
        input,
      );
      expect(validateLocationDescription(input, "export_ready")).toEqual([]);
      expect(input).toMatchObject({ addressKind: "street", latitude: null, longitude: null });
    }
    expect(
      recipe.locations.map((l) => [
        l.key,
        l.partyKey,
        l.input.name,
        l.input.businessName,
        l.input.phoneNumber,
      ]),
    ).toEqual([
      [
        "previous_source",
        "previous_source",
        "Orchard Slice Supply LLC",
        "Orchard Slice Supply LLC",
        "+1 509-555-0101",
      ],
      [
        "processor",
        "processor",
        "North River Fresh Foods LLC",
        "North River Fresh Foods LLC",
        "+1 503-555-0120",
      ],
      [
        "recipient",
        "recipient",
        "Harbor Market Distribution Center",
        "Harbor Market Distribution Center",
        "+1 206-555-0147",
      ],
    ]);
    expect(
      recipe.locations.map((l) => [
        l.input.streetAddress,
        l.input.city,
        l.input.stateOrRegion,
        l.input.zipOrPostalCode,
        l.input.countryCode,
        l.input.roles,
      ]),
    ).toEqual([
      ["100 Example Orchard Rd", "Yakima", "WA", "98901", "US", ["supplier", "tlc_source"]],
      [
        "500 Example River Pkwy",
        "Portland",
        "OR",
        "97203",
        "US",
        ["processor", "receive_at", "ship_from", "tlc_source"],
      ],
      ["200 Example Harbor Ave", "Seattle", "WA", "98134", "US", ["recipient"]],
    ]);
    expect(recipe.products.map((p) => p.input)).toEqual([
      { name: "Fresh-Cut Red Delicious Apple Slices", gtin: null },
      { name: "Fresh-Cut Apple Snack Cups", gtin: null },
    ]);
    expect(recipe.products.map((p) => [p.key, p.profile.productName, p.profile.brandName])).toEqual(
      [
        ["inbound", "Fresh-Cut Red Delicious Apple Slices", "Orchard Slice"],
        ["output", "Fresh-Cut Apple Snack Cups", "North River"],
      ],
    );
    for (const { input, profile } of recipe.products) {
      expect(createUsProductSchema.parse(input)).toEqual(input);
      expect(putProductTraceabilityProfileSchema.parse(profile)).toEqual(profile);
      expect(profile).toMatchObject({
        expectedRevision: 0,
        coverageStatus: "covered",
        commodity: "Apples",
        coverageRationale:
          "Synthetic demo manual review of a fresh-cut fruit fixture; not an operational assessment.",
        ftlCategory: "Fruits (fresh-cut)",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "markiro-us-synthetic-ftl-review-v1",
      });
    }
    expect(
      recipe.products.map((p) => [
        p.profile.variety,
        p.profile.packagingSizeValue,
        p.profile.packagingSizeUom,
        p.profile.packagingStyle,
        p.profile.defaultQuantityUom,
      ]),
    ).toEqual([
      ["Red Delicious", "10", "lb", "bag", "lb"],
      [null, "6", "oz", "cup, 24 cups/case", "case"],
    ]);
    expect(
      recipe.documents.map((d) => [d.input.number, d.input.type, d.input.issuedOn, d.partyKey]),
    ).toEqual([
      [numbers[0], "asn", "2026-09-14", "previous_source"],
      [numbers[1], "bol", "2026-09-14", "previous_source"],
      [numbers[2], "work_order", "2026-09-15", "processor"],
      [numbers[3], "batch_log", "2026-09-15", "processor"],
      [numbers[4], "bol", "2026-09-16", "recipient"],
      [numbers[5], "invoice", "2026-09-16", "recipient"],
    ]);
    for (const { input } of recipe.documents) {
      expect(referenceDocumentInputSchema.parse({ ...input, partyId: randomUUID() })).toMatchObject(
        input,
      );
      expect(input).toMatchObject({
        typeOtherLabel: null,
        notes: "Synthetic demo metadata only; no source attachment.",
      });
    }
  });
  it("returns fresh ordinary JSON without shared nested aliases and a deterministic digest", () => {
    const first = makeUsDemoReferenceRecipe();
    const second = makeUsDemoReferenceRecipe();
    expect(first).toEqual(second);
    expect(canonicalExportDigest(first)).toBe(canonicalExportDigest(second));
    expect(first).not.toBe(second);
    for (let i = 0; i < first.locations.length; i++) {
      expect(first.locations[i]?.input).not.toBe(second.locations[i]?.input);
      expect(first.locations[i]?.input.roles).not.toBe(second.locations[i]?.input.roles);
    }
    const mutable = structuredClone(first);
    mutable.locations[0]?.input.roles.pop();
    expect(makeUsDemoReferenceRecipe()).toEqual(second);
  });
});

describe.skipIf(!base)("US exact references on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDemoJournalFixture>>;
  let context: UsDemoJournalContext;
  let seed: UsDemoReferenceSeedStore;
  let journal: UsDemoJournalStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDemoJournalFixture(base);
    process.stdout.write(`Owned reference database: ${f.databaseName}\n`);
    seed = new UsDemoReferenceSeedStore(f.db);
    journal = new UsDemoJournalStore(f.db);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
  }, 60_000);
  afterAll(async () => {
    if (!f || !base) return;
    await f.close();
    const checker = createDb(base);
    try {
      expect(
        (
          await checker.pool.query("SELECT datname FROM pg_database WHERE datname = $1", [
            f.databaseName,
          ])
        ).rows,
      ).toEqual([]);
      process.stdout.write(`Disposed reference database verified absent: ${f.databaseName}\n`);
    } finally {
      await checker.pool.end();
    }
  });
  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
  }
  async function assertReferences() {
    const result = await seed.verify(context);
    expect(Object.keys(result.bindings.parties)).toEqual(partyKeys);
    expect(Object.keys(result.bindings.locations)).toEqual(partyKeys);
    expect(Object.keys(result.bindings.products)).toEqual(["inbound", "output"]);
    expect(Object.keys(result.bindings.documents)).toEqual([
      "receiving_asn",
      "receiving_bol",
      "transformation_work_order",
      "transformation_batch",
      "shipping_bol",
      "shipping_invoice",
    ]);
    expect(result.evidence.parties).toHaveLength(3);
    expect(result.evidence.locations).toHaveLength(3);
    expect(result.evidence.products).toHaveLength(2);
    expect(result.evidence.profiles).toHaveLength(2);
    expect(result.evidence.documents).toHaveLength(6);
    const recipe = makeUsDemoReferenceRecipe();
    for (const [i, party] of result.evidence.parties.entries())
      expect(party).toMatchObject({ ...recipe.parties[i]?.input, archived: false });
    for (const [i, location] of result.evidence.locations.entries()) {
      const item = recipe.locations[i];
      if (!item) throw new Error("Missing recipe location");
      expect(location).toMatchObject({
        ...item.input,
        partyId: result.bindings.parties[item.partyKey],
        archived: false,
        descriptionStatus: { exportReady: true, issues: [] },
      });
    }
    for (const [i, product] of result.evidence.products.entries())
      expect(product).toMatchObject({
        name: recipe.products[i]?.input.name,
        gtin14: null,
        archived: false,
      });
    for (const [i, profile] of result.evidence.profiles.entries()) {
      const command = recipe.products[i]?.profile;
      if (!command) throw new Error("Missing profile input");
      const { expectedRevision: _revision, ...editable } = command;
      expect(_revision).toBe(0);
      expect(profile).toMatchObject({
        ...editable,
        packagingSizeValue: i === 0 ? "10.000" : "6.000",
        productId: result.evidence.products[i]?.id,
        revision: 1,
        reviewedBy: context.actorUserId,
      });
      expect(profile.reviewedAt).toBe(profile.createdAt);
      expect(profile.updatedAt).toBe(profile.createdAt);
      expect(Number.isNaN(Date.parse(profile.reviewedAt ?? ""))).toBe(false);
    }
    expect(result.evidence.profiles.map((p) => p.defaultQuantityUom)).toEqual(["lb", "case"]);
    for (const [i, document] of result.evidence.documents.entries()) {
      const item = recipe.documents[i];
      if (!item) throw new Error("Missing recipe document");
      expect(document).toMatchObject({
        ...item.input,
        partyId: result.bindings.parties[item.partyKey],
        createdBy: context.actorUserId,
        archivedAt: null,
      });
    }
    const saved = await journal.read(context);
    expect(saved?.revision).toBe(3);
    expect(saved?.stages).toHaveLength(1);
    const stage = saved?.stages[0];
    expect(stage?.revision).toBe(2);
    expect(stage?.intent.input).toEqual(recipe);
    expect(stage?.intent.inputDigest).toBe(canonicalExportDigest(recipe));
    expect(stage?.receipt?.recordIds).toEqual(
      [
        ...result.evidence.parties,
        ...result.evidence.locations,
        ...result.evidence.products,
        ...result.evidence.documents,
      ].map((r) => r.id),
    );
    expect(new Set(stage?.receipt?.recordIds).size).toBe(14);
    expect(stage?.receipt?.result).toEqual(result);
    const audits = (await f.db.select().from(schema.tenantAuditEvents)).filter(
      (a) => a.action.startsWith("traceability.") && !a.action.startsWith("traceability.profile."),
    );
    expect(audits).toHaveLength(18);
    const expected = [
      ...result.evidence.parties.map((after) => ({
        action: "traceability.party.created",
        targetType: "traceability_party",
        targetId: after.id,
        before: null,
        after,
      })),
      ...result.evidence.locations.map(({ descriptionStatus: _status, ...after }) => ({
        action: "traceability.location.created",
        targetType: "traceability_location",
        targetId: after.id,
        before: null,
        after,
      })),
      ...result.evidence.products.map((after) => ({
        action: "traceability.product.created",
        targetType: "traceability_product",
        targetId: after.id,
        before: null,
        after,
      })),
      ...result.evidence.profiles.flatMap((after) =>
        [
          "traceability.product_profile.updated",
          "traceability.product_profile.coverage_changed",
        ].map((action) => ({
          action,
          targetType: "traceability_product_profile",
          targetId: after.productId,
          after,
          before: {
            productId: after.productId,
            productName: after.productName,
            revision: 0,
            brandName: null,
            commodity: null,
            variety: null,
            packagingSizeValue: null,
            packagingSizeUom: null,
            packagingStyle: null,
            defaultQuantityUom: null,
            coverageStatus: "unknown",
            coverageRationale: null,
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
            reviewedBy: null,
            reviewedAt: null,
            createdAt: null,
            updatedAt: null,
          },
        })),
      ),
      ...result.evidence.documents.map((after) => ({
        action: "traceability.reference_document.created",
        targetType: "traceability_reference_document",
        targetId: after.id,
        before: null,
        after,
      })),
    ];
    expect(
      audits.map(
        ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }) => ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }),
      ),
    ).toEqual(
      expect.arrayContaining(
        expected.map((e) => ({
          ...e,
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          outcome: "success",
          requestId: stage?.intent.operationKey,
        })),
      ),
    );
    for (const [table, count] of [
      ["traceability_parties", 3],
      ["traceability_locations", 3],
      ["products", 2],
      ["product_traceability_profiles", 2],
      ["reference_documents", 6],
    ] as const)
      expect((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(
        count,
      );
    return result;
  }
  it("creates only exact references and 18 complete audit facts; all replay rows stay unchanged", async () => {
    const baseline = await f.snapshot(false);
    const first = await seed.initialize(context);
    expect(await assertReferences()).toEqual(first);
    const after = await f.snapshot();
    expect(await seed.verify(context)).toEqual(first);
    expect(await seed.initialize(context)).toEqual(first);
    expect(await f.snapshot()).toEqual(after);
    const allowed = new Set([
      "traceability_parties",
      "traceability_locations",
      "products",
      "product_traceability_profiles",
      "reference_documents",
      "tenant_audit_events",
    ]);
    for (const [table, digest] of Object.entries(baseline))
      if (!allowed.has(table)) expect(after[table]).toBe(digest);
    process.stdout.write(
      `Reference replay full-row digests: ${JSON.stringify({ parties: after.traceability_parties, locations: after.traceability_locations, products: after.products, profiles: after.product_traceability_profiles, documents: after.reference_documents, audit: after.tenant_audit_events, header: after.traceability_demo_seeds, stage: after.traceability_demo_seed_stages })}\n`,
    );
  });
  it("concurrent initializers choose one immutable intent and create one complete dataset", async () => {
    const values = await Promise.all([
      seed.initialize(context),
      new UsDemoReferenceSeedStore(f.db).initialize(context),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(await assertReferences()).toEqual(values[0]);
  });
  it("recovers a discarded committed return from actual saved evidence", async () => {
    await seed.initialize(context);
    const before = await f.snapshot();
    const result = await seed.initialize(context);
    expect(await seed.verify(context)).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
  });
  it("keeps independent later references outside the owned receipt and leaves every row unchanged on replay", async () => {
    const first = await seed.initialize(context);
    const independent = await new UsMasterDataStore(f.db).createParty(
      context.tenantId,
      context.actorUserId,
      { name: "Independent synthetic owner record" },
      randomUUID(),
    );
    const before = await f.snapshot();
    expect(await seed.verify(context)).toEqual(first);
    expect(await seed.initialize(context)).toEqual(first);
    expect(first.evidence.parties.some((p) => p.id === independent.id)).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });
  it("reloads owner authority before an existing references receipt can be verified", async () => {
    await seed.initialize(context);
    await f.db.update(schema.member).set({ role: "traceability_qa" });
    await denied(() => seed.verify(context), "us_demo_target_invalid");
    await denied(() => seed.initialize(context), "us_demo_target_invalid");
  });
  it("verify never initializes header or captures intent or applies pending work", async () => {
    await denied(() => seed.verify(context), "us_demo_references_incomplete");
    const header = await journal.initialize(context);
    await denied(() => seed.verify(context), "us_demo_references_incomplete");
    const recipe = makeUsDemoReferenceRecipe();
    await journal.captureIntent(context, header.id, header.revision, {
      stage: "references",
      operationKey: randomUUID(),
      input: recipe,
      inputDigest: canonicalExportDigest(recipe),
    });
    await denied(() => seed.verify(context), "us_demo_references_incomplete");
  });
  it("rejects a different captured recipe without recapture or repair", async () => {
    const header = await journal.initialize(context);
    const changed = { ...makeUsDemoReferenceRecipe(), definitionDigest: "a".repeat(64) };
    await journal.captureIntent(context, header.id, header.revision, {
      stage: "references",
      operationKey: randomUUID(),
      input: changed,
      inputDigest: canonicalExportDigest(changed),
    });
    await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    await denied(() => seed.verify(context), "us_demo_reference_mismatch");
  });
  it.each(["parties", "locations", "products", "profiles", "documents"] as const)(
    "refuses unowned %s including identical names/numbers",
    async (kind) => {
      const recipe = makeUsDemoReferenceRecipe();
      if (kind === "parties")
        await new UsMasterDataStore(f.db).createParty(
          context.tenantId,
          context.actorUserId,
          recipe.parties[0]?.input,
          randomUUID(),
        );
      if (kind === "locations") {
        const party = await new UsMasterDataStore(f.db).createParty(
          context.tenantId,
          context.actorUserId,
          recipe.parties[0]?.input,
          randomUUID(),
        );
        await new UsMasterDataStore(f.db).createLocation(
          context.tenantId,
          context.actorUserId,
          { ...recipe.locations[0]?.input, partyId: party.id },
          randomUUID(),
        );
      }
      if (kind === "products" || kind === "profiles") {
        const product = await new UsCatalogStore(f.db).createProduct(
          context.tenantId,
          context.actorUserId,
          recipe.products[0]?.input,
          randomUUID(),
        );
        if (kind === "profiles")
          await new UsProductProfileStore(f.db).putProfile(
            context.tenantId,
            context.actorUserId,
            product.id,
            recipe.products[0]?.profile,
            randomUUID(),
          );
      }
      if (kind === "documents")
        await new UsReferenceDocumentStore(f.db).createDocument(
          context.tenantId,
          context.actorUserId,
          { ...recipe.documents[0]?.input, partyId: null },
          randomUUID(),
        );
      const before = await f.snapshot(false);
      await expect(seed.initialize(context)).rejects.toThrow("us_demo_reference_collision");
      expect(await f.snapshot(false)).toEqual(before);
      const saved = await journal.read(context);
      expect(saved?.stages[0]?.receipt).toBeNull();
      await denied(() => seed.initialize(context), "us_demo_reference_collision");
    },
  );
  it.each(["party", "location", "product", "profile", "document"] as const)(
    "rejects edited canonical %s without repair",
    async (kind) => {
      const result = await seed.initialize(context);
      if (kind === "party")
        await f.db.update(schema.traceabilityParties).set({ contactPhone: "+1 509-555-0199" });
      if (kind === "location")
        await f.db.update(schema.traceabilityLocations).set({ city: "Edited city" });
      if (kind === "product") await f.db.update(schema.products).set({ name: "Edited product" });
      if (kind === "profile")
        await f.db.update(schema.productTraceabilityProfiles).set({ brandName: "Edited brand" });
      if (kind === "document")
        await f.db.update(schema.referenceDocuments).set({ notes: "Edited metadata" });
      expect(result.recipeVersion).toBe(1);
      await denied(() => seed.verify(context), "us_demo_reference_mismatch");
      await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    },
  );
  it.each(["party", "location", "product", "profile", "document"] as const)(
    "rejects missing canonical %s without recreating it",
    async (kind) => {
      await seed.initialize(context);
      if (kind === "party") {
        await f.db.delete(schema.referenceDocuments);
        await f.db.delete(schema.traceabilityLocations);
        await f.db.delete(schema.traceabilityParties);
      }
      if (kind === "location") await f.db.delete(schema.traceabilityLocations);
      if (kind === "product") {
        await f.db.delete(schema.productTraceabilityProfiles);
        await f.db.delete(schema.products);
      }
      if (kind === "profile") await f.db.delete(schema.productTraceabilityProfiles);
      if (kind === "document") await f.db.delete(schema.referenceDocuments);
      await denied(() => seed.verify(context), "us_demo_reference_mismatch");
      await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    },
  );
  it.each(["party", "location", "product", "profile", "document"] as const)(
    "rejects archived canonical %s without restoring it",
    async (kind) => {
      await seed.initialize(context);
      if (kind === "party") await f.db.update(schema.traceabilityParties).set({ archived: true });
      if (kind === "location")
        await f.db.update(schema.traceabilityLocations).set({ archived: true });
      if (kind === "product" || kind === "profile")
        await f.db.update(schema.products).set({ archived: true });
      if (kind === "document")
        await f.db.update(schema.referenceDocuments).set({ archivedAt: new Date() });
      await denied(() => seed.verify(context), "us_demo_reference_mismatch");
      await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    },
  );
  it.each(["party", "location", "product", "profile", "document"] as const)(
    "rejects cross-tenant %s binding even with recomputed receipt digest",
    async (kind) => {
      const result = await seed.initialize(context);
      const tenant = randomUUID();
      await f.db.insert(schema.organization).values({
        id: tenant,
        name: "Synthetic foreign references",
        slug: tenant,
        createdAt: new Date(),
      });
      await f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: tenant,
        userId: context.actorUserId,
        role: "owner",
        createdAt: new Date(),
      });
      await new UsProfileStore(f.db).provision(
        tenant,
        context.actorUserId,
        { code: "US_FSMA204_PROCESSOR", timeZone: "America/Los_Angeles" },
        randomUUID(),
      );
      const recipe = makeUsDemoReferenceRecipe();
      const foreignParty = await new UsMasterDataStore(f.db).createParty(
        tenant,
        context.actorUserId,
        recipe.parties[0]?.input,
        randomUUID(),
      );
      const changed = {
        recipeVersion: result.recipeVersion,
        bindings: {
          parties: { ...result.bindings.parties },
          locations: { ...result.bindings.locations },
          products: { ...result.bindings.products },
          documents: { ...result.bindings.documents },
        },
        evidence: {
          parties: [...result.evidence.parties],
          locations: [...result.evidence.locations],
          products: [...result.evidence.products],
          profiles: [...result.evidence.profiles],
          documents: [...result.evidence.documents],
        },
      };
      if (kind === "party") {
        changed.bindings.parties.previous_source = foreignParty.id;
        changed.evidence.parties[0] = foreignParty;
      }
      if (kind === "location") {
        const foreign = await new UsMasterDataStore(f.db).createLocation(
          tenant,
          context.actorUserId,
          { ...recipe.locations[0]?.input, partyId: foreignParty.id },
          randomUUID(),
        );
        changed.bindings.locations.previous_source = foreign.id;
        changed.evidence.locations[0] = foreign;
      }
      if (kind === "product" || kind === "profile") {
        const foreign = await new UsCatalogStore(f.db).createProduct(
          tenant,
          context.actorUserId,
          recipe.products[0]?.input,
          randomUUID(),
        );
        const profile = await new UsProductProfileStore(f.db).putProfile(
          tenant,
          context.actorUserId,
          foreign.id,
          recipe.products[0]?.profile,
          randomUUID(),
        );
        changed.bindings.products.inbound = foreign.id;
        changed.evidence.products[0] = foreign;
        changed.evidence.profiles[0] = profile;
      }
      if (kind === "document") {
        const foreign = await new UsReferenceDocumentStore(f.db).createDocument(
          tenant,
          context.actorUserId,
          { ...recipe.documents[0]?.input, partyId: foreignParty.id },
          randomUUID(),
        );
        changed.bindings.documents.receiving_asn = foreign.id;
        changed.evidence.documents[0] = foreign;
      }
      const recordIds = [
        ...changed.evidence.parties,
        ...changed.evidence.locations,
        ...changed.evidence.products,
        ...changed.evidence.documents,
      ].map((r) => r.id);
      await f.db.update(schema.traceabilityDemoSeedStages).set({
        receipt: { recordIds, result: changed, resultDigest: canonicalExportDigest(changed) },
      });
      await denied(() => seed.verify(context), "us_demo_reference_mismatch");
      await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    },
  );
  it.each([
    "extra binding",
    "duplicate id",
    "missing evidence",
    "extra result",
    "wrong profile id",
  ])("codec rejects %s in actual service evidence", async (kind) => {
    const result = await seed.initialize(context);
    const raw: Record<string, unknown> = structuredClone(result);
    if (kind === "extra binding")
      raw.bindings = {
        ...result.bindings,
        parties: { ...result.bindings.parties, extra: randomUUID() },
      };
    if (kind === "duplicate id")
      raw.bindings = {
        ...result.bindings,
        locations: {
          ...result.bindings.locations,
          previous_source: result.bindings.parties.previous_source,
        },
      };
    if (kind === "missing evidence")
      raw.evidence = { ...result.evidence, documents: result.evidence.documents.slice(1) };
    if (kind === "extra result") raw.extra = true;
    if (kind === "wrong profile id")
      raw.evidence = {
        ...result.evidence,
        profiles: result.evidence.profiles.map((p, i) =>
          i === 0 ? { ...p, productId: randomUUID() } : p,
        ),
      };
    expect(() => parseUsDemoReferenceResult(raw)).toThrow("us_demo_reference_mismatch");
  });
  it.each(["reordered", "missing", "additional"])(
    "rejects %s receipt record IDs even when receipt result digest remains valid",
    async (kind) => {
      await seed.initialize(context);
      const stage = (await journal.read(context))?.stages[0];
      if (!stage?.receipt) throw new Error("Missing actual receipt");
      const recordIds = [...stage.receipt.recordIds];
      if (kind === "reordered") recordIds.reverse();
      if (kind === "missing") recordIds.pop();
      if (kind === "additional") recordIds.push(randomUUID());
      await f.db
        .update(schema.traceabilityDemoSeedStages)
        .set({ receipt: { ...stage.receipt, recordIds } });
      await denied(() => seed.verify(context), "us_demo_reference_mismatch");
      await denied(() => seed.initialize(context), "us_demo_reference_mismatch");
    },
  );
  it.each(["after several creates", "receipt write"])(
    "rolls back business and audit on %s while preserving intent for retry",
    async (kind) => {
      await f.pool.query(
        "CREATE FUNCTION synthetic_reference_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_reference_failure'; END $$",
      );
      const table = kind === "receipt write" ? "traceability_demo_seed_stages" : "products";
      await f.pool.query(
        `CREATE TRIGGER synthetic_reference_failure BEFORE ${kind === "receipt write" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_reference_failure()`,
      );
      const before = await f.snapshot(false);
      try {
        await expect(seed.initialize(context)).rejects.toMatchObject({ cause: { code: "P0001" } });
        expect(await f.snapshot(false)).toEqual(before);
        const saved = await journal.read(context);
        expect(saved?.revision).toBe(2);
        expect(saved?.stages[0]?.receipt).toBeNull();
        const after = await f.snapshot();
        await expect(seed.initialize(context)).rejects.toMatchObject({ cause: { code: "P0001" } });
        expect(await f.snapshot()).toEqual(after);
      } finally {
        await f.pool.query(`DROP TRIGGER synthetic_reference_failure ON ${table}`);
        await f.pool.query("DROP FUNCTION synthetic_reference_failure()");
      }
      await seed.initialize(context);
      await assertReferences();
    },
  );
  it("propagates current canonical read driver failure without treating it as replay success", async () => {
    await seed.initialize(context);
    await f.pool.query(
      "ALTER TABLE reference_documents RENAME TO synthetic_hidden_reference_documents",
    );
    try {
      const before = await f.snapshot();
      await expect(seed.verify(context)).rejects.toMatchObject({ cause: { code: "42P01" } });
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.pool.query(
        "ALTER TABLE synthetic_hidden_reference_documents RENAME TO reference_documents",
      );
    }
  });
});
