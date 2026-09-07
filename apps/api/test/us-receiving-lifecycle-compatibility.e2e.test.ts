import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedExemptReceiving } from "./support/us-receiving-fixture";
import { finalizeStoredAmendment } from "./support/us-receiving-lifecycle-storage";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving lifecycle historical command compatibility", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const amend = (version: number) => ({
    commandVersion: 2,
    operationKey: randomUUID(),
    expectedLifecycleVersion: version,
    reason: "Correct receipt",
  });
  const cancel = (version: number, draft: number | null) => ({
    ...amend(version),
    expectedDraftVersion: draft,
    reason: "Entered in error",
  });
  async function prepare(reviewedExemptLines: number[] = []) {
    const create = { operationKey: randomUUID(), draft: c.draft };
    const created = await store.createDraft(c.tenant, c.actor, create, "create");
    const save = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.draft, notes: "Saved receipt note" },
    };
    const saved = await store.saveDraft(c.tenant, c.actor, created.id, save, "save");
    const ready = await store.checkReadiness(c.tenant, c.actor, created.id, {
      expectedDraftVersion: 2,
    });
    const finalize = {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
      reviewedExemptLines,
    };
    const frozen = await store.finalize(c.tenant, c.actor, created.id, finalize, "finalize");
    return { create, created, save, saved, finalize, frozen };
  }
  async function receipts() {
    return (
      await f.pool.query(
        "SELECT operation_key,input_digest,result::text,created_at FROM receiving_operations WHERE tenant_id=$1 AND command IN ('receiving.create','receiving.save','receiving.finalize') ORDER BY operation_key",
        [c.tenant],
      )
    ).rows;
  }
  it("replays unchanged legacy-format create/save/finalize receipts after amendment and effective void", async () => {
    const p = await prepare();
    const originalBytes = await receipts();
    const amendment = await store.amend(c.tenant, c.actor, p.created.id, amend(2), "amend");
    // This raw v3 finalization is a fixture for replay after supersession,
    // not proof of the still-pending amendment finalization command.
    await finalizeStoredAmendment(f, c.tenant, amendment.eventId);
    const assertReplay = async () => {
      const audits = (
        await f.pool.query(
          "SELECT id FROM tenant_audit_events WHERE organization_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows;
      expect(await store.createDraft(c.tenant, c.actor, p.create, "retry-create")).toEqual(
        p.created,
      );
      expect(await store.saveDraft(c.tenant, c.actor, p.created.id, p.save, "retry-save")).toEqual(
        p.saved,
      );
      expect(
        await store.finalize(c.tenant, c.actor, p.created.id, p.finalize, "retry-finalize"),
      ).toEqual(p.frozen);
      expect(await receipts()).toEqual(originalBytes);
      expect(
        (
          await f.pool.query(
            "SELECT id FROM tenant_audit_events WHERE organization_id=$1 ORDER BY id",
            [c.tenant],
          )
        ).rows,
      ).toEqual(audits);
    };
    expect((await store.getLiveRecord(c.tenant, c.actor, p.created.id)).status).toBe("amended");
    await assertReplay();
    const voided = await store.void(c.tenant, c.actor, amendment.eventId, cancel(4, null), "void");
    expect(voided.record).toMatchObject({
      status: "void",
      content: { kind: "finalized", snapshot: { snapshotVersion: 3 } },
    });
    await assertReplay();
    expect((await store.getLiveRecord(c.tenant, c.actor, p.created.id)).status).toBe("amended");
  });
  it("starts and voids from a synthetic version-pinned v1 specimen without rewriting its content", async () => {
    const p = await prepare();
    if (p.frozen.snapshot.snapshotVersion !== 2) throw new Error("Expected current v2 writer");
    const v1 = {
      ...p.frozen.snapshot,
      snapshotVersion: 1,
      items: p.frozen.snapshot.items.map(({ receiptBasis, ...item }) => {
        void receiptBasis;
        return item;
      }),
      confirmation: {
        ruleVersion: "receiving-readiness-v2",
        inputDigest: p.frozen.snapshot.confirmation.inputDigest,
        warnings: p.frozen.snapshot.confirmation.warnings,
      },
    };
    const connection = await f.pool.connect();
    try {
      await connection.query("BEGIN; SET LOCAL session_replication_role='replica'");
      await connection.query(
        "UPDATE traceability_events SET finalization_snapshot=$1 WHERE tenant_id=$2 AND id=$3",
        [v1, c.tenant, p.created.id],
      );
      await connection.query("COMMIT");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const started = await store.amend(c.tenant, c.actor, p.created.id, amend(2), "amend-v1");
    await store.void(c.tenant, c.actor, started.eventId, cancel(3, 1), "cancel");
    const ended = await store.void(c.tenant, c.actor, p.created.id, cancel(4, null), "void-v1");
    expect(ended.record.content).toEqual({
      kind: "finalized",
      finalizedAt: p.frozen.finalizedAt,
      finalizedBy: p.frozen.finalizedBy,
      snapshot: v1,
    });
    expect(
      (
        await f.pool.query(
          "SELECT finalization_snapshot FROM traceability_events WHERE tenant_id=$1 AND id=$2",
          [c.tenant, p.created.id],
        )
      ).rows,
    ).toEqual([{ finalization_snapshot: v1 }]);
  });
  it("copies exempt own-assignment inputs without inheriting approval or reassigning an archived lot", async () => {
    c = await seedExemptReceiving(f.db);
    const p = await prepare([1]);
    await f.pool.query("UPDATE traceability_lots SET status='archived' WHERE tenant_id=$1", [
      c.tenant,
    ]);
    await f.pool.query(
      "UPDATE traceability_locations SET business_name='Changed live label' WHERE tenant_id=$1",
      [c.tenant],
    );
    const before = (
      await f.pool.query(
        "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [c.tenant],
      )
    ).rows;
    const started = await store.amend(c.tenant, c.actor, p.created.id, amend(2), "amend");
    expect(started.record.content).toMatchObject({
      kind: "draft",
      draft: {
        items: [
          {
            previousLineNo: 1,
            lotId: p.frozen.snapshot.items[0]?.lotId,
            tlc: null,
            lotLinkMode: "create_on_finalize",
            exemptReceipt: c.draft.items[0]?.exemptReceipt,
          },
          {
            previousLineNo: 2,
            lotId: c.lot,
            tlc: "00001",
            lotLinkMode: "link_existing",
            exemptReceipt: null,
          },
        ],
      },
    });
    expect(JSON.stringify(started.record.content)).not.toMatch(
      /reviewedBy|reviewedAt|reviewedExemptLines/,
    );
    await store.void(c.tenant, c.actor, started.eventId, cancel(3, 1), "cancel");
    expect(
      (
        await f.pool.query(
          "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows,
    ).toEqual(before);
    expect((await store.getLiveRecord(c.tenant, c.actor, p.created.id)).content).toEqual({
      kind: "finalized",
      finalizedAt: p.frozen.finalizedAt,
      finalizedBy: p.frozen.finalizedBy,
      snapshot: p.frozen.snapshot,
    });
  });
});
