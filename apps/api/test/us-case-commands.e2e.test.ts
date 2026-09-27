import { randomUUID } from "node:crypto";
import { buildSscc } from "@markiro/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCaseBridge, caseState } from "./support/us-case-bridge-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US case commands", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsCaseStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
    store = new UsCaseStore(f.db);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("links 100 atomically, freezes receipt, preserves CTE bytes and never fabricates physical evidence", async () => {
    const c = await seedCaseBridge(f),
      operationKey = randomUUID();
    const before = await caseState(f, c.tenant);
    const result = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey, ssccs: [...c.codes].reverse() },
      "req-1",
    );
    expect(result.created).toHaveLength(100);
    expect(result.unchanged).toEqual([]);
    expect(result.created).toEqual(
      c.codes.map((code) =>
        expect.objectContaining({
          ssccAtLink: code,
          lotId: c.lotId,
          linkedBy: c.actor,
          linkSource: "manual",
          provenance: "synthetic_demo",
          originState: "current",
          ssccState: "consistent",
          unlinkedAt: null,
          unlinkedBy: null,
          unlinkReason: null,
        }),
      ),
    );
    expect(
      await store.link(
        c.tenant,
        c.actor,
        c.lotId,
        { operationKey, ssccs: c.codes.map((s) => `(00)${s}`) },
        "req-2",
      ),
    ).toEqual(result);
    expect(await c.activeLinks(c.tenant, c.codes[0]!)).toHaveLength(1);
    expect(await c.auditForOperation(c.tenant, operationKey)).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "case.link",
      targetType: "traceability_lot",
      targetId: c.lotId,
      outcome: "success",
      requestId: "req-1",
      before: { links: [] },
      after: { operationKey, tenantId: c.tenant, lotId: c.lotId, source: "manual", result },
    });
    const receipt = await f.pool.query(
      "SELECT result FROM trace_lot_box_operations WHERE tenant_id=$1 AND operation_key=$2",
      [c.tenant, operationKey],
    );
    expect(receipt.rows).toEqual([{ result }]);
    const after = await caseState(f, c.tenant);
    expect(after.events).toEqual(before.events);
    expect(after.snapshot_bytes).toEqual(before.snapshot_bytes);
    const physical = await f.pool.query(
      "SELECT count(*)::int n FROM boxes WHERE tenant_id=$1 AND (closed_at IS NOT NULL OR closure_received_at IS NOT NULL OR print_verified_at IS NOT NULL OR print_skipped_at IS NOT NULL)",
      [c.tenant],
    );
    expect(physical.rows).toEqual([{ n: 0 }]);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM box_items WHERE tenant_id=$1", [c.tenant]))
        .rows,
    ).toEqual([{ n: 0 }]);
  });

  it("same-lot no-op does not bump dependency, and an unmarked box is eligible", async () => {
    const c = await seedCaseBridge(f);
    const result = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.existingCode] },
      "existing",
    );
    expect(result.created[0]).toMatchObject({ provenance: "existing_record" });
    const before = await caseState(f, c.tenant);
    const next = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.existingCode] },
      "noop",
    );
    expect(next).toEqual({ lotId: c.lotId, created: [], unchanged: result.created });
    expect((await caseState(f, c.tenant)).lots).toEqual(before.lots);
  });

  it("rejects invalid, retired, cross-lot and foreign targets atomically without receipts or audit", async () => {
    const c = await seedCaseBridge(f),
      foreign = await seedCaseBridge(f);
    const otherLot = randomUUID();
    await f.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,$2,$3,'OTHER','imported',$4,$4)",
      [otherLot, c.tenant, c.product, c.actor],
    );
    await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "linked",
    );
    const before = await caseState(f, c.tenant);
    for (const [lotId, ssccs, status] of [
      [c.lotId, [c.codes[1], c.retiredCode], 409],
      [c.lotId, [c.codes[1], buildSscc(0, "9876543", 1)], 404],
      [otherLot, [c.codes[0]], 409],
      [foreign.lotId, [c.codes[1]], 404],
      [randomUUID(), [c.codes[1]], 404],
      [c.lotId, [c.codes[1], "123"], 400],
      [c.lotId, [c.codes[1], `(00)${c.codes[1]}`], 400],
    ] as const) {
      await expect(
        store.link(c.tenant, c.actor, lotId, { operationKey: randomUUID(), ssccs }, "failure"),
      ).rejects.toMatchObject({ status });
      expect(await caseState(f, c.tenant)).toEqual(before);
    }
    // The foreign-only code exists, but its presence must not change the error.
    await f.pool.query("UPDATE boxes SET sscc=$1 WHERE id=$2", [
      buildSscc(0, "9876543", 1),
      foreign.boxes[0]!.id,
    ]);
    await expect(
      store.link(
        c.tenant,
        c.actor,
        c.lotId,
        { operationKey: randomUUID(), ssccs: [buildSscc(0, "9876543", 1)] },
        "foreign-box",
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "case_not_found" } });
  });

  it("conflicts on changed canonical intent and reloads role before link and unlink replay", async () => {
    const c = await seedCaseBridge(f),
      operationKey = randomUUID();
    const first = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey, ssccs: [c.codes[0]] },
      "first",
    );
    await expect(
      store.link(c.tenant, c.actor, c.lotId, { operationKey, ssccs: [c.codes[1]] }, "changed"),
    ).rejects.toMatchObject({ response: { code: "case_operation_conflict" } });
    const unlink = { operationKey: randomUUID(), reason: " Wrong lot " };
    const removed = await store.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      first.created[0]!.linkId,
      unlink,
      "unlink",
    );
    expect(
      await store.unlink(
        c.tenant,
        c.actor,
        c.lotId,
        removed.linkId,
        { ...unlink, reason: "Wrong lot" },
        "retry",
      ),
    ).toEqual(removed);
    await expect(
      store.unlink(
        c.tenant,
        c.actor,
        c.lotId,
        removed.linkId,
        { ...unlink, reason: "Another reason" },
        "changed",
      ),
    ).rejects.toMatchObject({ response: { code: "case_operation_conflict" } });
    await f.pool.query("UPDATE member SET role='viewer' WHERE id=$1", [c.member]);
    await expect(
      store.link(c.tenant, c.actor, c.lotId, { operationKey, ssccs: [c.codes[0]] }, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.unlink(c.tenant, c.actor, c.lotId, removed.linkId, unlink, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows unchanged and reasoned unlink after void, blocks new or mixed links and retains exact history", async () => {
    const c = await seedCaseBridge(f);
    const first = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "first",
    );
    const link = first.created[0]!;
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Invalid origin" },
      "void",
    );
    const before = await caseState(f, c.tenant);
    await expect(
      store.link(
        c.tenant,
        c.actor,
        c.lotId,
        { operationKey: randomUUID(), ssccs: [c.codes[0], c.codes[1]] },
        "mixed",
      ),
    ).rejects.toMatchObject({ response: { code: "case_origin_not_current" } });
    expect(await caseState(f, c.tenant)).toEqual(before);
    const unchanged = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "unchanged",
    );
    expect(unchanged).toEqual({
      lotId: c.lotId,
      created: [],
      unchanged: [{ ...link, originState: "gap" }],
    });
    expect((await caseState(f, c.tenant)).lots).toEqual(before.lots);
    const operationKey = randomUUID();
    const result = await store.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      link.linkId,
      { operationKey, reason: "Wrong lot" },
      "unlink",
    );
    expect(result).toEqual({
      linkId: link.linkId,
      lotId: c.lotId,
      unlinkedAt: expect.any(String),
      unlinkedBy: c.actor,
      reason: "Wrong lot",
    });
    expect(await c.auditForOperation(c.tenant, operationKey)).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "case.unlink",
      targetType: "trace_lot_box",
      targetId: link.linkId,
      outcome: "success",
      requestId: "unlink",
      before: { link: { ...link, originState: "gap" } },
      after: {
        tenantId: c.tenant,
        operationKey,
        lotId: c.lotId,
        boxId: link.boxId,
        linkId: link.linkId,
        ssccAtLink: link.ssccAtLink,
        source: "manual",
        reason: "Wrong lot",
        result,
      },
    });
    expect(await c.activeLinks(c.tenant, c.codes[0]!)).toEqual([]);
    expect((await caseState(f, c.tenant)).events).toEqual(before.events);
  });

  it("rolls back link and unlink on audit failure", async () => {
    const c = await seedCaseBridge(f);
    const linked = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "first",
    );
    const before = await caseState(f, c.tenant);
    await f.pool.query(
      "CREATE FUNCTION reject_case_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('case.link','case.unlink') THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_case_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_case_audit()",
    );
    try {
      await expect(
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: randomUUID(), ssccs: [c.codes[1]] },
          "failure",
        ),
      ).rejects.toThrow();
      await expect(
        store.unlink(
          c.tenant,
          c.actor,
          c.lotId,
          linked.created[0]!.linkId,
          { operationKey: randomUUID(), reason: "Wrong lot" },
          "failure",
        ),
      ).rejects.toThrow();
      expect(await caseState(f, c.tenant)).toEqual(before);
    } finally {
      await f.pool.query(
        "DROP TRIGGER reject_case_audit ON tenant_audit_events; DROP FUNCTION reject_case_audit()",
      );
    }
  });

  it("retains linkage through amendment and keeps case count independent from CTE quantity", async () => {
    const c = await seedCaseBridge(f);
    const linked = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "link",
    );
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Documentary correction" },
      "amend",
    );
    if (amendment.record.status !== "draft") throw new Error("Expected draft");
    const ready = await c.store.checkReadiness(c.tenant, c.actor, amendment.record.id, {
      expectedDraftVersion: 1,
    });
    const revised = await c.store.finalize(
      c.tenant,
      c.actor,
      amendment.record.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "revision",
    );
    expect(revised.snapshot.outputs[0]).toMatchObject({
      lotId: c.lotId,
      quantity: "100",
      unitOfMeasure: "case",
    });
    const unchanged = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "unchanged",
    );
    expect(unchanged).toEqual({ lotId: c.lotId, created: [], unchanged: linked.created });
    expect(await c.activeLinks(c.tenant, c.codes[0]!)).toHaveLength(1);
  });
});
