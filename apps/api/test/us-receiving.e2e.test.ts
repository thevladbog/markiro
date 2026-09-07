import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  emptyReceivingDraft as empty,
  emptyReceivingItem as item,
  seedReceivingTenant,
} from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US receiving draft persistence", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let context: Awaited<ReturnType<typeof seedReceivingTenant>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    context = await seedReceivingTenant(fixture.db);
  });
  const create = (draft: ReceivingDraft = empty, operationKey = randomUUID()) =>
    store.createDraft(context.tenant, context.actor, { operationKey, draft }, "create-request");
  const save = (
    id: string,
    draft: ReceivingDraft,
    expectedDraftVersion = 1,
    operationKey = randomUUID(),
  ) =>
    store.saveDraft(
      context.tenant,
      context.actor,
      id,
      { operationKey, expectedDraftVersion, draft },
      "save-request",
    );
  const get = (id: string) => store.getDraft(context.tenant, context.actor, id);
  const list = (query: unknown = {}) => store.listDrafts(context.tenant, context.actor, query);
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, context.tenant));
  const setRole = (role: string) =>
    fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, context.member));
  const fullDraft = (): ReceivingDraft => ({
    ...empty,
    dateReceived: "2026-09-06",
    locationId: context.location,
    previousSourceLocationId: context.location,
    documentIds: [context.document],
    items: [
      {
        ...item,
        productId: context.product,
        lotId: context.lot,
        lotLinkMode: "link_existing",
        tlc: "00001",
        quantity: "500.000",
        unitOfMeasure: "lb",
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://supplier.example.test/Case/A",
          resolvedLocationId: context.location,
        },
      },
    ],
  });

  it("lists an empty tenant with canonical pagination and no audit write", async () => {
    expect(await list()).toEqual({ items: [], limit: 50, offset: 0 });
    expect(await audits()).toEqual([]);
  });

  it("lists tenant-scoped header summaries and child counts without full draft contents", async () => {
    const created = await create(fullDraft());
    expect(await list()).toEqual({
      items: [
        {
          id: created.id,
          eventNumber: created.eventNumber,
          status: "draft",
          revision: 1,
          draftVersion: 1,
          timeZone: "America/Chicago",
          createdBy: context.actor,
          updatedBy: context.actor,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          dateReceived: "2026-09-06",
          locationId: context.location,
          previousSourceLocationId: context.location,
          lineCount: 1,
          documentCount: 1,
        },
      ],
      limit: 50,
      offset: 0,
    });
    expect(await audits()).toHaveLength(1);
  });

  it("paginates deterministically across equal creation timestamps", async () => {
    // Set the creation clock instead of rewriting immutable provenance afterward.
    const created = await (async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
      try {
        return await Promise.all([create(), create(), create()]);
      } finally {
        vi.useRealTimers();
      }
    })();
    expect(created.map((record) => record.createdAt)).toEqual(
      Array(3).fill("2026-09-06T12:00:00.000Z"),
    );
    const expectedIds = created
      .map((record) => record.id)
      .sort()
      .reverse();
    expect((await list({ limit: "2", offset: "0" })).items.map(({ id }) => id)).toEqual(
      expectedIds.slice(0, 2),
    );
    expect((await list({ limit: "2", offset: "2" })).items.map(({ id }) => id)).toEqual(
      expectedIds.slice(2),
    );
  });

  it("searches only a trimmed literal event-number substring", async () => {
    const [first, second] = await Promise.all([create(), create()]);
    expect((await list({ search: `  ${second.eventNumber.toLowerCase()}  ` })).items).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
    expect((await list({ search: first.eventNumber.slice(-2) })).items).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
    expect((await list({ search: "%_" })).items).toEqual([]);
  });

  it("keeps archived location IDs and document counts in saved summaries", async () => {
    const created = await create(fullDraft());
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ archived: true })
      .where(eq(schema.traceabilityLocations.id, context.location));
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ archivedAt: new Date() })
      .where(eq(schema.referenceDocuments.id, context.document));
    expect((await list()).items).toEqual([
      expect.objectContaining({
        id: created.id,
        locationId: context.location,
        previousSourceLocationId: context.location,
        documentCount: 1,
      }),
    ]);
  });

  it("tenant-scopes listings and denies an actor from another tenant", async () => {
    const own = await create();
    const foreign = await seedReceivingTenant(fixture.db);
    const foreignDraft = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: empty },
      "foreign-request",
    );
    expect((await list()).items.map(({ id }) => id)).toEqual([own.id]);
    expect(
      (await store.listDrafts(foreign.tenant, foreign.actor, {})).items.map(({ id }) => id),
    ).toEqual([foreignDraft.id]);
    await expect(store.listDrafts(context.tenant, foreign.actor, {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rechecks the current reader role and required profile on every listing", async () => {
    await create();
    await setRole("member");
    await expect(list()).rejects.toMatchObject({ status: 403 });
    await setRole("traceability_auditor");
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, context.tenant));
    await expect(list()).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
  });

  it("rejects strict malformed list queries before reading drafts", async () => {
    for (const query of [
      { tenantId: context.tenant },
      { limit: "01" },
      { offset: "-1" },
      { search: "bad\u0000value" },
    ])
      await expect(list(query)).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_master_data" },
      });
  });

  it("creates incomplete drafts with a stable number and exact atomic audit", async () => {
    const draft = {
      ...empty,
      items: [{ ...item, exemptSupplier: true, lotLinkMode: "link_existing" as const }],
    };
    const created = await create(draft);
    expect(created).toEqual({
      id: expect.any(String),
      eventNumber: expect.stringMatching(/^REC-\d{2}-0001$/),
      status: "draft",
      revision: 1,
      draftVersion: 1,
      timeZone: "America/Chicago",
      draft: { ...draft, items: draft.items.map((item) => ({ ...item, exemptReceipt: null })) },
      createdBy: context.actor,
      updatedBy: context.actor,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await get(created.id)).toEqual(created);
    expect(await audits()).toEqual([
      expect.objectContaining({
        organizationId: context.tenant,
        actorUserId: context.actor,
        action: "traceability.receiving.draft_created",
        targetType: "traceability_event",
        targetId: created.id,
        outcome: "success",
        before: null,
        after: created,
        requestId: "create-request",
      }),
    ]);
  });
  it("replaces header, ordered rows and documents without changing lots or event revision", async () => {
    const beforeLots = await fixture.db.select().from(schema.traceabilityLots);
    const created = await create(fullDraft());
    const draft = {
      ...fullDraft(),
      dateReceived: "2024-02-29",
      items: [{ ...item, quantity: "0.001" }, ...fullDraft().items],
      documentIds: [],
    };
    await fixture.db
      .update(schema.orgProfiles)
      .set({ timeZone: "America/Los_Angeles" })
      .where(eq(schema.orgProfiles.tenantId, context.tenant));
    const saved = await save(created.id, draft);
    expect(saved).toMatchObject({
      id: created.id,
      eventNumber: created.eventNumber,
      revision: 1,
      draftVersion: 2,
      timeZone: "America/Chicago",
      createdAt: created.createdAt,
      draft,
    });
    expect(await get(created.id)).toEqual(saved);
    expect(await fixture.db.select().from(schema.traceabilityLots)).toEqual(beforeLots);
    expect(await audits()).toEqual([
      expect.objectContaining({ after: created }),
      expect.objectContaining({
        organizationId: context.tenant,
        actorUserId: context.actor,
        action: "traceability.receiving.draft_saved",
        outcome: "success",
        targetType: "traceability_event",
        targetId: created.id,
        before: created,
        after: saved,
        requestId: "save-request",
      }),
    ]);
  });
  it("replays the original command result after intervening edits and across current writers", async () => {
    const key = randomUUID(),
      saveKey = randomUUID();
    const created = await create(empty, key);
    const changed = { ...empty, notes: "first" };
    const first = await save(created.id, changed, 1, saveKey);
    const latest = await save(created.id, { ...empty, notes: "second" }, 2);
    expect(await create(empty, key)).toEqual(created);
    expect(await save(created.id, changed, 1, saveKey)).toEqual(first);
    const secondActor = randomUUID();
    await fixture.db.insert(schema.user).values({
      id: secondActor,
      name: "Second receiving writer",
      email: `${secondActor}@example.test`,
    });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: context.tenant,
      userId: secondActor,
      role: "traceability_receiving",
      createdAt: new Date(),
    });
    expect(
      await store.createDraft(
        context.tenant,
        secondActor,
        { operationKey: key, draft: empty },
        "second-writer-retry",
      ),
    ).toEqual(created);
    expect(
      await store.saveDraft(
        context.tenant,
        secondActor,
        created.id,
        { operationKey: saveKey, expectedDraftVersion: 1, draft: changed },
        "second-writer-retry",
      ),
    ).toEqual(first);
    expect(await get(created.id)).toEqual(latest);
    expect(await audits()).toHaveLength(3);
    expect((await audits()).every((event) => event.actorUserId === context.actor)).toBe(true);
    await expect(create({ ...empty, notes: "different" }, key)).rejects.toMatchObject({
      response: { code: "receiving_operation_conflict" },
    });
    await expect(
      save(created.id, { ...empty, notes: "different" }, 1, saveKey),
    ).rejects.toMatchObject({ response: { code: "receiving_operation_conflict" } });
  });
  it("rejects stale saves, including stale equal values; current no-op does not advance or audit", async () => {
    const created = await create();
    expect(await save(created.id, empty)).toEqual(created);
    const changed = { ...empty, notes: "changed" };
    const saved = await save(created.id, changed);
    await expect(save(created.id, empty)).rejects.toMatchObject({
      response: { code: "receiving_draft_conflict" },
    });
    await expect(save(created.id, changed)).rejects.toMatchObject({
      response: { code: "receiving_draft_conflict" },
    });
    expect(await get(created.id)).toEqual(saved);
    expect(await audits()).toHaveLength(2);
  });
  it("serializes same-key creates and competing saves without duplicate records", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([create(empty, key), create(empty, key)]);
    expect(first).toEqual(second);
    const race = await Promise.allSettled([
      save(first.id, { ...empty, notes: "A" }),
      save(first.id, { ...empty, notes: "B" }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ response: { code: "receiving_draft_conflict" } }),
      }),
    ]);
    expect(await audits()).toHaveLength(2);
  });
  it("serializes identical save retries and keeps no-op receipts after later changes", async () => {
    const created = await create(),
      noOpKey = randomUUID(),
      saveKey = randomUUID();
    expect(await save(created.id, empty, 1, noOpKey)).toEqual(created);
    const changed = { ...empty, notes: "changed" };
    const [first, second] = await Promise.all([
      save(created.id, changed, 1, saveKey),
      save(created.id, changed, 1, saveKey),
    ]);
    expect(second).toEqual(first);
    expect(await save(created.id, empty, 1, noOpKey)).toEqual(created);
    expect(await get(created.id)).toEqual(first);
    expect(await audits()).toHaveLength(2);
  });
  it("allocates unique stable numbers for concurrent distinct creates", async () => {
    const results = await Promise.all([create(), create(), create()]);
    expect(new Set(results.map((record) => record.id)).size).toBe(3);
    expect(results.map((record) => record.eventNumber.slice(-4)).sort()).toEqual([
      "0001",
      "0002",
      "0003",
    ]);
  });
  it("scopes keys to tenants and save targets", async () => {
    const key = randomUUID();
    const first = await create(empty, key),
      second = await create();
    await save(first.id, empty, 1, key);
    await expect(save(second.id, empty, 1, key)).rejects.toMatchObject({
      response: { code: "receiving_operation_conflict" },
    });
    const foreign = await seedReceivingTenant(fixture.db);
    expect(
      (
        await store.createDraft(
          foreign.tenant,
          foreign.actor,
          { operationKey: key, draft: empty },
          "foreign-request",
        )
      ).id,
    ).not.toBe(first.id);
    await expect(store.getDraft(foreign.tenant, foreign.actor, first.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.saveDraft(
        foreign.tenant,
        foreign.actor,
        first.id,
        { operationKey: randomUUID(), expectedDraftVersion: 1, draft: empty },
        "foreign-request",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(["product", "lot", "location", "document", "source"])(
    "rejects foreign selected %s without partial writes",
    async (kind) => {
      const foreign = await seedReceivingTenant(fixture.db);
      const draft: ReceivingDraft = {
        ...empty,
        items: [
          {
            ...item,
            productId: kind === "product" ? foreign.product : null,
            lotId: kind === "lot" ? foreign.lot : null,
            source: kind === "source" ? { kind: "location", locationId: foreign.location } : null,
          },
        ],
        locationId: kind === "location" ? foreign.location : null,
        documentIds: kind === "document" ? [foreign.document] : [],
      };
      await expect(create(draft)).rejects.toMatchObject({ status: 404 });
      expect(await audits()).toEqual([]);
    },
  );
  it("allows historical reads/retries after archival, but rejects changed saves with archived references", async () => {
    const key = randomUUID(),
      draft = fullDraft();
    const created = await create(draft, key);
    await fixture.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, context.product));
    expect(await get(created.id)).toEqual(created);
    expect(await create(draft, key)).toEqual(created);
    await expect(save(created.id, { ...draft, notes: "changed" })).rejects.toMatchObject({
      status: 409,
    });
    expect(await get(created.id)).toEqual(created);
  });
  it.each(["location", "party", "lot", "document"])(
    "rejects inactive %s on changed saves without altering the draft",
    async (kind) => {
      const created = await create(fullDraft());
      if (kind === "location")
        await fixture.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, context.location));
      if (kind === "party")
        await fixture.db
          .update(schema.traceabilityParties)
          .set({ archived: true })
          .where(eq(schema.traceabilityParties.id, context.party));
      if (kind === "lot")
        await fixture.db
          .update(schema.traceabilityLots)
          .set({ status: "quarantined" })
          .where(eq(schema.traceabilityLots.id, context.lot));
      if (kind === "document")
        await fixture.db
          .update(schema.referenceDocuments)
          .set({ archivedAt: new Date() })
          .where(eq(schema.referenceDocuments.id, context.document));
      await expect(save(created.id, { ...fullDraft(), notes: "changed" })).rejects.toMatchObject({
        response: { code: "receiving_reference_inactive" },
      });
      expect(await get(created.id)).toEqual(created);
      expect(await audits()).toHaveLength(1);
    },
  );
  it.each([
    "traceability_auditor",
    "traceability_shipping",
    "traceability_production",
    "member",
    "unknown",
  ])("denies writes and successful retries after role changes to %s", async (role) => {
    const key = randomUUID(),
      created = await create(empty, key);
    await setRole(role);
    await expect(create(empty, key)).rejects.toMatchObject({ status: 403 });
    await expect(save(created.id, empty)).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toHaveLength(1);
  });
  it.each(["owner", "admin", "manager", "traceability_qa", "traceability_receiving"])(
    "allows receiving writer %s",
    async (role) => {
      await setRole(role);
      const created = await create();
      expect(await get(created.id)).toEqual(created);
      expect((await save(created.id, { ...empty, notes: "saved" })).draftVersion).toBe(2);
    },
  );
  it("rolls back children, header, counter, receipt and audit when audit insertion fails", async () => {
    const created = await create(fullDraft()),
      key = randomUUID();
    await fixture.pool.query(
      "CREATE FUNCTION reject_receiving_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'traceability.receiving.%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    await fixture.pool.query(
      "CREATE TRIGGER reject_receiving_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_receiving_audit()",
    );
    try {
      await expect(save(created.id, empty)).rejects.toThrow();
      await expect(create(empty, key)).rejects.toThrow();
      expect(await get(created.id)).toEqual(created);
      expect(await audits()).toHaveLength(1);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_receiving_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_receiving_audit()");
    }
    expect((await create(empty, key)).eventNumber).toMatch(/-0002$/);
  });
});
