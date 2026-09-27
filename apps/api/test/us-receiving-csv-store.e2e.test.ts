import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as csv from "../src/modules/traceability/receiving/us-receiving-csv-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import { csvRequest, csvRow, csvHeader } from "./support/us-receiving-csv-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US receiving CSV preview service", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedReceivingTenant>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedReceivingTenant(f.db);
  });
  const store = () => new csv.UsReceivingCsvStore(f.db);
  const input = () =>
    csvRequest(
      [
        csvRow(c.product, {
          source_kind: "reference",
          source_reference_url: "https://supplier.example.test/Case/Ä",
          source_resolved_location_id: c.location,
          notes: "  original\nnotes  ",
        }),
      ],
      {
        ...csvHeader,
        locationId: c.location,
        previousSourceLocationId: c.location,
        documentIds: [c.document],
        notes: "  header  ",
      },
    );
  const create = (value: unknown = input(), requestId = "preview-request") =>
    store().createPreview(c.tenant, c.actor, value, requestId);
  const get = (id: unknown) => store().getPreview(c.tenant, c.actor, id);
  const previews = () =>
    f.db
      .select()
      .from(schema.receivingCsvPreviews)
      .where(eq(schema.receivingCsvPreviews.tenantId, c.tenant));
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
  const setRole = (role: string) =>
    f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
  async function business() {
    return Promise.all(
      [
        "traceability_events",
        "receiving_event_items",
        "receiving_event_documents",
        "receiving_event_roots",
        "receiving_operations",
        "receiving_counters",
        "traceability_lots",
      ].map(
        async (table) =>
          (
            await f.pool.query(
              `SELECT to_jsonb(t)::text AS exact FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
              [c.tenant],
            )
          ).rows,
      ),
    );
  }

  it("exports a preview service without registering a route", () => {
    expect(csv).toHaveProperty("UsReceivingCsvStore", expect.any(Function));
  });
  it("persists raw and normalized evidence with exact metadata-only audit and no business effects", async () => {
    const before = await business();
    const value = input();
    const result = await create(value);
    expect(result).toMatchObject({
      templateVersion: "markiro-receiving-v1",
      createdBy: c.actor,
      originalHeader: value.header,
      header: { ...value.header, notes: "header" },
      resolution: { rows: [{ rowNumber: 1, productId: c.product, issues: [] }], headerIssues: [] },
      proposedDraft: {
        items: [
          {
            productId: c.product,
            quantity: "500.000",
            notes: "original\nnotes",
            source: { kind: "reference", resolvedLocationId: c.location },
          },
        ],
      },
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(86400000);
    expect(await get(result.id)).toEqual(result);
    const [persisted] = await previews();
    expect(persisted?.fileBytes).toEqual(Buffer.from(value.fileBase64, "base64"));
    expect(persisted?.findings).toEqual({
      version: 1,
      content: result.content,
      resolution: result.resolution,
    });
    const savedAudits = await audits();
    expect(savedAudits).toHaveLength(1);
    expect(savedAudits[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.receiving.csv_previewed",
      outcome: "success",
      targetType: "receiving_csv_preview",
      targetId: result.id,
      before: null,
      requestId: "preview-request",
    });
    expect(savedAudits[0]?.after).toEqual({
      importId: result.id,
      templateVersion: "markiro-receiving-v1",
      fileSha256: result.fileSha256,
      rowCount: 1,
      hasProposal: true,
      previewDigest: result.previewDigest,
    });
    expect(await business()).toEqual(before);
  });
  it("stores duplicate files as separate previews with the same content digest", async () => {
    const [a, b] = await Promise.all([create(), create({ ...input(), fileName: "another.csv" })]);
    expect(a.id).not.toBe(b.id);
    expect(a.previewDigest).toBe(b.previewDigest);
    expect(await previews()).toHaveLength(2);
    expect(await audits()).toHaveLength(2);
  });
  it("resolves canonical GTIN only to the tenant's active product, preserving the original spelling", async () => {
    await f.db
      .update(schema.products)
      .set({ gtin14: "00000096385074" })
      .where(eq(schema.products.id, c.product));
    const foreign = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.products)
      .set({ gtin14: "00000096385074" })
      .where(eq(schema.products.id, foreign.product));
    await f.db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: c.tenant,
      name: "Archived duplicate",
      gtin14: "00000096385074",
      archived: true,
    });
    const result = await create(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    expect(result.proposedDraft?.items[0]?.productId).toBe(c.product);
    expect(result.content).toMatchObject({
      ok: true,
      rows: [
        {
          validation: {
            raw: { product_gtin: "96385074" },
            productSelector: { kind: "gtin", value: "00000096385074" },
          },
        },
      ],
    });
  });
  it("never falls back to a product name or external reference", async () => {
    await f.db
      .update(schema.products)
      .set({ name: "00000096385074", externalRef: "00000096385074" })
      .where(eq(schema.products.id, c.product));
    const result = await create(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    expect(result.resolution.rows[0]).toEqual({
      rowNumber: 1,
      productId: null,
      issues: [{ column: "product_gtin", code: "not_found" }],
    });
    expect(result.proposedDraft).toBeNull();
  });
  it("reports foreign and missing references identically without leaking tenant labels", async () => {
    const foreign = await seedReceivingTenant(f.db);
    for (const refs of [
      foreign,
      { product: randomUUID(), lot: randomUUID(), location: randomUUID(), document: randomUUID() },
    ]) {
      const value = csvRequest(
        [
          csvRow(refs.product, {
            lot_link_mode: "link_existing",
            lot_id: refs.lot,
            source_kind: "location",
            source_location_id: refs.location,
          }),
        ],
        {
          ...csvHeader,
          locationId: refs.location,
          previousSourceLocationId: refs.location,
          documentIds: [refs.document],
        },
      );
      const result = await create(value);
      expect(result.proposedDraft).toBeNull();
      expect(result.previewDigest).toBeNull();
      expect(result.resolution).toEqual({
        rows: [
          {
            rowNumber: 1,
            productId: null,
            issues: [
              { column: "product_id", code: "not_found" },
              { column: "lot_id", code: "not_found" },
              { column: "source_location_id", code: "not_found" },
            ],
          },
        ],
        headerIssues: [
          { field: "locationId", documentIndex: null, code: "not_found" },
          { field: "previousSourceLocationId", documentIndex: null, code: "not_found" },
          { field: "documentIds", documentIndex: 0, code: "not_found" },
        ],
      });
    }
    await expect(
      store().getPreview(
        c.tenant,
        c.actor,
        (
          await store().createPreview(
            foreign.tenant,
            foreign.actor,
            csvRequest([csvRow(foreign.product)]),
            "foreign",
          )
        ).id,
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "receiving_csv_preview_not_found" } });
    await expect(get(randomUUID())).rejects.toMatchObject({
      status: 404,
      response: { code: "receiving_csv_preview_not_found" },
    });
  });
  it("does not resolve a foreign GTIN", async () => {
    const foreign = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.products)
      .set({ gtin14: "00000096385074" })
      .where(eq(schema.products.id, foreign.product));
    const result = await create(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    expect(result.resolution.rows[0]?.issues).toEqual([
      { column: "product_gtin", code: "not_found" },
    ]);
    expect(result.proposedDraft).toBeNull();
  });
  it.each(["id", "gtin"])("rejects an archived product selected by %s", async (selector) => {
    await f.db
      .update(schema.products)
      .set({ archived: true, gtin14: "00000096385074" })
      .where(eq(schema.products.id, c.product));
    const result = await create(
      csvRequest([
        selector === "id" ? csvRow(c.product) : csvRow("", { product_gtin: "96385074" }),
      ]),
    );
    expect(result.resolution.rows[0]?.issues).toEqual([
      { column: selector === "id" ? "product_id" : "product_gtin", code: "inactive" },
    ]);
    expect(result.proposedDraft).toBeNull();
  });
  it.each(["lot", "location", "party", "document"])(
    "reports inactive %s references without partial creation",
    async (kind) => {
      if (kind === "lot")
        await f.db
          .update(schema.traceabilityLots)
          .set({ status: "quarantined" })
          .where(eq(schema.traceabilityLots.id, c.lot));
      if (kind === "location")
        await f.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, c.location));
      if (kind === "party")
        await f.db
          .update(schema.traceabilityParties)
          .set({ archived: true })
          .where(eq(schema.traceabilityParties.id, c.party));
      if (kind === "document")
        await f.db
          .update(schema.referenceDocuments)
          .set({ archivedAt: new Date() })
          .where(eq(schema.referenceDocuments.id, c.document));
      const before = await business();
      const result = await create(
        csvRequest(
          [
            csvRow(c.product, {
              lot_link_mode: "link_existing",
              lot_id: c.lot,
              source_kind: "reference",
              source_reference_url: "https://supplier.example.test",
              source_resolved_location_id: c.location,
            }),
          ],
          { ...csvHeader, documentIds: [c.document] },
        ),
      );
      expect(result.proposedDraft).toBeNull();
      if (kind === "document")
        expect(result.resolution.headerIssues).toEqual([
          { field: "documentIds", documentIndex: 0, code: "inactive" },
        ]);
      else
        expect(result.resolution.rows[0]?.issues).toEqual([
          { column: kind === "lot" ? "lot_id" : "source_resolved_location_id", code: "inactive" },
        ]);
      expect(await business()).toEqual(before);
    },
  );
  it("keeps valid rows and row failures visible without a partial proposal", async () => {
    const before = await business();
    const result = await create(
      csvRequest([csvRow(c.product), csvRow(c.product, { quantity: "1e3" }), ""]),
    );
    expect(result.rowCount).toBe(2); // A single terminal newline is not an extra record.
    expect(result.content).toMatchObject({
      ok: true,
      rows: [
        { rowNumber: 1, validation: { ok: true } },
        { rowNumber: 2, validation: { ok: false } },
      ],
    });
    expect(result.proposedDraft).toBeNull();
    expect(await get(result.id)).toEqual(result);
    expect(await business()).toEqual(before);
  });
  it("persists an invalid UTF-8 file as failed evidence, not as missing rows", async () => {
    const result = await create({ ...input(), fileBase64: Buffer.from([255]).toString("base64") });
    expect(result.content).toEqual({ ok: false, error: { code: "invalid_utf8", lineNumber: 1 } });
    expect(result.proposedDraft).toBeNull();
    expect(result.rowCount).toBe(0);
    expect((await previews())[0]?.fileBytes).toEqual(Buffer.from([255]));
    expect(await get(result.id)).toEqual(result);
  });
  it.each([
    "member",
    "traceability_auditor",
    "traceability_shipping",
    "traceability_production",
    "unknown",
  ])("requires current Receiving-write authority for create and read (%s)", async (role) => {
    const result = await create();
    await setRole(role);
    await expect(create(null)).rejects.toMatchObject({ status: 403 });
    await expect(get("invalid-id")).rejects.toMatchObject({ status: 403 });
    await expect(get(result.id)).rejects.toMatchObject({ status: 403 });
    expect(await previews()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
  it("allows the receiving role without granting QA or finalizing", async () => {
    await setRole("traceability_receiving");
    expect((await create()).proposedDraft).not.toBeNull();
    expect((await business()).slice(0, 6)).toEqual([[], [], [], [], [], []]);
  });
  it("requires current membership and a valid profile", async () => {
    const result = await create();
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(get(result.id)).rejects.toMatchObject({ status: 403 });
    await expect(create()).rejects.toMatchObject({ status: 403 });
    c = await seedReceivingTenant(f.db);
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(create()).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
    expect(await previews()).toEqual([]);
  });
  it("rejects malformed request metadata before persisting anything", async () => {
    await expect(create({ ...input(), actorUserId: c.actor })).rejects.toMatchObject({
      status: 400,
    });
    await expect(create({ ...input(), fileBase64: "Zh==" })).rejects.toMatchObject({ status: 400 });
    await expect(get("not-a-uuid")).rejects.toMatchObject({ status: 400 });
    expect(await previews()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
  it("fails closed when the current persisted profile becomes invalid", async () => {
    const result = await create();
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "invalid-zone" })
      .where(eq(schema.orgProfiles.tenantId, c.tenant));
    await expect(create()).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    await expect(get(result.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    expect(await previews()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
  it("reads expired historical evidence without retargeting a changed GTIN or changing audit", async () => {
    await f.db
      .update(schema.products)
      .set({ gtin14: "00000096385074" })
      .where(eq(schema.products.id, c.product));
    const result = await create(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    await f.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, c.product));
    await f.db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: c.tenant,
      name: "Another product",
      gtin14: "00000096385074",
    });
    await f.pool.query(
      "UPDATE receiving_csv_previews SET created_at='2020-01-01T00:00:00Z',expires_at='2020-01-02T00:00:00Z' WHERE id=$1",
      [result.id],
    );
    expect(await get(result.id)).toMatchObject({
      proposedDraft: result.proposedDraft,
      previewDigest: result.previewDigest,
      expiresAt: "2020-01-02T00:00:00.000Z",
    });
    expect(await audits()).toHaveLength(1);
  });
  it.each([
    "findings='{}'::jsonb",
    "findings=jsonb_set(findings,'{content,ok}','false'::jsonb)",
    "findings=jsonb_set(findings,'{resolution,rows,0,rowNumber}','2'::jsonb)",
    "proposed_draft='{}'::jsonb",
    "preview_digest=repeat('a',64)",
    "row_count=2",
  ])("fails closed on corrupt saved evidence: %s", async (assignment) => {
    const result = await create();
    await f.pool.query(`UPDATE receiving_csv_previews SET ${assignment} WHERE id=$1`, [result.id]);
    await expect(get(result.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "receiving_csv_preview_unavailable" },
    });
    expect(await audits()).toHaveLength(1);
  });
  it("rolls back preview creation when the real audit insert fails", async () => {
    const before = await business();
    await f.pool.query(
      "ALTER TABLE tenant_audit_events ADD CONSTRAINT csv_test_audit_failure CHECK (request_id <> 'synthetic-audit-failure')",
    );
    try {
      await expect(create(input(), "synthetic-audit-failure")).rejects.toMatchObject({
        cause: { code: "23514", constraint: "csv_test_audit_failure" },
      });
    } finally {
      await f.pool.query("ALTER TABLE tenant_audit_events DROP CONSTRAINT csv_test_audit_failure");
    }
    expect(await previews()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(await business()).toEqual(before);
  });
  it("does not silently normalize a corrupted stored resolution UUID", async () => {
    const product = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await f.db
      .insert(schema.products)
      .values({ id: product, tenantId: c.tenant, name: "Synthetic canonical identifier" });
    const result = await create(csvRequest([csvRow(product)]));
    await f.pool.query(
      "UPDATE receiving_csv_previews SET findings=jsonb_set(findings,'{resolution,rows,0,productId}',to_jsonb($1::text)) WHERE id=$2",
      [product.toUpperCase(), result.id],
    );
    await expect(get(result.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "receiving_csv_preview_unavailable" },
    });
    expect(await audits()).toHaveLength(1);
  });
});
