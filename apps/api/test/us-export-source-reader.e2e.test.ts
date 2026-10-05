import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import {
  receivingFinalizationSnapshotV1Schema,
  receivingFinalizationSnapshotV2Schema,
  receivingFinalizationSnapshotV3Schema,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readUsExportSources,
  readUsExportSourcesInTransaction,
} from "../src/modules/traceability/export/source-reader";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import * as receivingHistory from "../src/modules/traceability/receiving/us-receiving-history";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
  voidStoredEvent,
} from "./support/us-receiving-lifecycle-storage";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const incomplete = "available_records_incomplete";
const candidate = "export_ready_candidate";
const url = process.env.US_TEST_DATABASE_URL;

describe("export source input boundary without database access", () => {
  it("rejects empty, oversized, malformed and duplicate pins before SQL", async () => {
    const f = createDb("postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev");
    const id = randomUUID();
    try {
      for (const pins of [
        [],
        [{ eventId: "bad", revision: 1 }],
        [{ eventId: id, revision: 0 }],
        [{ eventId: id, revision: 1.5 }],
        [{ eventId: id, revision: 2147483648 }],
        [{ eventId: id, revision: 1, type: "receiving" }],
        [
          { eventId: id, revision: 1 },
          { eventId: id.toUpperCase(), revision: 1 },
        ],
        Array.from({ length: 501 }, () => ({ eventId: randomUUID(), revision: 1 })),
      ]) {
        await expect(
          readUsExportSources(f.db, randomUUID(), randomUUID(), pins, incomplete),
        ).rejects.toMatchObject({ status: 400, response: { code: "invalid_us_export_sources" } });
      }
    } finally {
      await f.pool.end();
    }
  });
});

describe.skipIf(!url)("authorized pinned export source reader", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated U.S. database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  async function receiving() {
    const c = await seedCompleteReceiving(f.db);
    const store = new UsReceivingStore(f.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "export-fixture",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const original = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "export-fixture-finalize",
    );
    return { ...c, store, original };
  }

  it("keeps caller-owned source reads on the original snapshot across a committed amendment", async () => {
    const c = await receiving();
    const pins = [{ eventId: c.original.id, revision: 1 }];
    const observed = await transformationTransaction(f.db, async (tx) => {
      const first = await readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, candidate);
      const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
      await finalizeStoredAmendment(f, c.tenant, amendmentId);
      const second = await readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, candidate);
      return { first, second };
    });
    expect(observed.first).toEqual([
      {
        eventId: c.original.id,
        revision: 1,
        type: "receiving",
        timeZone: "America/Chicago",
        lifecycle: "current_finalized",
        payload: { kind: "frozen", snapshot: c.original.snapshot },
      },
    ]);
    expect(observed.second).toEqual(observed.first);
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, candidate),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "us_export_source_not_current_finalized" },
    });
  });

  it("enforces pin validation and foreign source isolation inside the caller transaction", async () => {
    const a = await receiving();
    const b = await receiving();
    const pin = { eventId: a.original.id, revision: 1 };
    for (const pins of [[], [{ ...pin, eventId: "bad" }], [pin, pin]]) {
      await expect(
        transformationTransaction(f.db, (tx) =>
          readUsExportSourcesInTransaction(tx, a.tenant, a.actor, pins, incomplete),
        ),
      ).rejects.toMatchObject({ status: 400, response: { code: "invalid_us_export_sources" } });
    }
    await expect(
      transformationTransaction(f.db, (tx) =>
        readUsExportSourcesInTransaction(
          tx,
          a.tenant,
          a.actor,
          [{ eventId: b.original.id, revision: 1 }],
          incomplete,
        ),
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "us_export_source_not_found" } });
  });

  it("rejects historical candidate pins and corrupt stored snapshots inside the caller transaction", async () => {
    const c = await receiving();
    const pins = [{ eventId: c.original.id, revision: 1 }];
    const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
    await finalizeStoredAmendment(f, c.tenant, amendmentId);
    await expect(
      transformationTransaction(f.db, (tx) =>
        readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, candidate),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "us_export_source_not_current_finalized" },
    });
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE traceability_events DISABLE TRIGGER USER`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: { ...c.original.snapshot, snapshotVersion: 999 } })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, c.original.id),
          ),
        );
      await tx.execute(sql`ALTER TABLE traceability_events ENABLE TRIGGER USER`);
    });
    await expect(
      transformationTransaction(f.db, (tx) =>
        readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, incomplete),
      ),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
  });

  it("reloads export capability and processor profile inside the caller transaction", async () => {
    const c = await receiving();
    const pins = [{ eventId: c.original.id, revision: 1 }];
    await f.db
      .update(schema.member)
      .set({ role: "traceability_receiving" })
      .where(eq(schema.member.id, c.member));
    await expect(
      transformationTransaction(f.db, (tx) =>
        readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, incomplete),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(
      transformationTransaction(f.db, (tx) =>
        readUsExportSourcesInTransaction(tx, c.tenant, c.actor, pins, incomplete),
      ),
    ).rejects.toMatchObject({ status: 403, response: { code: "traceability_profile_required" } });
  });

  it("binds exact historical Receiving bytes to server-owned event/revision and orders pins", async () => {
    const c = await receiving();
    const revisionId = await createStoredAmendment(f, c.tenant, c.original.id);
    const revisedSnapshot = await finalizeStoredAmendment(f, c.tenant, revisionId);
    const pins = [
      { eventId: revisionId, revision: 2 },
      { eventId: c.original.id, revision: 1 },
    ];
    const result = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    expect(result.map(({ eventId, revision }) => [eventId, revision])).toEqual(
      [...pins]
        .sort((a, b) => a.eventId.localeCompare(b.eventId))
        .map(({ eventId, revision }) => [eventId, revision]),
    );
    expect(result.find((r) => r.eventId === c.original.id)).toEqual({
      eventId: c.original.id,
      revision: 1,
      type: "receiving",
      timeZone: "America/Chicago",
      lifecycle: "historical_finalized",
      payload: { kind: "frozen", snapshot: c.original.snapshot },
    });
    expect(result.find((r) => r.eventId === revisionId)).toEqual({
      eventId: revisionId,
      revision: 2,
      type: "receiving",
      timeZone: "America/Chicago",
      lifecycle: "current_finalized",
      payload: { kind: "frozen", snapshot: revisedSnapshot },
    });
    expect(
      await readUsExportSources(f.db, c.tenant, c.actor, [...pins].reverse(), incomplete),
    ).toEqual(result);
    expect(
      await readUsExportSources(
        f.db,
        c.tenant,
        c.actor,
        [{ eventId: revisionId, revision: 2 }],
        candidate,
      ),
    ).toEqual([result.find((r) => r.eventId === revisionId)]);
    await expect(
      readUsExportSources(
        f.db,
        c.tenant,
        c.actor,
        [{ eventId: c.original.id, revision: 1 }],
        candidate,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "us_export_source_not_current_finalized" },
    });
  });

  it("preserves mixed Receiving v1/v2/v3 frozen payloads at their exact server-owned pins", async () => {
    const c = await receiving();
    const v2 = receivingFinalizationSnapshotV2Schema.parse(c.original.snapshot);
    const linkedItem = c.draft.items[1];
    if (!linkedItem) throw new Error("Missing linked fixture item");
    const saved = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: { ...c.draft, items: [linkedItem] } },
      "export-legacy-receiving",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const legacy = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "export-legacy-receiving-finalize",
    );
    const built = receivingFinalizationSnapshotV2Schema.parse(legacy.snapshot);
    const { reviewedExemptLines, ...confirmation } = built.confirmation;
    void reviewedExemptLines;
    // Derive legacy v1 from a real ordinary-receipt builder result, removing only
    // v2 additions; the authoritative strict v1 schema validates every old field.
    const v1 = receivingFinalizationSnapshotV1Schema.parse({
      ...built,
      snapshotVersion: 1,
      items: built.items.map(({ receiptBasis, ...item }) => {
        void receiptBasis;
        return item;
      }),
      confirmation: { ...confirmation, ruleVersion: "receiving-readiness-v2" },
    });
    // Legacy storage specimen in this invocation's owned disposable child DB.
    // Production frozen updates are immutable; no shared database guard is relaxed.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE traceability_events DISABLE TRIGGER USER`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: v1 })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, legacy.id),
          ),
        );
      await tx.execute(sql`ALTER TABLE traceability_events ENABLE TRIGGER USER`);
    });
    const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
    const v3 = receivingFinalizationSnapshotV3Schema.parse(
      await finalizeStoredAmendment(f, c.tenant, amendmentId),
    );
    const pins = [
      { eventId: amendmentId, revision: 2 },
      { eventId: c.original.id, revision: 1 },
      { eventId: legacy.id, revision: 1 },
    ];
    const result = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    expect(result).toHaveLength(3);
    expect(result.find((r) => r.eventId === legacy.id)).toEqual({
      eventId: legacy.id,
      revision: 1,
      type: "receiving",
      timeZone: "America/Chicago",
      lifecycle: "current_finalized",
      payload: { kind: "frozen", snapshot: v1 },
    });
    expect(result.find((r) => r.eventId === c.original.id)).toEqual({
      eventId: c.original.id,
      revision: 1,
      type: "receiving",
      timeZone: "America/Chicago",
      lifecycle: "historical_finalized",
      payload: { kind: "frozen", snapshot: v2 },
    });
    expect(result.find((r) => r.eventId === amendmentId)).toEqual({
      eventId: amendmentId,
      revision: 2,
      type: "receiving",
      timeZone: "America/Chicago",
      lifecycle: "current_finalized",
      payload: { kind: "frozen", snapshot: v3 },
    });
    expect(
      await readUsExportSources(
        f.db,
        c.tenant,
        c.actor,
        [{ eventId: legacy.id, revision: 1 }],
        candidate,
      ),
    ).toEqual([
      {
        eventId: legacy.id,
        revision: 1,
        type: "receiving",
        timeZone: "America/Chicago",
        lifecycle: "current_finalized",
        payload: { kind: "frozen", snapshot: v1 },
      },
    ]);
  });

  it("keeps distinct same-TLC origins without collapsing their frozen source identities", async () => {
    const c = await receiving();
    const location = randomUUID();
    const [source] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!source) throw new Error("Missing fixture source");
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...source, id: location, name: "Other source", streetAddress: "2 Other Street" });
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing fixture item");
    const saved = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.draft,
          previousSourceLocationId: location,
          items: [{ ...first, source: { kind: "location", locationId: location } }],
        },
      },
      "equal-tlc",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const other = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "equal-tlc-finalize",
    );
    const result = await readUsExportSources(
      f.db,
      c.tenant,
      c.actor,
      [
        { eventId: c.original.id, revision: 1 },
        { eventId: other.id, revision: 1 },
      ],
      candidate,
    );
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.eventId === other.id)?.payload).toEqual({
      kind: "frozen",
      snapshot: other.snapshot,
    });
    expect(other.snapshot.items[0]?.tlc).toBe(c.original.snapshot.items[0]?.tlc);
    expect(other.snapshot.items[0]?.lotId).not.toBe(c.original.snapshot.items[0]?.lotId);
  });

  it("retains original and amendment saved drafts and void content only in incomplete mode", async () => {
    const c = await receiving();
    const draft = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, items: [], notes: "Saved incomplete values" },
      },
      "draft",
    );
    const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
    const amendment = await c.store.getLiveRecord(c.tenant, c.actor, amendmentId);
    if (amendment.content.kind !== "draft") throw new Error("Expected saved draft");
    const pins = [
      { eventId: draft.id, revision: 1 },
      { eventId: amendmentId, revision: 2 },
    ];
    const result = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    expect(result.find((r) => r.eventId === draft.id)).toMatchObject({
      lifecycle: "draft",
      payload: { kind: "saved_draft", draft: draft.draft },
    });
    expect(result.find((r) => r.eventId === amendmentId)?.payload).toEqual({
      kind: "saved_draft",
      draft: amendment.content.draft,
    });
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, candidate),
    ).rejects.toMatchObject({ status: 409 });
    await voidStoredEvent(f, c.tenant, draft.id);
    expect(
      await readUsExportSources(
        f.db,
        c.tenant,
        c.actor,
        [{ eventId: draft.id, revision: 1 }],
        incomplete,
      ),
    ).toMatchObject([{ lifecycle: "void", payload: { kind: "saved_draft", draft: draft.draft } }]);
  });

  it("reads frozen Transformation and Shipping and their saved draft variants", async () => {
    const t = await seedFinalizableTransformation(f);
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Pacific/Auckland" })
      .where(eq(schema.orgProfiles.tenantId, t.tenant));
    expect(
      await readUsExportSources(
        f.db,
        t.tenant,
        t.actor,
        [{ eventId: t.saved.id, revision: 1 }],
        incomplete,
      ),
    ).toMatchObject([
      {
        type: "transformation",
        timeZone: "America/Chicago",
        lifecycle: "draft",
        payload: { kind: "saved_draft", draft: t.saved.draft },
      },
    ]);
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "America/Chicago" })
      .where(eq(schema.orgProfiles.tenantId, t.tenant));
    const finalized = await t.store.finalize(
      t.tenant,
      t.actor,
      t.saved.id,
      t.command,
      "export-transformation",
    );
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Pacific/Auckland" })
      .where(eq(schema.orgProfiles.tenantId, t.tenant));
    expect(
      await readUsExportSources(
        f.db,
        t.tenant,
        t.actor,
        [{ eventId: finalized.id, revision: 1 }],
        candidate,
      ),
    ).toEqual([
      {
        type: "transformation",
        timeZone: "America/Chicago",
        eventId: finalized.id,
        revision: 1,
        lifecycle: "current_finalized",
        payload: { kind: "frozen", snapshot: finalized.snapshot },
      },
    ]);
    const s = await seedShippingLifecycle(f.db);
    const saved = await s.store.createDraft(
      s.tenant,
      s.actor,
      { operationKey: randomUUID(), draft: s.draft },
      "export-shipping-draft",
    );
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Pacific/Auckland" })
      .where(eq(schema.orgProfiles.tenantId, s.tenant));
    expect(
      await readUsExportSources(
        f.db,
        s.tenant,
        s.actor,
        [{ eventId: saved.id, revision: 1 }],
        incomplete,
      ),
    ).toMatchObject([
      {
        type: "shipping",
        timeZone: "America/Chicago",
        lifecycle: "draft",
        payload: { kind: "saved_draft", draft: saved.draft },
      },
    ]);
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "America/Chicago" })
      .where(eq(schema.orgProfiles.tenantId, s.tenant));
    const shipment = await finalizeFixtureShipment(s, "20");
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Pacific/Auckland" })
      .where(eq(schema.orgProfiles.tenantId, s.tenant));
    expect(
      await readUsExportSources(
        f.db,
        s.tenant,
        s.actor,
        [{ eventId: shipment.id, revision: 1 }],
        candidate,
      ),
    ).toEqual([
      {
        type: "shipping",
        timeZone: "America/Chicago",
        eventId: shipment.id,
        revision: 1,
        lifecycle: "current_finalized",
        payload: { kind: "frozen", snapshot: shipment.snapshot },
      },
    ]);
  });

  it("retains captured event timezones across lifecycle states when the tenant default changes", async () => {
    const c = await receiving();
    const draft = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: { ...c.draft, items: [] } },
      "timezone-draft",
    );
    const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
    await f.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Pacific/Auckland" })
      .where(eq(schema.orgProfiles.tenantId, c.tenant));
    const pins = [
      { eventId: c.original.id, revision: 1 },
      { eventId: amendmentId, revision: 2 },
      { eventId: draft.id, revision: 1 },
    ];
    const before = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    expect(
      before.map((record) => ({ eventId: record.eventId, timeZone: record.timeZone })),
    ).toEqual(
      [...pins]
        .sort((a, b) => a.eventId.localeCompare(b.eventId))
        .map((pin) => ({ eventId: pin.eventId, timeZone: "America/Chicago" })),
    );
    expect(before.find((record) => record.eventId === c.original.id)?.payload).toEqual({
      kind: "frozen",
      snapshot: c.original.snapshot,
    });
    await finalizeStoredAmendment(f, c.tenant, amendmentId);
    await voidStoredEvent(f, c.tenant, draft.id);
    const after = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    expect(
      after.map((record) => ({
        eventId: record.eventId,
        timeZone: record.timeZone,
        lifecycle: record.lifecycle,
      })),
    ).toEqual(
      [...pins]
        .sort((a, b) => a.eventId.localeCompare(b.eventId))
        .map((pin) => ({
          eventId: pin.eventId,
          timeZone: "America/Chicago",
          lifecycle:
            pin.eventId === c.original.id
              ? "historical_finalized"
              : pin.eventId === amendmentId
                ? "current_finalized"
                : "void",
        })),
    );
    for (const mode of [candidate, incomplete] as const) {
      expect(
        await readUsExportSources(
          f.db,
          c.tenant,
          c.actor,
          [{ eventId: amendmentId, revision: 2 }],
          mode,
        ),
      ).toMatchObject([
        {
          eventId: amendmentId,
          revision: 2,
          timeZone: "America/Chicago",
          lifecycle: "current_finalized",
        },
      ]);
    }
  });

  it("hides foreign, missing and wrong revision pins", async () => {
    const a = await receiving(),
      b = await receiving();
    for (const pin of [
      { eventId: b.original.id, revision: 1 },
      { eventId: randomUUID(), revision: 1 },
      { eventId: a.original.id, revision: 2 },
    ]) {
      await expect(
        readUsExportSources(f.db, a.tenant, a.actor, [pin], incomplete),
      ).rejects.toMatchObject({ status: 404, response: { code: "us_export_source_not_found" } });
    }
  });

  it("reloads capability, membership and processor profile on every invocation", async () => {
    const c = await receiving();
    const pins = [{ eventId: c.original.id, revision: 1 }];
    await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_receiving" })
      .where(eq(schema.member.id, c.member));
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete),
    ).rejects.toMatchObject({ status: 403 });
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete),
    ).rejects.toMatchObject({ status: 403, response: { code: "traceability_profile_required" } });
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete),
    ).rejects.toMatchObject({ status: 403, response: { code: "traceability_profile_required" } });
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(
      readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ["unsupported numeric", 999],
    ["malformed string", "2"],
  ] as const)(
    "fails unavailable for a %s snapshot version with otherwise valid frozen content",
    async (_label, version) => {
      const c = await receiving();
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE traceability_events DISABLE TRIGGER USER`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: { ...c.original.snapshot, snapshotVersion: version } })
          .where(
            and(
              eq(schema.traceabilityEvents.tenantId, c.tenant),
              eq(schema.traceabilityEvents.id, c.original.id),
            ),
          );
        await tx.execute(sql`ALTER TABLE traceability_events ENABLE TRIGGER USER`);
      });
      await expect(
        readUsExportSources(
          f.db,
          c.tenant,
          c.actor,
          [{ eventId: c.original.id, revision: 1 }],
          incomplete,
        ),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    },
  );

  it("never mixes root states when amendment finalization interleaves two source reads", async () => {
    const c = await receiving();
    const amendmentId = await createStoredAmendment(f, c.tenant, c.original.id);
    const pins = [
      { eventId: c.original.id, revision: 1 },
      { eventId: amendmentId, revision: 2 },
    ];
    const before = await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete);
    const real = receivingHistory.readReceivingLiveRecord;
    // Scheduling only: all queries and the concurrent writer run on the real disposable DB.
    const hook = vi
      .spyOn(receivingHistory, "readReceivingLiveRecord")
      .mockImplementationOnce(async (...args) => {
        const record = await real(...args);
        await finalizeStoredAmendment(f, c.tenant, amendmentId);
        return record;
      });
    try {
      expect(await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete)).toEqual(before);
    } finally {
      hook.mockRestore();
    }
    expect(await readUsExportSources(f.db, c.tenant, c.actor, pins, incomplete)).toMatchObject(
      before.map((r) => ({
        eventId: r.eventId,
        lifecycle: r.eventId === amendmentId ? "current_finalized" : "historical_finalized",
      })),
    );
  });

  it("rejects corrupt Shipping root/header identity in both modes", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE shipping_event_roots DISABLE TRIGGER USER`);
      await tx
        .update(schema.shippingEventRoots)
        .set({ eventNumber: "SHP-26-9999" })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, shipment.id),
          ),
        );
      await tx.execute(sql`ALTER TABLE shipping_event_roots ENABLE TRIGGER USER`);
    });
    for (const mode of [candidate, incomplete] as const) {
      await expect(
        readUsExportSources(f.db, c.tenant, c.actor, [{ eventId: shipment.id, revision: 1 }], mode),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    }
  });

  it("preserves valid historical Shipping pins after an amendment", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "20");
    const pending = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct shipping record",
      },
      "export-shipping-amend",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, pending.eventId, {
      expectedDraftVersion: 1,
    });
    const current = await c.store.finalize(
      c.tenant,
      c.actor,
      pending.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "export-shipping-amended-finalize",
    );
    const result = await readUsExportSources(
      f.db,
      c.tenant,
      c.actor,
      [
        { eventId: original.id, revision: 1 },
        { eventId: current.id, revision: 2 },
      ],
      incomplete,
    );
    expect(result.find((r) => r.eventId === original.id)).toEqual({
      eventId: original.id,
      revision: 1,
      type: "shipping",
      timeZone: "America/Chicago",
      lifecycle: "historical_finalized",
      payload: { kind: "frozen", snapshot: original.snapshot },
    });
    expect(result.find((r) => r.eventId === current.id)).toEqual({
      eventId: current.id,
      revision: 2,
      type: "shipping",
      timeZone: "America/Chicago",
      lifecycle: "current_finalized",
      payload: { kind: "frozen", snapshot: current.snapshot },
    });
  });
});
