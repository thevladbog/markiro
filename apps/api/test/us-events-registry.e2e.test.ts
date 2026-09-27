import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsEventsStore } from "../src/modules/traceability/events/us-events-store";
import { readEventsRegistry } from "../src/modules/traceability/events/us-events-registry";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedMixedEvents } from "./support/us-events-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("global Events registry", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedMixedEvents>>;
  let store: UsEventsStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
    store = new UsEventsStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedMixedEvents(f);
  });
  const list = (query: unknown = {}) => store.list(c.tenant, c.actor, query);
  it("mixes Shipping with Receiving, filters Shipping before paging, and hides other tenants", async () => {
    const shipping = await seedShippingLifecycle(f.db);
    const finalized = await finalizeFixtureShipment(shipping, "20");
    const draft = await shipping.store.createDraft(
      shipping.tenant,
      shipping.actor,
      { operationKey: randomUUID(), draft: { ...shipping.draft, items: [], documentIds: [] } },
      "events-shipping-draft",
    );
    const page = await store.list(shipping.tenant, shipping.actor, { history: "all", limit: 100 });
    expect(page.items.some((row) => row.type === "receiving")).toBe(true);
    expect(page.items.filter((row) => row.type === "shipping").map((row) => row.id)).toEqual([
      draft.id,
      finalized.id,
    ]);
    expect(page.items.find((row) => row.id === finalized.id)).toMatchObject({
      type: "shipping",
      lineCount: 1,
      documentCount: 1,
      eventDate: shipping.draft.eventDate,
      locationDisplay: "Synthetic supplier",
    });
    expect(
      (
        await store.list(shipping.tenant, shipping.actor, { type: "shipping", limit: 1, offset: 1 })
      ).items.map((row) => row.id),
    ).toEqual([finalized.id]);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Renamed ship-from" })
      .where(eq(schema.traceabilityLocations.id, shipping.location));
    expect(
      (await store.list(shipping.tenant, shipping.actor, { type: "shipping" })).items.find(
        (row) => row.id === finalized.id,
      )?.locationDisplay,
    ).toBe("Synthetic supplier");
    expect((await list({ type: "shipping" })).items).toEqual([]);
  });

  it("fails closed for corrupt Shipping roots and wrong-type or orphan Shipping shells", async () => {
    const shipping = await seedShippingLifecycle(f.db);
    const saved = await shipping.store.createDraft(
      shipping.tenant,
      shipping.actor,
      { operationKey: randomUUID(), draft: { ...shipping.draft, items: [], documentIds: [] } },
      "events-shipping-corruption",
    );
    for (const mutation of [
      sql`UPDATE shipping_event_roots SET pending_draft_id=NULL WHERE tenant_id=${shipping.tenant} AND id=${saved.id}`,
      sql`DELETE FROM shipping_event_roots WHERE tenant_id=${shipping.tenant} AND id=${saved.id}`,
      sql`UPDATE traceability_events SET type='transformation',event_number='TRN-26-0001' WHERE tenant_id=${shipping.tenant} AND id=${saved.id}`,
    ]) {
      const rollback = new Error("rollback Shipping corruption specimen");
      await expect(
        f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          await tx.execute(mutation);
          await expect(
            readEventsRegistry(tx, shipping.tenant, {
              type: "shipping",
              history: "current",
              limit: 1,
              offset: 100000,
            }),
          ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
  });
  it("paginates a single mixed creation order with type and status applied before paging", async () => {
    const pages = await Promise.all([0, 2, 4].map((offset) => list({ limit: 2, offset })));
    expect(pages.flatMap((page) => page.items.map((row) => row.id))).toEqual(c.orderedIds);
    expect(
      (await list({ type: "transformation", limit: 2, offset: 1 })).items.map((row) => row.id),
    ).toEqual([c.pending.eventId, c.amended.eventId]);
    expect(
      (await list({ status: "draft", limit: 2, offset: 1 })).items.map((row) => row.id),
    ).toEqual([c.receivingDraft.id, c.pending.eventId]);
    expect((await list()).items.some((row) => row.id === c.foreignEventId)).toBe(false);
    const all = (await list()).items;
    expect(all.find((row) => row.id === c.origin.id)).toMatchObject({
      type: "receiving",
      lineCount: 2,
      documentCount: 1,
      eventDate: c.draft.dateReceived,
      previousSourceLocationId: c.location,
    });
    expect(all.find((row) => row.id === c.amended.eventId)).toMatchObject({
      type: "transformation",
      inputCount: 2,
      outputCount: 1,
      documentCount: 1,
      eventDate: "2026-09-26",
    });
  });
  it("keeps current and pending, excludes amended history unless all is requested", async () => {
    expect((await list({ status: "amended" })).items).toEqual([]);
    expect((await list({ history: "all", status: "amended" })).items.map((row) => row.id)).toEqual([
      c.original.id,
    ]);
    expect((await list({ history: "all" })).items).toHaveLength(7);
    expect((await list({ status: "void" })).items.map((row) => row.id)).toEqual([c.voidDraft.id]);
  });
  it("breaks equal creation timestamps globally by descending UUID, independent of update time", async () => {
    const rollback = new Error("rollback timestamp specimen");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE traceability_events SET created_at='2026-01-01T00:00:00Z' WHERE tenant_id=${c.tenant}`,
        );
        const rows = await readEventsRegistry(tx, c.tenant, {
          type: "all",
          history: "current",
          limit: 2,
          offset: 2,
        });
        expect(rows.items.map((row) => row.id)).toEqual(
          [...c.orderedIds].sort().reverse().slice(2, 4),
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("uses the greatest void revision when an abandoned amendment outlives its voided predecessor", async () => {
    await c.store.void(
      c.tenant,
      c.actor,
      c.pending.eventId,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 5,
        expectedDraftVersion: 1,
        reason: "Cancel",
      },
      "cancel",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.amended.eventId,
      { operationKey: randomUUID(), expectedLifecycleVersion: 6, reason: "End" },
      "end",
    );
    expect((await list({ type: "transformation" })).items.map((row) => row.id)).toEqual([
      c.voidDraft.id,
      c.pending.eventId,
    ]);
  });
  it("keeps frozen labels for both event types and resolves live labels only for drafts", async () => {
    const before = (await list({ history: "all" })).items;
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed receiving" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed processor" })
      .where(eq(schema.traceabilityLocations.id, c.processor));
    const after = (await list({ history: "all" })).items;
    for (const id of [c.origin.id, c.original.id, c.amended.eventId]) {
      expect(after.find((row) => row.id === id)?.locationDisplay).toBe(
        before.find((row) => row.id === id)?.locationDisplay,
      );
      expect(after.find((row) => row.id === id)?.locationDisplay).toBeTruthy();
    }
    expect(after.find((row) => row.id === c.receivingDraft.id)?.locationDisplay).toBe(
      "Changed receiving",
    );
    expect(after.find((row) => row.id === c.pending.eventId)?.locationDisplay).toBe(
      "Changed processor",
    );
    expect(JSON.stringify(after)).not.toContain("snapshot");
  });
  it("selects the latest void Receiving revision while preserving its legacy effective-receipt list", async () => {
    const draft = await c.receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.draft,
          items: c.draft.items.map((item) => ({
            ...item,
            tlc: `${item.tlc}-ended`,
            lotLinkMode: "create_on_finalize",
            lotId: null,
          })),
        },
      },
      "receiving-ended",
    );
    const ready = await c.receiving.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: 1,
    });
    await c.receiving.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "receiving-ended-finalize",
    );
    const pending = await c.receiving.amend(
      c.tenant,
      c.actor,
      draft.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correction",
      },
      "receiving-ended-amend",
    );
    await c.receiving.void(
      c.tenant,
      c.actor,
      pending.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel",
      },
      "receiving-ended-cancel",
    );
    await c.receiving.void(
      c.tenant,
      c.actor,
      draft.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        expectedDraftVersion: null,
        reason: "End",
      },
      "receiving-ended-void",
    );
    expect((await list({ search: draft.eventNumber })).items.map((row) => row.id)).toEqual([
      pending.eventId,
    ]);
    expect(
      (
        await c.receiving.listLiveRecords(c.tenant, c.actor, { search: draft.eventNumber })
      ).items.map((row) => row.id),
    ).toEqual([draft.id]);
  });
  it("searches only literal event numbers and authorizes before parsing", async () => {
    for (const search of ["NEW-OUTPUT", "Synthetic", "%", "_", "\\"])
      expect((await list({ search })).items).toEqual([]);
    expect(
      (await list({ search: c.saved.eventNumber.toLowerCase() })).items.map((row) => row.id),
    ).toEqual([c.pending.eventId, c.amended.eventId]);
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(list({ type: "shipping" })).rejects.toMatchObject({ status: 403 });
  });
  it.each(["receiving", "transformation"] as const)(
    "fails closed on %s corruption outside status and page",
    async (type) => {
      const rollback = new Error("rollback corrupt specimen");
      await expect(
        f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          const table =
            type === "receiving" ? schema.receivingEventRoots : schema.transformationEventRoots;
          await tx
            .update(table)
            .set({ pendingDraftId: null })
            .where(eq(table.id, type === "receiving" ? c.receivingDraft.id : c.original.id));
          await expect(
            readEventsRegistry(tx, c.tenant, {
              type,
              status: "amended",
              history: "current",
              limit: 1,
              offset: 100000,
            }),
          ).rejects.toMatchObject({ status: 503 });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it.each([
    "counter",
    "snapshot",
    "snapshot-predecessor",
    "snapshot-description",
    "predecessor",
    "number",
    "wrong-type",
    "missing-root",
  ])("rejects matching typed chain %s corruption even on an empty page", async (kind) => {
    const rollback = new Error("rollback malformed chain");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        if (kind === "counter")
          await tx.execute(
            sql`UPDATE transformation_event_roots SET lifecycle_version=99 WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
          );
        else if (kind === "snapshot")
          await tx.execute(
            sql`UPDATE traceability_events SET finalization_snapshot='{}'::jsonb WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
          );
        else if (kind === "snapshot-predecessor")
          await tx.execute(
            sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{previousRevisionId}',to_jsonb(${randomUUID()}::text)) WHERE tenant_id=${c.tenant} AND id=${c.amended.eventId}`,
          );
        else if (kind === "snapshot-description")
          await tx.execute(
            sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{processor,description}','{}'::jsonb) WHERE tenant_id=${c.tenant} AND id=${c.amended.eventId}`,
          );
        else if (kind === "predecessor")
          await tx.execute(
            sql`UPDATE traceability_events SET previous_revision_id=${c.original.id} WHERE tenant_id=${c.tenant} AND id=${c.pending.eventId}`,
          );
        else if (kind === "number")
          await tx.execute(
            sql`UPDATE traceability_events SET event_number='TRN-99-999999' WHERE tenant_id=${c.tenant} AND id=${c.pending.eventId}`,
          );
        else if (kind === "missing-root")
          await tx.execute(
            sql`DELETE FROM transformation_event_roots WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
          );
        else {
          await tx.execute(
            sql`ALTER TABLE traceability_events DROP CONSTRAINT traceability_events_lifecycle_valid`,
          );
          await tx.execute(
            sql`UPDATE traceability_events SET type='receiving',event_number='REC-99-999999' WHERE tenant_id=${c.tenant} AND id=${c.pending.eventId}`,
          );
        }
        await expect(
          readEventsRegistry(tx, c.tenant, {
            type: "transformation",
            history: "current",
            status: "void",
            search: kind === "number" ? "TRN-99-999999" : c.original.eventNumber,
            limit: 1,
            offset: 100000,
          }),
        ).rejects.toMatchObject({ status: 503 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("does not validate foreign or type-filtered unrelated roots", async () => {
    const rollback = new Error("rollback unrelated corruption");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE transformation_event_roots SET pending_draft_id=NULL WHERE id=${c.foreignEventId} OR (tenant_id=${c.tenant} AND id=${c.original.id})`,
        );
        const rows = await readEventsRegistry(tx, c.tenant, {
          type: "receiving",
          history: "current",
          limit: 50,
          offset: 0,
        });
        expect(rows.items.map((row) => row.id)).toEqual([
          c.lastReceiving.id,
          c.receivingDraft.id,
          c.origin.id,
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it.each([
    ["finalizedBy", ["finalizedBy"], "forged-actor"],
    ["finalizedAt", ["finalizedAt"], "2026-01-01T00:00:00.000Z"],
    ["invalid timestamp", ["finalizedAt"], "not-a-timestamp"],
    ["empty inputs", ["inputs"], []],
    ["empty outputs", ["outputs"], []],
    ["empty documents", ["documents"], []],
    ["input quantity", ["inputs", "0", "quantity"], "999"],
    ["input source", ["inputs", "0", "source", "id"], "11111111-1111-4111-8111-111111111111"],
    ["invalid input source", ["inputs", "0", "source"], "invalid-source"],
    ["output TLC", ["outputs", "0", "tlc"], "FORGED-TLC"],
    ["document number", ["documents", "0", "number"], "FORGED-DOC"],
  ])("rejects frozen %s corruption for normal and off-page reads", async (_name, path, value) => {
    const rollback = new Error("rollback frozen evidence corruption");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(path)}::jsonb)),${JSON.stringify(value)}::jsonb) WHERE tenant_id=${c.tenant} AND id=${c.amended.eventId}`,
        );
        for (const offset of [0, 100000]) {
          await expect(
            readEventsRegistry(tx, c.tenant, {
              type: "transformation",
              history: "all",
              search: c.original.eventNumber,
              limit: 50,
              offset,
            }),
          ).rejects.toMatchObject({ status: 503 });
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("retains reference and non-FTL input snapshots after mutable master data changes", async () => {
    const ref = await seedFinalizableTransformation(f, true);
    const nonFtlProduct = randomUUID();
    await f.db
      .insert(schema.products)
      .values({ id: nonFtlProduct, tenantId: ref.tenant, name: "Salt" });
    await f.db.insert(schema.productTraceabilityProfiles).values({
      tenantId: ref.tenant,
      productId: nonFtlProduct,
      productName: "Salt",
      coverageStatus: "not_covered",
      coverageRationale: "Reviewed non-FTL ingredient",
      reviewedBy: ref.actor,
      reviewedAt: new Date(),
    });
    const saved = await ref.store.saveDraft(
      ref.tenant,
      ref.actor,
      ref.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...ref.saved.draft,
          inputs: [
            ...ref.saved.draft.inputs,
            {
              kind: "non_ftl",
              productId: nonFtlProduct,
              sourceLocationId: ref.location,
              reference: "Supplier ingredient batch",
              quantity: "1",
              unitOfMeasure: "lb",
            },
          ],
        },
      },
      "mixed-input-save",
    );
    const ready = await ref.store.checkReadiness(ref.tenant, ref.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    expect(ready.state).toBe("complete");
    await ref.store.finalize(
      ref.tenant,
      ref.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "mixed-input-finalize",
    );
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ productName: "Changed product", coverageRationale: "Later review" })
      .where(eq(schema.productTraceabilityProfiles.tenantId, ref.tenant));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed location" })
      .where(eq(schema.traceabilityLocations.tenantId, ref.tenant));
    const rows = (await store.list(ref.tenant, ref.actor, { type: "transformation" })).items;
    expect(rows).toMatchObject([{ id: saved.id, inputCount: 3, outputCount: 1, documentCount: 1 }]);
    expect(rows[0]?.locationDisplay).toContain("Synthetic processor");
  });
});
