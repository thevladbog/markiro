import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { createUsDemoJournalFixture } from "./support/us-demo-journal-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const reviewed = {
  productName: "Synthetic Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSizeValue: "6",
  packagingSizeUom: "oz",
  packagingStyle: "cup",
  defaultQuantityUom: "case",
  coverageStatus: "covered",
  coverageRationale: "Synthetic review",
  ftlCategory: "Fruits (fresh-cut)",
  ftlSourceUrl: "https://example.test/ftl",
  ftlSourceVersion: "synthetic-v1",
  expectedRevision: 0,
};
const documentInput = (partyId: string | null) => ({
  type: "bol",
  typeOtherLabel: null,
  number: "Synthetic BOL",
  partyId,
  issuedOn: "2026-10-06",
  notes: null,
});

describe.skipIf(!url)("US reference transaction seams on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDemoJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  let master: UsMasterDataStore;
  let catalog: UsCatalogStore;
  let profiles: UsProductProfileStore;
  let documents: UsReferenceDocumentStore;

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsDemoJournalFixture(url);
    console.info(`Owned seam database: ${f.databaseName}`);
    master = new UsMasterDataStore(f.db);
    catalog = new UsCatalogStore(f.db);
    profiles = new UsProductProfileStore(f.db);
    documents = new UsReferenceDocumentStore(f.db);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
  });
  afterAll(async () => {
    if (!f || !url) return;
    await f.close();
    const verifier = createDb(url);
    try {
      const remaining = await verifier.pool.query(
        "SELECT datname FROM pg_database WHERE datname = $1",
        [f.databaseName],
      );
      expect(remaining.rows).toEqual([]);
      console.info(`Disposed seam database verified absent: ${f.databaseName}`);
    } finally {
      await verifier.pool.end();
    }
  });

  const setRole = (role: string) =>
    f.db
      .update(schema.member)
      .set({ role })
      .where(
        and(
          eq(schema.member.organizationId, context.tenantId),
          eq(schema.member.userId, context.actorUserId),
        ),
      );

  async function createReferences(tx: UsMasterDataTransaction) {
    const { tenantId, actorUserId } = context;
    const party = await master.createPartyInTransaction(
      tx,
      tenantId,
      actorUserId,
      { name: " Synthetic atomic seam " },
      "party-seam",
    );
    const location = await master.createLocationInTransaction(
      tx,
      tenantId,
      actorUserId,
      { partyId: party.id, name: "Synthetic Dock", businessName: "Synthetic Dock" },
      "location-seam",
    );
    const product = await catalog.createProductInTransaction(
      tx,
      tenantId,
      actorUserId,
      { name: "Synthetic Catalog", gtin: "036000291452" },
      "product-seam",
    );
    const defaults = await profiles.getProfileInTransaction(tx, tenantId, actorUserId, product.id);
    expect(defaults).toMatchObject({
      productId: product.id,
      productName: "Synthetic Catalog",
      revision: 0,
    });
    const profile = await profiles.putProfileInTransaction(
      tx,
      tenantId,
      actorUserId,
      product.id,
      reviewed,
      "profile-seam",
    );
    const document = await documents.createDocumentInTransaction(
      tx,
      tenantId,
      actorUserId,
      documentInput(party.id),
      "document-seam",
    );
    expect(await master.getPartyInTransaction(tx, tenantId, actorUserId, party.id)).toEqual(party);
    expect(await master.getLocationInTransaction(tx, tenantId, actorUserId, location.id)).toEqual(
      location,
    );
    expect(await catalog.getProductInTransaction(tx, tenantId, actorUserId, product.id)).toEqual(
      product,
    );
    expect(await profiles.getProfileInTransaction(tx, tenantId, actorUserId, product.id)).toEqual(
      profile,
    );
    expect(
      await documents.getDocumentInTransaction(tx, tenantId, actorUserId, document.id),
    ).toEqual(document);
    expect(party.name).toBe("Synthetic atomic seam");
    expect(product.gtin14).toBe("00036000291452");
    expect(profile).toMatchObject({
      packagingSizeValue: "6.000",
      reviewedBy: actorUserId,
      revision: 1,
    });
    expect(
      await profiles.putProfileInTransaction(
        tx,
        tenantId,
        actorUserId,
        product.id,
        reviewed,
        "profile-retry",
      ),
    ).toEqual(profile);
    return { party, location, product, profile, document, defaults };
  }

  it.each(["owner", "traceability_qa"])(
    "commits exact same-transaction references and ordinary audits for %s",
    async (role) => {
      await setRole(role);
      const priorAudits = await f.db
        .select({ id: schema.tenantAuditEvents.id })
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, context.tenantId));
      const priorAuditIds = new Set(priorAudits.map(({ id }) => id));
      const { party, location, product, profile, document, defaults } =
        await f.db.transaction(createReferences);
      const { descriptionStatus, ...locationSnapshot } = location;
      expect(descriptionStatus.exportReady).toBe(false);
      const expected = [
        ["traceability.party.created", "traceability_party", party.id, "party-seam", null, party],
        [
          "traceability.location.created",
          "traceability_location",
          location.id,
          "location-seam",
          null,
          locationSnapshot,
        ],
        [
          "traceability.product.created",
          "traceability_product",
          product.id,
          "product-seam",
          null,
          product,
        ],
        [
          "traceability.product_profile.updated",
          "traceability_product_profile",
          product.id,
          "profile-seam",
          defaults,
          profile,
        ],
        [
          "traceability.product_profile.coverage_changed",
          "traceability_product_profile",
          product.id,
          "profile-seam",
          defaults,
          profile,
        ],
        [
          "traceability.reference_document.created",
          "traceability_reference_document",
          document.id,
          "document-seam",
          null,
          document,
        ],
      ];
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, context.tenantId),
            eq(schema.tenantAuditEvents.actorUserId, context.actorUserId),
          ),
        );
      const referenceAudits = audits.filter(({ id }) => !priorAuditIds.has(id));
      expect(referenceAudits).toHaveLength(6);
      for (const [action, targetType, targetId, requestId, before, after] of expected) {
        expect(referenceAudits).toContainEqual(
          expect.objectContaining({
            organizationId: context.tenantId,
            actorUserId: context.actorUserId,
            action,
            targetType,
            targetId,
            requestId,
            outcome: "success",
            before,
            after,
          }),
        );
      }
      expect(await master.getParty(context.tenantId, context.actorUserId, party.id)).toEqual(party);
      expect(await master.getLocation(context.tenantId, context.actorUserId, location.id)).toEqual(
        location,
      );
      expect(await catalog.getProduct(context.tenantId, context.actorUserId, product.id)).toEqual(
        product,
      );
      expect(await profiles.getProfile(context.tenantId, context.actorUserId, product.id)).toEqual(
        profile,
      );
      expect(
        await documents.getDocument(context.tenantId, context.actorUserId, document.id),
      ).toEqual(document);
    },
  );

  it("rolls back every reference and audit after an outer abort", async () => {
    const before = await f.snapshot(false);
    await expect(
      f.db.transaction(async (tx) => {
        await createReferences(tx);
        throw new Error("synthetic_abort");
      }),
    ).rejects.toThrow("synthetic_abort");
    expect(await f.snapshot(false)).toEqual(before);
  });

  it("propagates a real audit trigger failure and rolls back all prior transaction writes", async () => {
    await f.pool
      .query(`CREATE FUNCTION synthetic_seam_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'traceability.reference_document.created' THEN
        RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$`);
    await f.pool
      .query(`CREATE TRIGGER synthetic_seam_audit_failure BEFORE INSERT ON tenant_audit_events
      FOR EACH ROW EXECUTE FUNCTION synthetic_seam_audit_failure()`);
    try {
      const before = await f.snapshot(false);
      await expect(f.db.transaction(createReferences)).rejects.toMatchObject({
        cause: { message: "synthetic_audit_failure" },
      });
      expect(await f.snapshot(false)).toEqual(before);
    } finally {
      await f.pool.query("DROP TRIGGER synthetic_seam_audit_failure ON tenant_audit_events");
      await f.pool.query("DROP FUNCTION synthetic_seam_audit_failure()");
    }
  });

  it("denies Auditor writes at every transaction seam without changing data", async () => {
    const product = await catalog.createProduct(
      context.tenantId,
      context.actorUserId,
      { name: "Existing" },
      "setup",
    );
    await setRole("traceability_auditor");
    const before = await f.snapshot(false);
    const { tenantId, actorUserId } = context;
    const writes: ((tx: UsMasterDataTransaction) => Promise<unknown>)[] = [
      (tx: UsMasterDataTransaction) =>
        master.createPartyInTransaction(tx, tenantId, actorUserId, { name: "Denied" }, "denied"),
      (tx: UsMasterDataTransaction) =>
        master.createLocationInTransaction(
          tx,
          tenantId,
          actorUserId,
          { partyId: randomUUID(), name: "Denied", businessName: "Denied" },
          "denied",
        ),
      (tx: UsMasterDataTransaction) =>
        catalog.createProductInTransaction(tx, tenantId, actorUserId, { name: "Denied" }, "denied"),
      (tx: UsMasterDataTransaction) =>
        profiles.putProfileInTransaction(tx, tenantId, actorUserId, product.id, reviewed, "denied"),
      (tx: UsMasterDataTransaction) =>
        documents.createDocumentInTransaction(
          tx,
          tenantId,
          actorUserId,
          documentInput(null),
          "denied",
        ),
    ];
    for (const write of writes)
      await expect(f.db.transaction(write)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
    expect(await f.snapshot(false)).toEqual(before);
  });

  it("rejects cross-tenant and archived party parents through transaction seams", async () => {
    const { tenantId, actorUserId } = context;
    const foreignTenant = randomUUID();
    const foreignParty = randomUUID();
    await f.db.insert(schema.organization).values({
      id: foreignTenant,
      name: "Synthetic foreign",
      slug: foreignTenant,
      createdAt: new Date(),
    });
    await f.db
      .insert(schema.traceabilityParties)
      .values({ id: foreignParty, tenantId: foreignTenant, name: "Foreign" });
    const archived = await master.createParty(tenantId, actorUserId, { name: "Archived" }, "setup");
    await master.updateParty(tenantId, actorUserId, archived.id, { archived: true }, "archive");
    const before = await f.snapshot(false);
    for (const [partyId, status, code] of [
      [foreignParty, 404, "party_not_found"],
      [archived.id, 403, "party_archived"],
    ] as const) {
      await expect(
        f.db.transaction((tx) =>
          master.createLocationInTransaction(
            tx,
            tenantId,
            actorUserId,
            { partyId, name: "Denied", businessName: "Denied" },
            "parent",
          ),
        ),
      ).rejects.toMatchObject({ status, response: { code } });
      await expect(
        f.db.transaction((tx) =>
          documents.createDocumentInTransaction(
            tx,
            tenantId,
            actorUserId,
            documentInput(partyId),
            "parent",
          ),
        ),
      ).rejects.toMatchObject({ status: 404, response: { code: "party_not_found" } });
    }
    expect(await f.snapshot(false)).toEqual(before);
  });

  it("retains duplicate translation and aborts the complete outer transaction", async () => {
    const { tenantId, actorUserId } = context;
    const saved = await f.db.transaction(createReferences);
    const before = await f.snapshot(false);
    const conflicts = [
      {
        code: "party_name_taken",
        write: (tx: UsMasterDataTransaction) =>
          master.createPartyInTransaction(
            tx,
            tenantId,
            actorUserId,
            { name: saved.party.name },
            "duplicate",
          ),
      },
      {
        code: "product_gtin_taken",
        write: (tx: UsMasterDataTransaction) =>
          catalog.createProductInTransaction(
            tx,
            tenantId,
            actorUserId,
            { name: "Duplicate", gtin: saved.product.gtin14 },
            "duplicate",
          ),
      },
      {
        code: "document_duplicate",
        write: (tx: UsMasterDataTransaction) =>
          documents.createDocumentInTransaction(
            tx,
            tenantId,
            actorUserId,
            documentInput(saved.party.id),
            "duplicate",
          ),
      },
    ];
    for (const { code, write } of conflicts) {
      await expect(
        f.db.transaction(async (tx) => {
          await master.createPartyInTransaction(
            tx,
            tenantId,
            actorUserId,
            { name: "Must roll back" },
            "prior-write",
          );
          await write(tx);
        }),
      ).rejects.toMatchObject({ status: 409, response: { code } });
      expect(await f.snapshot(false)).toEqual(before);
    }
  });

  it("keeps product-profile parents tenant scoped while allowing archived catalog descriptions", async () => {
    const { tenantId, actorUserId } = context;
    const foreignTenant = randomUUID();
    const foreignProduct = randomUUID();
    await f.db.insert(schema.organization).values({
      id: foreignTenant,
      name: "Synthetic foreign",
      slug: foreignTenant,
      createdAt: new Date(),
    });
    await f.db.insert(schema.products).values({
      id: foreignProduct,
      tenantId: foreignTenant,
      name: "Foreign product",
    });
    const before = await f.snapshot(false);
    await expect(
      f.db.transaction((tx) =>
        profiles.getProfileInTransaction(tx, tenantId, actorUserId, foreignProduct),
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "product_not_found" } });
    await expect(
      f.db.transaction((tx) =>
        profiles.putProfileInTransaction(
          tx,
          tenantId,
          actorUserId,
          foreignProduct,
          reviewed,
          "foreign-profile",
        ),
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "product_not_found" } });
    expect(await f.snapshot(false)).toEqual(before);
    const product = await catalog.createProduct(
      tenantId,
      actorUserId,
      { name: "Archived product" },
      "setup",
    );
    await catalog.updateProduct(tenantId, actorUserId, product.id, { archived: true }, "archive");
    const saved = await f.db.transaction((tx) =>
      profiles.putProfileInTransaction(
        tx,
        tenantId,
        actorUserId,
        product.id,
        reviewed,
        "archived-description",
      ),
    );
    expect(saved).toMatchObject({ productId: product.id, revision: 1, coverageStatus: "covered" });
    expect(await profiles.getProfile(tenantId, actorUserId, product.id)).toEqual(saved);
  });

  it("keeps malformed profile input precedence before permission checks on public and transaction paths", async () => {
    const { tenantId, actorUserId } = context;
    const product = await catalog.createProduct(
      tenantId,
      actorUserId,
      { name: "Existing" },
      "setup",
    );
    await setRole("traceability_auditor");
    const before = await f.snapshot(false);
    await expect(
      profiles.putProfile(tenantId, actorUserId, product.id, {}, "invalid"),
    ).rejects.toMatchObject({ status: 400, response: { code: "invalid_master_data" } });
    await expect(
      f.db.transaction((tx) =>
        profiles.putProfileInTransaction(tx, tenantId, actorUserId, product.id, {}, "invalid"),
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: "invalid_master_data" } });
    await expect(profiles.getProfile(tenantId, actorUserId, "invalid-id")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.db.transaction((tx) =>
        profiles.getProfileInTransaction(tx, tenantId, actorUserId, "invalid-id"),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await f.snapshot(false)).toEqual(before);
  });
});
