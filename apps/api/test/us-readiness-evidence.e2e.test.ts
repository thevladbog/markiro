import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { assessFrozenReadiness } from "@markiro/domain";
import {
  receivingFinalizationSnapshotV2Schema,
  receivingFinalizationSnapshotV3Schema,
  type ReceivingFinalizationSnapshotV2,
  type ReceivingFinalizationSnapshotV3,
  type UsReadinessScope,
} from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readUsReadinessEvidence,
  readinessEventSelectionQuery,
} from "../src/modules/traceability/trace/us-readiness-evidence";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";
import { seedCaseBridge, caseState } from "./support/us-case-bridge-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
  voidStoredEvent,
} from "./support/us-receiving-lifecycle-storage";
import {
  seedTransformationRevision,
  finalizationCommand,
} from "./support/us-transformation-revision-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const scope: UsReadinessScope = {
  eventDateFrom: "2026-09-01",
  eventDateTo: "2026-09-28",
  productId: null,
  lotId: null,
  profileCode: "US_FSMA204_PROCESSOR",
  defaulted: false,
};
describe.skipIf(!url)("US frozen readiness evidence", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  const read = (tenant: string, override: Partial<UsReadinessScope> = {}) =>
    transformationTransaction(f.db, (tx) =>
      readUsReadinessEvidence(tx, tenant, { ...scope, ...override }),
    );

  it("checks an older origin as a dependency without inflating scoped records or reading live descriptions", async () => {
    const c = await seedShippingLifecycle(f.db);
    const other = await seedShippingLifecycle(f.db);
    await finalizeFixtureShipment(other, "20");
    const shipment = await finalizeFixtureShipment(c, "20");
    const before = await caseState(f, c.tenant);
    const selected = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    expect(selected.facts.events.map((e) => e.id)).toEqual([shipment.id]);
    expect(selected).toMatchObject({
      selectedEventCount: 1,
      selectedLotCount: 1,
      dependencyCount: 1,
    });
    expect(selected.facts.dependencies).toEqual([
      expect.objectContaining({
        consumingEventId: shipment.id,
        lotId: c.lot,
        currentOrigin: true,
        source: { kind: "location", locationId: c.location },
      }),
    ]);
    expect(await caseState(f, c.tenant)).toEqual(before);
    await f.db
      .update(schema.products)
      .set({ name: "Renamed mutable product" })
      .where(eq(schema.products.id, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Renamed mutable location" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    expect(await read(c.tenant, { eventDateFrom: "2026-09-27" })).toEqual(selected);
  });

  it("compares older frozen origin TLC and product at the consuming line without inflating scope", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const [receipt] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(
        sql`${schema.traceabilityEvents.tenantId}=${c.tenant} AND ${schema.traceabilityEvents.type}='receiving'`,
      );
    if (!receipt) throw new Error("Missing Receiving");
    const original = receivingFinalizationSnapshotV2Schema.parse(receipt.finalizationSnapshot);
    const alternateProduct = randomUUID();
    await f.db.insert(schema.products).values({
      id: alternateProduct,
      tenantId: c.tenant,
      name: "Historical other product",
      gtin14: null,
    });
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...original,
            items: original.items.map((line) =>
              line.lotId === c.lot
                ? {
                    ...line,
                    tlc: "OLDER-FROZEN-TLC",
                    productId: alternateProduct,
                    productDescription: {
                      ...line.productDescription,
                      sourceProductId: alternateProduct,
                    },
                  }
                : line,
            ),
          },
        })
        .where(eq(schema.traceabilityEvents.id, receipt.id));
      await tx
        .update(schema.receivingEventItems)
        .set({ tlc: "OLDER-FROZEN-TLC", productId: alternateProduct })
        .where(
          sql`${schema.receivingEventItems.tenantId}=${c.tenant} AND ${schema.receivingEventItems.eventId}=${receipt.id} AND ${schema.receivingEventItems.lotId}=${c.lot}`,
        );
    });
    const result = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    expect(result).toMatchObject({
      selectedEventCount: 1,
      selectedLotCount: 1,
      dependencyCount: 1,
    });
    expect(result.facts.events.map((e) => e.id)).toEqual([shipment.id]);
    expect(result.facts.dependencies[0]).toMatchObject({
      tlc: "OLDER-FROZEN-TLC",
      productId: alternateProduct,
      relatedEventId: receipt.id,
    });
    const findings = assessFrozenReadiness({ ...result.facts, profileCode: scope.profileCode });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: shipment.id,
          relatedEventId: receipt.id,
          code: "tlc_source_mismatch",
          field: "lines.items[1].tlc",
        }),
        expect.objectContaining({
          eventId: shipment.id,
          relatedEventId: receipt.id,
          code: "event_lot_mismatch",
          field: "lines.items[1].productId",
        }),
      ]),
    );
    expect(findings.every((finding) => finding.eventId === shipment.id)).toBe(true);
  });

  it("selects the whole 2-to-2 Transformation through one output lot", async () => {
    const c = await seedFinalizableTransformation(f);
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.saved.draft,
          outputs: [
            { productId: c.product, tlc: "OUT-A", quantity: "40", unitOfMeasure: "case" },
            { productId: c.product, tlc: "OUT-B", quantity: "60", unitOfMeasure: "case" },
          ],
        },
      },
      "readiness-two-outputs",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    const event = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "readiness-final",
    );
    const selected = await read(c.tenant, { lotId: event.snapshot.outputs[0]!.lotId });
    expect(selected.facts.events.map((e) => e.id)).toEqual([event.id]);
    expect(selected).toMatchObject({
      selectedEventCount: 1,
      selectedLotCount: 4,
      dependencyCount: 2,
    });
    expect(selected.facts.events[0]?.lines.map((l) => [l.side, l.quantity])).toEqual([
      ["inputs", "500"],
      ["inputs", "500"],
      ["outputs", "40"],
      ["outputs", "60"],
    ]);
    expect((await read(c.tenant, { productId: c.product })).selectedEventCount).toBe(2);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["processor", "ship_from"] })
      .where(eq(schema.traceabilityLocations.id, c.processor));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "recipient"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    const shipping = new UsShippingStore(f.db);
    const draft = await shipping.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-27",
          shipFromLocationId: c.processor,
          recipientLocationId: c.location,
          carrierReference: null,
          notes: null,
          documentIds: [c.document],
          items: [
            { lotId: event.snapshot.outputs[0]!.lotId, quantity: "10", unitOfMeasure: "case" },
          ],
        },
      },
      "ship-transformed-output",
    );
    const shippingReady = await shipping.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: draft.draftVersion,
    });
    const shipped = await shipping.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: draft.draftVersion,
        expectedInputDigest: shippingReady.inputDigest,
      },
      "ship-transformed-final",
    );
    const chain = await read(c.tenant);
    expect(chain.facts.events.map((e) => e.type)).toEqual([
      "receiving",
      "transformation",
      "shipping",
    ]);
    expect(chain).toMatchObject({ selectedEventCount: 3, selectedLotCount: 4, dependencyCount: 3 });
    const shipmentOnly = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    expect(shipmentOnly.facts.events.map((e) => e.id)).toEqual([shipped.id]);
    expect(shipmentOnly.facts.dependencies).toEqual([
      expect.objectContaining({
        relatedEventId: event.id,
        relatedEvent: {
          type: "transformation",
          eventNumber: event.eventNumber,
          revision: event.revision,
        },
        currentOrigin: true,
        source: { kind: "location", locationId: c.processor },
      }),
    ]);
  });

  it("selects retained void output identities and leaves their active case link untouched", async () => {
    const c = await seedCaseBridge(f);
    await new UsCaseStore(f.db).link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "readiness-case",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Void origin" },
      "readiness-void",
    );
    const before = await caseState(f, c.tenant);
    const selected = await read(c.tenant, { eventDateFrom: "2026-09-26" });
    expect(selected.selectedEventCount).toBe(0);
    expect(selected.facts.lots).toEqual([
      expect.objectContaining({
        id: c.lotId,
        currentOrigin: false,
        relatedEventId: c.original.id,
        relatedEvent: {
          type: "transformation",
          eventNumber: c.original.eventNumber,
          revision: c.original.revision,
        },
      }),
    ]);
    expect(
      assessFrozenReadiness({ ...selected.facts, profileCode: scope.profileCode }),
    ).toContainEqual(
      expect.objectContaining({ code: "origin_gap", severity: "error", lotId: c.lotId }),
    );
    expect(await caseState(f, c.tenant)).toEqual(before);
  });

  it("rejects malformed known-version void-origin JSON and mismatched historical children", async () => {
    const c = await seedCaseBridge(f);
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Withdraw" },
      "void-history",
    );
    const update = async (snapshot: unknown) =>
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: snapshot })
          .where(eq(schema.traceabilityEvents.id, c.original.id));
      });
    await update({ snapshotVersion: 1 });
    await expect(read(c.tenant, { lotId: c.lotId })).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await update(c.original.snapshot);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.transformationEventOutputs)
        .set({ quantity: "99" })
        .where(eq(schema.transformationEventOutputs.eventId, c.original.id));
    });
    await expect(read(c.tenant, { lotId: c.lotId })).rejects.toMatchObject({ status: 503 });
  });

  it("links a retained lot to its latest void revision even when UUID ordering is reversed", async () => {
    const c = await seedTransformationRevision(f);
    const second = await c.store.finalize(
      c.tenant,
      c.actor,
      c.amendment.id,
      await finalizationCommand(c, c.amendment),
      "final-revision",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      second.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Withdraw corrected record",
      },
      "void-corrected",
    );
    const oldId = "ffffffff-ffff-4fff-bfff-fffffffffff1";
    const newId = "00000000-0000-4000-8000-000000000002";
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      for (const [before, after] of [
        [c.original.id, oldId],
        [second.id, newId],
      ] as const) {
        await tx.execute(sql`UPDATE traceability_events SET
          id=CASE WHEN id=${before}::uuid THEN ${after}::uuid ELSE id END,
          root_event_id=CASE WHEN root_event_id=${before}::uuid THEN ${after}::uuid ELSE root_event_id END,
          previous_revision_id=CASE WHEN previous_revision_id=${before}::uuid THEN ${after}::uuid ELSE previous_revision_id END,
          superseded_by_event_id=CASE WHEN superseded_by_event_id=${before}::uuid THEN ${after}::uuid ELSE superseded_by_event_id END,
          finalization_snapshot=replace(finalization_snapshot::text,${before},${after})::jsonb
          WHERE tenant_id=${c.tenant}`);
        await tx.execute(
          sql`UPDATE transformation_event_roots SET id=CASE WHEN id=${before}::uuid THEN ${after}::uuid ELSE id END WHERE tenant_id=${c.tenant}`,
        );
        for (const name of [
          "transformation_event_details",
          "transformation_event_inputs",
          "transformation_event_outputs",
          "transformation_event_documents",
          "lot_genealogy_edges",
        ])
          await tx.execute(
            sql`UPDATE ${sql.identifier(name)} SET event_id=${after}::uuid WHERE tenant_id=${c.tenant} AND event_id=${before}::uuid`,
          );
      }
    });
    const lotId = second.snapshot.outputs[0]!.lotId;
    const result = await read(c.tenant, { lotId });
    expect(result.selectedEventCount).toBe(0);
    expect(result.facts.lots).toEqual([
      expect.objectContaining({ id: lotId, currentOrigin: false, relatedEventId: newId }),
    ]);
    expect(
      assessFrozenReadiness({ ...result.facts, profileCode: scope.profileCode }),
    ).toContainEqual(expect.objectContaining({ code: "origin_gap", relatedEventId: newId }));
  });

  it.each(["current", "historical"] as const)(
    "rejects contradictory Receiving V3 bindings in %s evidence",
    async (mode) => {
      const c = await seedShippingLifecycle(f.db);
      const [row] = await f.db
        .select()
        .from(schema.traceabilityEvents)
        .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
      if (!row) throw new Error("Missing receipt");
      const original = receivingFinalizationSnapshotV2Schema.parse(row.finalizationSnapshot);
      if (mode === "historical")
        await new UsReceivingStore(f.db).void(
          c.tenant,
          c.actor,
          row.id,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            expectedDraftVersion: null,
            reason: "Withdraw synthetic receipt",
          },
          "void-v3-binding-fixture",
        );
      const valid = receivingFinalizationSnapshotV3Schema.parse({
        ...original,
        snapshotVersion: 3,
        confirmation: { ...original.confirmation, ruleVersion: "receiving-readiness-v4" },
        items: original.items.map((line) => ({
          ...line,
          lotBinding: { kind: line.lotLinkMode === "link_existing" ? "linked" : "created" },
        })),
      });
      const update = (snapshot: unknown) =>
        f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx
            .update(schema.traceabilityEvents)
            .set({ finalizationSnapshot: snapshot })
            .where(eq(schema.traceabilityEvents.id, row.id));
        });
      await update(valid);
      expect((await read(c.tenant)).selectedEventCount).toBe(mode === "current" ? 1 : 0);
      for (const [linkMode, binding] of [
        ["create_on_finalize", "linked"],
        ["link_existing", "created"],
      ] as const) {
        const contradicted = {
          ...valid,
          items: valid.items.map((line) =>
            line.lotLinkMode === linkMode ? { ...line, lotBinding: { kind: binding } } : line,
          ),
        };
        const authoritative = receivingFinalizationSnapshotV3Schema.safeParse(contradicted);
        expect(authoritative.success).toBe(false);
        if (authoritative.success) throw new Error("Contradictory binding unexpectedly valid");
        expect(
          authoritative.error.issues.some(
            (issue) => issue.message === "Lot binding disagrees with the original link mode",
          ),
        ).toBe(true);
        await update(contradicted);
        await expect(read(c.tenant)).rejects.toMatchObject({
          status: 503,
          response: { code: "us_database_unavailable" },
        });
        // A business gap cannot bypass structural binding checks either.
        await update({ ...contradicted, documents: [] });
        await expect(read(c.tenant)).rejects.toMatchObject({ status: 503 });
      }
      await update({
        ...valid,
        items: valid.items.map((line, index) =>
          index === 0
            ? {
                ...line,
                lotBinding: { kind: "retained", previousEventId: randomUUID(), previousLineNo: 1 },
              }
            : line,
        ),
      });
      await expect(read(c.tenant)).rejects.toMatchObject({ status: 503 });
    },
  );

  type ReceivingSnapshot = ReceivingFinalizationSnapshotV2 | ReceivingFinalizationSnapshotV3;
  async function receivingCrossfieldFixture(version: 2 | 3, historical: boolean, retained = false) {
    const c = await seedShippingLifecycle(f.db);
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    if (!row) throw new Error("Missing receipt");
    let eventId = row.id;
    let snapshot: ReceivingSnapshot = receivingFinalizationSnapshotV2Schema.parse(
      row.finalizationSnapshot,
    );
    if (retained) {
      eventId = await createStoredAmendment(f, c.tenant, row.id);
      snapshot = receivingFinalizationSnapshotV3Schema.parse(
        await finalizeStoredAmendment(f, c.tenant, eventId),
      );
    } else if (version === 3) {
      snapshot = receivingFinalizationSnapshotV3Schema.parse({
        ...snapshot,
        snapshotVersion: 3,
        confirmation: { ...snapshot.confirmation, ruleVersion: "receiving-readiness-v4" },
        items: snapshot.items.map((line) => ({
          ...line,
          lotBinding: { kind: line.lotLinkMode === "link_existing" ? "linked" : "created" },
        })),
      });
    }
    if (historical) await voidStoredEvent(f, c.tenant, eventId);
    // Keep child identities coherent so only the frozen cross-field contradiction can reject.
    const update = (value: {
      items: ReceivingSnapshot["items"][number][];
      documents: ReceivingSnapshot["documents"];
    }) =>
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: value })
          .where(eq(schema.traceabilityEvents.id, eventId));
        for (const line of value.items) {
          await tx
            .update(schema.receivingEventItems)
            .set({
              lotLinkMode: line.lotLinkMode,
              sourceLocationId: line.source.kind === "location" ? line.source.locationId : null,
              sourceReferenceKind:
                line.source.kind === "reference" ? line.source.referenceKind : null,
              sourceReferenceValue:
                line.source.kind === "reference" ? line.source.referenceValue : null,
              sourceReferenceLocationId:
                line.source.kind === "reference" ? line.source.resolvedLocationId : null,
            })
            .where(
              sql`${schema.receivingEventItems.eventId}=${eventId} AND ${schema.receivingEventItems.lineNo}=${line.lineNo}`,
            );
        }
      });
    await update(snapshot);
    expect((await read(c.tenant)).selectedEventCount).toBe(historical ? 0 : 1);
    return { c, eventId, snapshot, update };
  }
  function assignedReceipt(snapshot: ReceivingSnapshot): ReceivingSnapshot {
    const assigned = {
      ...snapshot,
      confirmation: { ...snapshot.confirmation, reviewedExemptLines: [1] },
      items: snapshot.items.map((line) =>
        line.lineNo === 1
          ? {
              ...line,
              receiptBasis: {
                kind: "exempt_assigned_tlc" as const,
                receivedTlc: null,
                reason: "Synthetic supplier exemption",
                evidenceUrl: "https://supplier.example.test/evidence",
                reviewedBy: "synthetic-reviewer",
                reviewedAt: "2026-09-07T12:00:00Z",
              },
            }
          : line,
      ),
    };
    return snapshot.snapshotVersion === 2
      ? receivingFinalizationSnapshotV2Schema.parse(assigned)
      : receivingFinalizationSnapshotV3Schema.parse(assigned);
  }

  describe.each([2, 3] as const)("Receiving V%i cross-field integrity", (version) => {
    describe.each([false, true])("historical=%s", (historical) => {
      it.each([
        "ordinary reviewed",
        "exempt unreviewed",
        "assigned linked",
        "assigned wrong location",
        "assigned reference",
      ] as const)("rejects %s even alongside a missing document", async (contradiction) => {
        const { c, snapshot, update } = await receivingCrossfieldFixture(version, historical);
        const pinned =
          version === 2
            ? receivingFinalizationSnapshotV2Schema
            : receivingFinalizationSnapshotV3Schema;
        const valid = contradiction === "ordinary reviewed" ? snapshot : assignedReceipt(snapshot);
        expect(pinned.safeParse(valid).success).toBe(true);
        await update(valid);
        expect((await read(c.tenant)).selectedEventCount).toBe(historical ? 0 : 1);
        const invalid = {
          ...valid,
          confirmation: {
            ...valid.confirmation,
            reviewedExemptLines:
              contradiction === "ordinary reviewed"
                ? [1]
                : contradiction === "exempt unreviewed"
                  ? []
                  : [1],
          },
          items: valid.items.map((line) => {
            if (line.lineNo !== 1) return line;
            if (contradiction === "assigned linked")
              return {
                ...line,
                lotLinkMode: "link_existing" as const,
                ...("lotBinding" in line ? { lotBinding: { kind: "linked" as const } } : {}),
              };
            if (contradiction === "assigned wrong location")
              return {
                ...line,
                source: { kind: "location" as const, locationId: c.recipient },
                sourceDescription: { ...line.sourceDescription, locationId: c.recipient },
              };
            if (contradiction === "assigned reference")
              return {
                ...line,
                source: {
                  kind: "reference" as const,
                  referenceKind: "web_url" as const,
                  referenceValue: "https://supplier.example.test/source",
                  resolvedLocationId: snapshot.locationId,
                },
              };
            return line;
          }),
        };
        const rejected = pinned.safeParse(invalid);
        expect(rejected.success).toBe(false);
        if (rejected.success)
          throw new Error("Contradiction unexpectedly accepted by pinned schema");
        expect(
          rejected.error.issues.some(
            (issue) =>
              issue.path.join(".") ===
              (contradiction === "ordinary reviewed" || contradiction === "exempt unreviewed"
                ? "confirmation.reviewedExemptLines"
                : "items.0.receiptBasis"),
          ),
        ).toBe(true);
        for (const documents of [valid.documents, []]) {
          await update({ ...invalid, documents });
          await expect.soft(read(c.tenant)).rejects.toMatchObject({
            status: 503,
            response: { code: "us_database_unavailable" },
          });
        }
      });
    });
  });

  it.each([false, true])(
    "preserves V3 retained physical source and rejects duplicate predecessor binding (historical=%s)",
    async (historical) => {
      const { c, eventId, snapshot, update } = await receivingCrossfieldFixture(
        3,
        historical,
        true,
      );
      const assigned = assignedReceipt(snapshot);
      const valid = receivingFinalizationSnapshotV3Schema.parse({
        ...assigned,
        // A retained own assignment keeps its old physical source when the receiving header changes.
        locationId: c.recipient,
        locationDescription: { ...assigned.locationDescription, locationId: c.recipient },
      });
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ locationId: c.recipient })
          .where(eq(schema.traceabilityEvents.id, eventId));
      });
      for (const documents of [valid.documents, []]) {
        await update({ ...valid, documents });
        expect((await read(c.tenant)).selectedEventCount).toBe(historical ? 0 : 1);
      }
      const first = valid.items[0];
      if (!first) throw new Error("Missing retained line");
      const duplicated = {
        ...valid,
        items: valid.items.map((line) => ({ ...line, lotBinding: first.lotBinding })),
      };
      const rejected = receivingFinalizationSnapshotV3Schema.safeParse(duplicated);
      expect(rejected.success).toBe(false);
      if (rejected.success) throw new Error("Duplicate unexpectedly valid");
      expect(
        rejected.error.issues.some(
          (issue) => issue.message === "Duplicate predecessor line binding",
        ),
      ).toBe(true);
      for (const documents of [valid.documents, []]) {
        await update({ ...duplicated, documents });
        await expect(read(c.tenant)).rejects.toMatchObject({
          status: 503,
          response: { code: "us_database_unavailable" },
        });
      }
    },
  );

  it.each([1, 2, 3] as const)(
    "preserves coherent missing Receiving v%i document KDE as a finding",
    async (version) => {
      const c = await seedShippingLifecycle(f.db);
      const [row] = await f.db
        .select()
        .from(schema.traceabilityEvents)
        .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
      if (!row) throw new Error("Missing Receiving event");
      const original = receivingFinalizationSnapshotV2Schema.parse(row.finalizationSnapshot);
      const { reviewedExemptLines, ...confirmation } = original.confirmation;
      const snapshot = {
        ...original,
        snapshotVersion: version,
        items: original.items.map(({ receiptBasis, ...line }) =>
          version === 1
            ? line
            : version === 2
              ? { ...line, receiptBasis }
              : {
                  ...line,
                  receiptBasis,
                  lotBinding: { kind: line.lotLinkMode === "link_existing" ? "linked" : "created" },
                },
        ),
        confirmation:
          version === 1
            ? { ...confirmation, ruleVersion: "receiving-readiness-v2" }
            : {
                ...confirmation,
                reviewedExemptLines,
                ruleVersion: version === 2 ? "receiving-readiness-v3" : "receiving-readiness-v4",
              },
        documents: original.documents.map((entry) => ({
          ...entry,
          document: { ...entry.document, number: "", type: null },
        })),
      };
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: snapshot })
          .where(eq(schema.traceabilityEvents.id, row.id));
      });
      const result = await read(c.tenant);
      expect(result.facts.events[0]?.documents).toEqual([{ kind: null, value: "" }]);
      expect(assessFrozenReadiness({ ...result.facts, profileCode: scope.profileCode })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventId: row.id,
            code: "required_reference",
            field: "documents[0].kind",
          }),
          expect.objectContaining({
            eventId: row.id,
            code: "required_reference",
            field: "documents[0].value",
          }),
        ]),
      );
    },
  );

  it("returns a rule-capable business gap but refuses malformed snapshots and missing children", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const update = async (snapshot: unknown) =>
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: snapshot })
          .where(eq(schema.traceabilityEvents.id, shipment.id));
      });
    await update({ ...shipment.snapshot, documents: [] });
    const selected = await read(c.tenant);
    expect(
      assessFrozenReadiness({ ...selected.facts, profileCode: scope.profileCode }),
    ).toContainEqual(
      expect.objectContaining({
        code: "required_reference",
        eventId: shipment.id,
        field: "documents",
      }),
    );
    await update({ ...shipment.snapshot, snapshotVersion: 999 });
    await expect(read(c.tenant)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await update(shipment.snapshot);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .delete(schema.shippingEventItems)
        .where(eq(schema.shippingEventItems.eventId, shipment.id));
    });
    await expect(read(c.tenant)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  });

  it("refuses a broken older origin root instead of reporting a business origin gap", async () => {
    const c = await seedShippingLifecycle(f.db);
    await finalizeFixtureShipment(c, "20");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.receivingEventRoots)
        .set({ currentEventId: null })
        .where(eq(schema.receivingEventRoots.tenantId, c.tenant));
    });
    await expect(read(c.tenant, { eventDateFrom: "2026-09-27" })).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  });

  it("includes an explicitly selected lot with no recorded CTE without inventing a date", async () => {
    const c = await seedCompleteReceiving(f.db);
    expect(await read(c.tenant)).toMatchObject({ selectedEventCount: 0, selectedLotCount: 0 });
    const result = await read(c.tenant, { lotId: c.lot });
    expect(result).toMatchObject({
      selectedEventCount: 0,
      selectedLotCount: 1,
      dependencyCount: 0,
    });
    expect(result.facts.lots).toEqual([
      expect.objectContaining({
        id: c.lot,
        currentOrigin: false,
        relatedEventId: null,
        relatedEvent: null,
      }),
    ]);
  });

  it("preserves coherent missing quantity, date and description as rule facts", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const first = shipment.snapshot.items[0];
    if (!first) throw new Error("Missing line");
    const changed = { ...first, quantity: null, product: { ...first.product, description: null } };
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: { ...shipment.snapshot, eventDate: null, items: [changed] } })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
      await tx
        .update(schema.shippingEventItems)
        .set({ quantity: null, productSnapshot: changed.product })
        .where(eq(schema.shippingEventItems.eventId, shipment.id));
    });
    const result = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    const findings = assessFrozenReadiness({ ...result.facts, profileCode: scope.profileCode });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: shipment.id,
          code: "required_kde",
          field: "frozenEventDate",
        }),
        expect.objectContaining({
          eventId: shipment.id,
          code: "required_kde",
          field: "lines.items[1].quantity",
        }),
        expect.objectContaining({
          eventId: shipment.id,
          code: "required_kde",
          field: "lines.items[1].productDescription",
        }),
      ]),
    );
  });

  it("preserves an absent frozen source for a rule instead of inventing live source evidence", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...shipment.snapshot,
            items: shipment.snapshot.items.map((line) => ({ ...line, source: null })),
          },
        })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
      await tx
        .update(schema.shippingEventItems)
        .set({ sourceSnapshot: null })
        .where(eq(schema.shippingEventItems.eventId, shipment.id));
    });
    const result = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    expect(result.facts.events[0]?.lines[0]?.source).toBeNull();
    expect(
      assessFrozenReadiness({ ...result.facts, profileCode: scope.profileCode }),
    ).toContainEqual(
      expect.objectContaining({
        code: "required_kde",
        field: "lines.items[1].source",
        eventId: shipment.id,
      }),
    );
  });

  it("cancels a blocked read with sanitized 503 and returns no partial assessment", async () => {
    const c = await seedShippingLifecycle(f.db);
    const holder = await f.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE traceability_events IN ACCESS EXCLUSIVE MODE");
      await expect(read(c.tenant)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 10_000);

  it("keeps a pending predecessor current then selects only its finalized amendment", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "20");
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle?.lifecycleVersion,
        reason: "Correct amount",
      },
      "readiness-amend",
    );
    expect(
      (await read(c.tenant, { eventDateFrom: "2026-09-27" })).facts.events.map((e) => e.id),
    ).toEqual([original.id]);
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      amendment.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...original.draft,
          items: [{ lotId: c.lot, quantity: "25", unitOfMeasure: "case" }],
        },
      },
      "readiness-save",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    const amended = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "readiness-amended",
    );
    const result = await read(c.tenant, { eventDateFrom: "2026-09-27" });
    expect(result.facts.events).toEqual([
      expect.objectContaining({
        id: amended.id,
        rootId: original.id,
        revision: 2,
        lines: [expect.objectContaining({ quantity: "25" })],
      }),
    ]);
    expect(result.draftWork.total).toBe(0);
  });

  it("counts draft work exactly with a bounded preview and includes undated work only under explicit selection", async () => {
    const c = await seedShippingLifecycle(f.db);
    const dated = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "dated",
    );
    await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: { ...c.draft, eventDate: null } },
      "undated",
    );
    const base = await read(c.tenant);
    expect(base.draftWork).toMatchObject({
      total: 1,
      items: [
        {
          eventId: dated.id,
          readinessHref: `/traceability/shipping/${dated.id}/readiness?expectedDraftVersion=1`,
        },
      ],
      hasMore: false,
    });
    expect((await read(c.tenant, { lotId: c.lot })).draftWork.total).toBe(2);
    for (let index = 0; index < 100; index++)
      await c.store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.draft },
        `draft-${index}`,
      );
    const many = await read(c.tenant);
    expect(many.draftWork).toMatchObject({ total: 101, hasMore: true });
    expect(many.draftWork.items).toHaveLength(100);
    expect(many.selectedEventCount).toBe(1);
  }, 30_000);

  it("reads 2001 current events without the graph cap and refuses the 10001 sentinel", async () => {
    const c = await seedShippingLifecycle(f.db);
    const [event] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    if (!event) throw new Error("Missing seed event");
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, event.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, event.id));
    if (!root) throw new Error("Missing seed root");
    const clone = async (start: number, count: number) => {
      for (let offset = 0; offset < count; offset += 250) {
        const copies = Array.from({ length: Math.min(250, count - offset) }, (_, i) => ({
          id: randomUUID(),
          number: `REC-26-${100000 + start + offset + i}`,
        }));
        await f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx.insert(schema.traceabilityEvents).values(
            copies.map(({ id, number }) => ({
              ...event,
              id,
              rootEventId: id,
              eventNumber: number,
            })),
          );
          await tx.insert(schema.receivingEventRoots).values(
            copies.map(({ id, number }) => ({
              ...root,
              id,
              currentEventId: id,
              eventNumber: number,
            })),
          );
          await tx
            .insert(schema.receivingEventItems)
            .values(copies.flatMap(({ id }) => items.map((item) => ({ ...item, eventId: id }))));
        });
      }
    };
    await clone(0, 2000);
    const started = performance.now();
    expect((await read(c.tenant)).selectedEventCount).toBe(2001);
    console.info(`Readiness seed: 2001 roots in ${(performance.now() - started).toFixed(1)}ms`);
    const explained = await f.db.execute<{ "QUERY PLAN": string }>(
      sql`EXPLAIN (ANALYZE, BUFFERS) ${readinessEventSelectionQuery(c.tenant, scope)}`,
    );
    console.info(
      "Readiness candidate EXPLAIN:\n" + explained.rows.map((r) => r["QUERY PLAN"]).join("\n"),
    );
    await clone(2000, 8000);
    expect(
      (await f.db.execute<{ id: string }>(readinessEventSelectionQuery(c.tenant, scope))).rows,
    ).toHaveLength(10001);
    await expect(read(c.tenant)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_readiness_scope_too_large" },
    });
  }, 60_000);
});
