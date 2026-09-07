import { createHash, randomUUID } from "node:crypto";
import {
  finalizeReceivingSchema,
  receivingDraftRecordSchema,
  receivingFinalizedRecordSchema,
  saveReceivingDraftSchema,
} from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { receivingFinalizationCommandDigest } from "../src/modules/traceability/receiving/us-receiving-finalization-command";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe("receiving finalize command compatibility", () => {
  const eventId = "a0000000-0000-4000-8000-000000000001";
  const command = {
    operationKey: randomUUID(),
    expectedDraftVersion: 1,
    expectedInputDigest: "a".repeat(64),
  };
  it("preserves original command digest for omitted and empty reviews and binds every other input", () => {
    const original = createHash("sha256")
      .update(
        JSON.stringify({ eventId, expectedDraftVersion: 1, expectedInputDigest: "a".repeat(64) }),
      )
      .digest("hex");
    expect(receivingFinalizationCommandDigest(eventId, command)).toBe(original);
    expect(
      receivingFinalizationCommandDigest(eventId, { ...command, reviewedExemptLines: [] }),
    ).toBe(original);
    for (const input of [
      { ...command, expectedDraftVersion: 2 },
      { ...command, expectedInputDigest: "b".repeat(64) },
      { ...command, reviewedExemptLines: [1] },
    ])
      expect(receivingFinalizationCommandDigest(eventId, input)).not.toBe(original);
    expect(receivingFinalizationCommandDigest(randomUUID(), command)).not.toBe(original);
    expect(
      receivingFinalizationCommandDigest(eventId, { ...command, reviewedExemptLines: [1] }),
    ).not.toBe(
      receivingFinalizationCommandDigest(eventId, { ...command, reviewedExemptLines: [2] }),
    );
  });
  it.each(
    [[1, 1], [2, 1], [0], [101], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)].map(
      (reviews) => ({ reviews }),
    ),
  )("rejects malformed reviews $reviews", ({ reviews }) => {
    expect(
      finalizeReceivingSchema.safeParse({ ...command, reviewedExemptLines: reviews }).success,
    ).toBe(false);
  });
});
describe.skipIf(!url)("receiving stored compatibility", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(fixture.db);
  });
  async function unchangedState() {
    return (
      await fixture.pool.query(
        "SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM traceability_events t WHERE tenant_id=$1) headers,(SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id,line_no) FROM receiving_event_items t WHERE tenant_id=$1) items,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenant_audit_events t WHERE organization_id=$1) audits",
        [c.tenant],
      )
    ).rows;
  }
  it("keeps omitted/null no-op saves at the same version and remembers the exact response", async () => {
    const created = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    const before = await unchangedState();
    const command = { operationKey: randomUUID(), expectedDraftVersion: 1, draft: c.draft };
    expect(await store.saveDraft(c.tenant, c.actor, created.id, command, "no-op")).toEqual(created);
    expect(await unchangedState()).toEqual(before);
    expect(await store.saveDraft(c.tenant, c.actor, created.id, command, "retry")).toEqual(created);
    const receipt = await fixture.pool.query(
      "SELECT result,input_digest FROM receiving_operations WHERE tenant_id=$1 AND operation_key=$2",
      [c.tenant, command.operationKey],
    );
    const parsed = saveReceivingDraftSchema.parse(command);
    expect(parsed.draft.items.every((item) => !Object.hasOwn(item, "exemptReceipt"))).toBe(true);
    expect(receipt.rows).toEqual([
      {
        result: created,
        input_digest: createHash("sha256")
          .update(JSON.stringify({ eventId: created.id, ...parsed }))
          .digest("hex"),
      },
    ]);
    const changed = structuredClone(c.draft);
    const first = changed.items[0];
    if (!first) throw new Error("Missing line");
    first.exemptReceipt = {
      evidenceUrl: "https://supplier.example.test/evidence",
      tlcHandling: "assign_if_missing",
      proposedTlc: "NEW",
    };
    const saved = await store.saveDraft(
      c.tenant,
      c.actor,
      created.id,
      { ...command, operationKey: randomUUID(), draft: changed },
      "changed",
    );
    expect(saved.draftVersion).toBe(2);
    expect(saved.draft.items[0]?.exemptReceipt).toEqual(first.exemptReceipt);
  });
  it("replays exact legacy create/save payloads before and after finalization without adding null keys", async () => {
    const create = { operationKey: randomUUID(), draft: c.draft };
    const saved = await store.createDraft(c.tenant, c.actor, create, "create");
    const save = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.draft, notes: "Saved legacy receipt" },
    };
    const updated = await store.saveDraft(c.tenant, c.actor, saved.id, save, "save");
    const legacy = (record: typeof saved) =>
      receivingDraftRecordSchema.parse({
        ...record,
        draft: {
          ...record.draft,
          items: record.draft.items.map(({ exemptReceipt, ...item }) => {
            void exemptReceipt;
            return item;
          }),
        },
      });
    const oldCreate = legacy(saved),
      oldSave = legacy(updated);
    // Seed original receipt bodies: production migration never rewrites historical JSON.
    for (const [key, result] of [
      [create.operationKey, oldCreate],
      [save.operationKey, oldSave],
    ] as const)
      await fixture.pool.query(
        "UPDATE receiving_operations SET result=$1 WHERE tenant_id=$2 AND operation_key=$3",
        [result, c.tenant, key],
      );
    const bytes = await fixture.pool.query(
      "SELECT operation_key,result::text,input_digest FROM receiving_operations WHERE tenant_id=$1 ORDER BY operation_key",
      [c.tenant],
    );
    const replay = async () => {
      expect(await store.createDraft(c.tenant, c.actor, create, "retry-create")).toEqual(oldCreate);
      expect(await store.saveDraft(c.tenant, c.actor, saved.id, save, "retry-save")).toEqual(
        oldSave,
      );
    };
    await replay();
    const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 2,
    });
    await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedInputDigest: check.inputDigest,
      },
      "finalize",
    );
    await replay();
    expect(
      (
        await fixture.pool.query(
          "SELECT operation_key,result::text,input_digest FROM receiving_operations WHERE tenant_id=$1 AND command<>'receiving.finalize' ORDER BY operation_key",
          [c.tenant],
        )
      ).rows,
    ).toEqual(bytes.rows);
  });
  it("reads and replays an explicitly v1 frozen success unchanged with old command bytes", async () => {
    const linked = c.draft.items[1];
    if (!linked) throw new Error("Missing linked line");
    c.draft.items = [linked];
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "legacy-create",
    );
    const time = "2026-09-07T10:00:00.000Z";
    await fixture.pool.query(
      "UPDATE product_traceability_profiles SET reviewed_at=$1 WHERE tenant_id=$2 AND product_id=$3",
      [time, c.tenant, c.product],
    );
    const location = {
      schemaVersion: 1,
      locationId: c.location,
      partyId: c.party,
      businessName: "Synthetic supplier",
      phoneNumber: "+1 555 010 0100",
      address: { kind: "street", streetAddress: "1 Test Street" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    };
    const snapshot = {
      snapshotVersion: 1,
      dateReceived: c.draft.dateReceived,
      locationId: c.location,
      previousSourceLocationId: c.location,
      receivedAtNote: null,
      notes: null,
      profileCode: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      locationDescription: location,
      previousSourceDescription: location,
      items: [
        {
          lineNo: 1,
          productId: c.product,
          lotId: c.lot,
          lotLinkMode: "link_existing",
          tlc: "00001",
          source: linked.source,
          quantity: "0.250",
          unitOfMeasure: "kg",
          supplierLotReference: null,
          notes: null,
          sourceDescription: location,
          productDescription: {
            snapshotVersion: 1,
            sourceProductId: c.product,
            productName: "Synthetic apples",
            brandName: null,
            commodity: null,
            variety: null,
            packagingSize: null,
            packagingStyle: null,
            gtin: null,
          },
          coverage: {
            coverageStatus: "not_covered",
            coverageRationale: "Synthetic QA review",
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
            reviewedBy: c.actor,
            reviewedAt: time,
          },
        },
      ],
      documents: [
        {
          document: {
            snapshotVersion: 1,
            documentId: c.document,
            type: "bol",
            typeOtherLabel: null,
            number: "00001",
            partyId: c.party,
            issuedOn: null,
            notes: null,
          },
          issuer: { id: c.party, name: "Synthetic supplier", legalName: null },
        },
      ],
      confirmation: {
        ruleVersion: "receiving-readiness-v2",
        inputDigest: "a".repeat(64),
        warnings: [],
      },
    };
    await fixture.pool.query(
      "UPDATE traceability_lots SET source_locked_at=$1 WHERE tenant_id=$2 AND id=$3",
      [time, c.tenant, c.lot],
    );
    await fixture.pool.query(
      "UPDATE traceability_events SET status='finalized',finalized_at=$1,finalized_by=$2,updated_at=$1,updated_by=$2,finalization_snapshot=$3 WHERE tenant_id=$4 AND id=$5",
      [time, c.actor, snapshot, c.tenant, saved.id],
    );
    const { draft, ...header } = saved;
    void draft;
    const result = receivingFinalizedRecordSchema.parse({
      ...header,
      status: "finalized",
      updatedAt: time,
      updatedBy: c.actor,
      finalizedAt: time,
      finalizedBy: c.actor,
      snapshot,
    });
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: "a".repeat(64),
    };
    const originalDigest = createHash("sha256")
      .update(
        JSON.stringify({
          eventId: saved.id,
          expectedDraftVersion: 1,
          expectedInputDigest: command.expectedInputDigest,
        }),
      )
      .digest("hex");
    await fixture.pool.query(
      "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.finalize',$2,$3,$4,$5)",
      [c.tenant, command.operationKey, originalDigest, saved.id, result],
    );
    const before = await unchangedState();
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(result);
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "v1-replay")).toEqual(result);
    expect(
      await store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        { ...command, reviewedExemptLines: [] },
        "v1-empty-replay",
      ),
    ).toEqual(result);
    expect(await unchangedState()).toEqual(before);
  });
});
