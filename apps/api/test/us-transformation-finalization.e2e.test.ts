import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTransformationReferenceContext } from "../src/modules/traceability/transformation/us-transformation-reference-context";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { emptyReceivingItem, seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  seedFinalizableTransformation,
  transformationEffects,
  type TransformationFixtureDatabase,
} from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation original finalization", () => {
  let f: TransformationFixtureDatabase;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  const noEffects = { lots: 0, edges: 0, bindings: 0, receipts: 0, audits: 0 };

  it("freezes distinct input/output reviews and source reference across later coverage edits and replay", async () => {
    const c = await seedFinalizableTransformation(f, true);
    const outputProduct = randomUUID();
    await f.db
      .insert(schema.products)
      .values({ id: outputProduct, tenantId: c.tenant, name: "Snack cups" });
    const outputCoverage = {
      coverageStatus: "contains_ftl_same_form" as const,
      coverageRationale: "Distinct output review",
      ftlCategory: "Fresh-cut fruits",
      ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
      ftlSourceVersion: "Output review 2026",
      reviewedBy: "historical-output-reviewer",
      reviewedAt: "2026-09-24T10:11:12.123Z",
    };
    await f.db.insert(schema.productTraceabilityProfiles).values({
      tenantId: c.tenant,
      productId: outputProduct,
      productName: "Snack cups",
      ...outputCoverage,
      reviewedAt: new Date(outputCoverage.reviewedAt),
    });
    await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.saved.draft,
          outputs: [
            { productId: outputProduct, tlc: "NEW-OUTPUT", quantity: "100", unitOfMeasure: "case" },
          ],
        },
      },
      "separate-output",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
      expectedDraftVersion: 2,
    });
    const command = {
      ...c.command,
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
    };
    const result = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      command,
      "frozen-evidence",
    );
    const inputCoverage = {
      coverageStatus: "covered",
      coverageRationale: "Synthetic QA review",
      ftlCategory: "Fresh-cut fruits",
      ftlSourceUrl:
        "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
      ftlSourceVersion: "Synthetic 2026",
      reviewedBy: c.actor,
      reviewedAt: "2026-09-25T13:14:15.123Z",
    };
    expect(result.snapshot.inputs[0]).toMatchObject({
      product: { id: c.product, coverage: inputCoverage },
      source: {
        kind: "reference",
        id: c.location,
        description: "Synthetic supplier, 1 Test Street, Chicago, IL, 60601, US, +1 555 010 0100",
        referenceKind: "web_url",
        referenceValue: "https://supplier.example.test/source/Ä?lot=001",
      },
    });
    expect(result.snapshot.inputs[1]).toMatchObject({
      product: { coverage: inputCoverage },
      source: { kind: "location", id: c.location },
    });
    expect(result.snapshot.outputs[0]).toMatchObject({
      product: { id: outputProduct, coverage: outputCoverage },
      source: { kind: "location", id: c.processor },
    });
    for (const productId of [c.product, outputProduct])
      await f.db
        .update(schema.productTraceabilityProfiles)
        .set({
          coverageStatus: "not_covered",
          coverageRationale: "New review must not overwrite history",
          ftlCategory: null,
          ftlSourceUrl: null,
          ftlSourceVersion: null,
          reviewedBy: "new-reviewer",
          reviewedAt: new Date("2026-09-27T00:00:00.000Z"),
        })
        .where(eq(schema.productTraceabilityProfiles.productId, productId));
    expect(await c.store.getRecord(c.tenant, c.actor, result.id)).toEqual(result);
    expect(
      await c.store.finalize(c.tenant, c.actor, result.id, command, "historical-replay"),
    ).toEqual(result);
    expect(await transformationEffects(f, c.tenant, result.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
  });

  it("pins exact 500 lb + 500 lb to 100 case evidence, processor TLC and two directed edges atomically", async () => {
    const c = await seedFinalizableTransformation(f);
    const result = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "trn-finalize");
    const output = result.snapshot.outputs[0];
    if (!output) throw new Error("Missing output");
    expect(output.source.id).not.toBe(c.location);
    const inputSourceDescription =
      "Synthetic supplier, 1 Test Street, Chicago, IL, 60601, US, +1 555 010 0100";
    const processorDescription =
      "Synthetic processor, 2 Processing Street, Madison, WI, 53703, US, +1 555 020 0200";
    const coverage = {
      coverageStatus: "covered",
      coverageRationale: "Synthetic QA review",
      ftlCategory: "Fresh-cut fruits",
      ftlSourceUrl:
        "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
      ftlSourceVersion: "Synthetic 2026",
      reviewedBy: c.actor,
      reviewedAt: "2026-09-25T13:14:15.123Z",
    };
    expect(output.source).toEqual({
      kind: "location",
      id: c.processor,
      description: processorDescription,
    });
    expect(output.source.description).not.toBe(inputSourceDescription);
    expect(result).toMatchObject({
      status: "finalized",
      id: c.saved.id,
      draftVersion: 1,
      finalizedBy: c.actor,
    });
    expect(result.snapshot).toEqual({
      snapshotVersion: 1,
      eventId: c.saved.id,
      eventNumber: c.saved.eventNumber,
      revision: 1,
      eventDate: "2026-09-26",
      timeZone: "America/Chicago",
      processor: { id: c.processor, description: processorDescription },
      reason: "commingling_and_repacking",
      reasonNote: "Synthetic two-lot run",
      notes: "Office fixture",
      inputs: c.origin.snapshot.items.map((line, index) => ({
        kind: "ftl_lot",
        lineNo: index + 1,
        lotId: line.lotId,
        product: { id: c.product, description: "Synthetic apples", coverage },
        tlc: line.tlc,
        source: { kind: "location", id: c.location, description: inputSourceDescription },
        quantity: "500",
        unitOfMeasure: "lb",
      })),
      outputs: [
        {
          lineNo: 1,
          lotId: output.lotId,
          product: { id: c.product, description: "Synthetic apples", coverage },
          tlc: "NEW-OUTPUT",
          source: { kind: "location", id: c.processor, description: processorDescription },
          quantity: "100",
          unitOfMeasure: "case",
        },
      ],
      documents: [{ id: c.document, type: "bol", number: "00001" }],
      finalizedBy: c.actor,
      finalizedAt: result.finalizedAt,
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, output.lotId));
    expect(lot).toMatchObject({
      tenantId: c.tenant,
      productId: c.product,
      tlc: "NEW-OUTPUT",
      assignmentBasis: "transformation",
      sourceLocationId: c.processor,
      sourceReferenceKind: null,
      sourceReferenceValue: null,
      sourceLockedAt: new Date(result.finalizedAt),
      status: "active",
    });
    expect(c.origin.snapshot.items.map((line) => line.lotId)).not.toContain(output.lotId);
    const edges = await f.db
      .select()
      .from(schema.lotGenealogyEdges)
      .where(eq(schema.lotGenealogyEdges.eventId, result.id));
    expect(edges).toEqual(
      expect.arrayContaining(
        c.origin.snapshot.items.map((line) => ({
          tenantId: c.tenant,
          eventId: result.id,
          eventType: "transformation",
          inputLotId: line.lotId,
          outputLotId: output.lotId,
        })),
      ),
    );
    expect(await transformationEffects(f, c.tenant, result.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "trn-finalize"));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.action === "traceability.transformation.finalized")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      outcome: "success",
      targetType: "traceability_event",
      targetId: result.id,
      before: c.saved,
      after: result,
      requestId: "trn-finalize",
    });
    expect(audits.find((a) => a.action === "traceability.lot.created")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      outcome: "success",
      targetType: "traceability_lot",
      targetId: output.lotId,
      before: null,
      after: { id: output.lotId, assignmentBasis: "transformation", eventId: result.id },
      requestId: "trn-finalize",
    });
    expect(audits.find((a) => a.action === "traceability.lot.created")?.after).toEqual({
      id: output.lotId,
      productId: c.product,
      tlc: "NEW-OUTPUT",
      source: { kind: "location", locationId: c.processor },
      sourceLockedAt: result.finalizedAt,
      assignmentBasis: "transformation",
      status: "active",
      revision: 1,
      createdBy: c.actor,
      updatedBy: c.actor,
      createdAt: result.finalizedAt,
      updatedAt: result.finalizedAt,
      eventId: result.id,
    });
    const [receipt] = await f.db
      .select()
      .from(schema.transformationOperations)
      .where(
        and(
          eq(schema.transformationOperations.tenantId, c.tenant),
          eq(schema.transformationOperations.operationKey, c.command.operationKey),
        ),
      );
    expect(receipt).toMatchObject({
      command: "transformation.finalize",
      eventId: result.id,
      result,
    });
    for (const table of ["boxes", "box_items", "shifts"])
      expect((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([
        { n: 0 },
      ]);
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ productName: "Changed apples" })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed facility" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed processor" })
      .where(eq(schema.traceabilityLocations.id, c.processor));
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "America/Denver" })
      .where(eq(schema.orgProfiles.tenantId, c.tenant));
    await f.db
      .update(schema.referenceDocuments)
      .set({ number: "CHANGED" })
      .where(eq(schema.referenceDocuments.id, c.document));
    expect(await c.store.getRecord(c.tenant, c.actor, result.id)).toEqual(result);
    expect(await c.store.finalize(c.tenant, c.actor, result.id, c.command, "replay")).toEqual(
      result,
    );
    expect(await transformationEffects(f, c.tenant, result.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
    const next = await c.receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.draft,
          items: c.draft.items.map((line) => ({
            ...line,
            lotLinkMode: "link_existing",
            lotId: c.origin.snapshot.items.find((item) => item.tlc === line.tlc)?.lotId,
          })),
        },
      },
      "receiving-after",
    );
    const ready = await c.receiving.checkReadiness(c.tenant, c.actor, next.id, {
      expectedDraftVersion: 1,
    });
    expect(
      (
        await c.receiving.finalize(
          c.tenant,
          c.actor,
          next.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          "receiving-after-finalize",
        )
      ).status,
    ).toBe("finalized");
  });

  it.each(["coverage", "origin", "source", "digest", "stale", "identity"] as const)(
    "rejects %s without any partial finalization",
    async (kind) => {
      const c = await seedFinalizableTransformation(f);
      let command = c.command;
      if (kind === "coverage")
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({ coverageStatus: "unknown", reviewedBy: null, reviewedAt: null })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
      if (kind === "source")
        await f.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, c.location));
      if (kind === "origin") {
        const id = randomUUID();
        await f.db.insert(schema.traceabilityLots).values({
          id,
          tenantId: c.tenant,
          productId: c.product,
          tlc: "IMPORTED",
          sourceLocationId: c.location,
          assignmentBasis: "imported",
          createdBy: c.actor,
          updatedBy: c.actor,
        });
        await c.store.saveDraft(
          c.tenant,
          c.actor,
          c.saved.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            draft: {
              ...c.saved.draft,
              inputs: [{ kind: "ftl_lot", lotId: id, quantity: "500", unitOfMeasure: "lb" }],
            },
          },
          "save",
        );
        command = { ...command, expectedDraftVersion: 2 };
      }
      if (kind === "digest")
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({ coverageRationale: "Updated review" })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
      if (kind === "stale") command = { ...command, expectedDraftVersion: 2 };
      if (kind === "identity")
        await f.db.insert(schema.traceabilityLots).values({
          tenantId: c.tenant,
          productId: c.product,
          tlc: "NEW-OUTPUT",
          sourceLocationId: c.processor,
          assignmentBasis: "imported",
          createdBy: c.actor,
          updatedBy: c.actor,
        });
      const code = {
        coverage: "event_incomplete",
        origin: "event_incomplete",
        source: "event_incomplete",
        digest: "transformation_readiness_changed",
        stale: "transformation_draft_conflict",
        identity: "transformation_lot_conflict",
      }[kind];
      await expect(
        c.store.finalize(c.tenant, c.actor, c.saved.id, command, "reject"),
      ).rejects.toMatchObject({ status: 409, response: { code } });
      expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual(noEffects);
      expect(await c.store.getRecord(c.tenant, c.actor, c.saved.id)).toMatchObject({
        status: "draft",
      });
    },
  );

  it("denies wrong-tenant and Receiving IDs and reauthorizes before malformed commands or replay", async () => {
    const c = await seedFinalizableTransformation(f),
      other = await seedReceivingTenant(f.db);
    for (const id of [c.origin.id, randomUUID()])
      await expect(
        c.store.finalize(c.tenant, c.actor, id, c.command, "wrong-type"),
      ).rejects.toMatchObject({ status: 404, response: { code: "transformation_not_found" } });
    await expect(
      c.store.finalize(other.tenant, other.actor, c.saved.id, c.command, "foreign"),
    ).rejects.toMatchObject({ status: 404, response: { code: "transformation_not_found" } });
    expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual(noEffects);
    await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "valid");
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        c.saved.id,
        { ...c.command, expectedInputDigest: "a".repeat(64) },
        "different",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
    await f.db.update(schema.member).set({ role: "viewer" }).where(eq(schema.member.id, c.member));
    for (const input of [null, c.command])
      await expect(
        c.store.finalize(c.tenant, c.actor, c.saved.id, input, "denied"),
      ).rejects.toMatchObject({ status: 403 });
    expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
  });

  it.each(["audit", "edge", "receipt"] as const)(
    "rolls back every effect when %s insertion fails",
    async (kind) => {
      const c = await seedFinalizableTransformation(f);
      const table = {
        audit: "tenant_audit_events",
        edge: "lot_genealogy_edges",
        receipt: "transformation_operations",
      }[kind];
      const auditsBefore = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
      const lotsBefore = await f.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant));
      await f.pool.query(
        `CREATE FUNCTION fail_transformation_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected insertion failure'; END $$; CREATE TRIGGER fail_transformation_insert BEFORE INSERT ON ${table} FOR EACH ROW ${kind === "audit" ? "WHEN (NEW.action='traceability.transformation.finalized')" : ""} EXECUTE FUNCTION fail_transformation_insert()`,
      );
      try {
        await expect(
          c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "failure"),
        ).rejects.toThrow();
        expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual(noEffects);
        expect(await c.store.getRecord(c.tenant, c.actor, c.saved.id)).toEqual(c.saved);
        expect(
          await f.db
            .select()
            .from(schema.traceabilityLots)
            .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
        ).toEqual(lotsBefore);
        expect(
          await f.db
            .select()
            .from(schema.tenantAuditEvents)
            .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
        ).toEqual(auditsBefore);
      } finally {
        await f.pool.query(
          `DROP TRIGGER fail_transformation_insert ON ${table}; DROP FUNCTION fail_transformation_insert()`,
        );
      }
    },
  );

  it("preserves input quarantine and recall statuses and permanent source locks", async () => {
    const c = await seedFinalizableTransformation(f);
    const [first, second] = c.origin.snapshot.items;
    if (!first || !second) throw new Error("Missing input lots");
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "quarantined" })
      .where(eq(schema.traceabilityLots.id, first.lotId));
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "recalled" })
      .where(eq(schema.traceabilityLots.id, second.lotId));
    const before = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    const ready = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
      expectedDraftVersion: 1,
    });
    await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      { ...c.command, expectedInputDigest: ready.inputDigest },
      "retained-status",
    );
    const after = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    for (const lot of before)
      expect(after.find((row) => row.id === lot.id)).toEqual({
        ...lot,
        currentDependencyVersion: lot.currentDependencyVersion + 1,
      });
  });

  it("uses a finalized Transformation output as a later input with origin evidence in the readiness digest", async () => {
    const c = await seedFinalizableTransformation(f);
    const first = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "first");
    const output = first.snapshot.outputs[0];
    if (!output) throw new Error("Missing output");
    const saved = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.saved.draft,
          inputs: [
            { kind: "ftl_lot", lotId: output.lotId, quantity: "100", unitOfMeasure: "case" },
          ],
          outputs: [
            { productId: c.product, tlc: "SECOND-OUTPUT", quantity: "100", unitOfMeasure: "case" },
          ],
        },
      },
      "second",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready).toMatchObject({ state: "complete", issues: [] });
    const facts = await f.db.transaction((tx) =>
      readTransformationReferenceContext(tx, c.tenant, saved.draft, "US_FSMA204_PROCESSOR"),
    );
    expect(facts.origins).toEqual([
      {
        lotId: output.lotId,
        receiving: {
          lotId: output.lotId,
          basisVersion: 1,
          state: "missing",
          supportCount: 0,
          items: [],
          limit: 100,
          offset: 0,
          hasMore: false,
        },
        transformations: [
          { event_id: first.id, root_id: first.id, revision: 1, snapshot: first.snapshot },
        ],
      },
    ]);
    expect(
      (await c.store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }))
        .inputDigest,
    ).toBe(ready.inputDigest);
    // A new current origin changes evidence while this Transformation's draft is unchanged.
    const receiptDraft = await c.receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.draft,
          items: [
            {
              ...emptyReceivingItem,
              lotLinkMode: "link_existing",
              lotId: output.lotId,
              productId: c.product,
              tlc: output.tlc,
              source: { kind: "location", locationId: c.processor },
              quantity: "100",
              unitOfMeasure: "case",
            },
          ],
        },
      },
      "additional-origin",
    );
    const receiptReady = await c.receiving.checkReadiness(c.tenant, c.actor, receiptDraft.id, {
      expectedDraftVersion: 1,
    });
    await c.receiving.finalize(
      c.tenant,
      c.actor,
      receiptDraft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: receiptReady.inputDigest,
      },
      "additional-origin-finalize",
    );
    const refreshed = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(refreshed.state).toBe("complete");
    expect(refreshed.inputDigest).not.toBe(ready.inputDigest);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "stale-origin",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_readiness_changed" } });
    const second = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: refreshed.inputDigest,
      },
      "second-finalize",
    );
    expect(second.snapshot.inputs).toEqual([
      {
        kind: "ftl_lot",
        lineNo: 1,
        lotId: output.lotId,
        product: output.product,
        tlc: "NEW-OUTPUT",
        source: output.source,
        quantity: "100",
        unitOfMeasure: "case",
      },
    ]);
    expect(await transformationEffects(f, c.tenant, saved.id)).toEqual({
      lots: 2,
      edges: 1,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
  });
});
