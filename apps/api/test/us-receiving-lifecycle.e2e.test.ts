import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving lifecycle commands", () => {
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
  const amendInput = (version = 2) => ({
    commandVersion: 2,
    operationKey: randomUUID(),
    expectedLifecycleVersion: version,
    reason: "Correct receipt",
  });
  const voidInput = (version: number, draftVersion: number | null) => ({
    ...amendInput(version),
    expectedDraftVersion: draftVersion,
    reason: "Entered in error",
  });
  const create = () =>
    store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft: c.draft }, "create");
  async function finalized() {
    const saved = await create();
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize",
    );
  }
  async function lots() {
    return (
      await f.pool.query<{ lot: Record<string, unknown> & { receiving_basis_version: number } }>(
        "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [c.tenant],
      )
    ).rows;
  }
  async function businessState() {
    return (
      await f.pool.query(
        `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [c.tenant],
      )
    ).rows;
  }
  it("starts exactly one bound amendment and records the command, actor, reason and lifecycle atomically", async () => {
    const original = await finalized();
    const before = await store.getLiveRecord(c.tenant, c.actor, original.id);
    const beforeLots = await lots();
    const command = { ...amendInput(), reason: "  Correct receipt  " };
    const receipt = await store.amend(
      c.tenant,
      c.actor,
      original.id.toUpperCase(),
      command,
      "amend-request",
    );
    expect(receipt).toMatchObject({
      receiptVersion: 2,
      command: "receiving.amend",
      operationKey: command.operationKey,
      record: {
        eventNumber: original.eventNumber,
        revision: 2,
        draftVersion: 1,
        status: "draft",
        createdBy: c.actor,
        updatedBy: c.actor,
        lifecycle: {
          rootId: original.id,
          lifecycleVersion: 3,
          previousRevisionId: original.id,
          currentEventId: original.id,
          pendingDraftId: receipt.eventId,
          amendmentReason: "Correct receipt",
        },
      },
    });
    expect(receipt.eventId).not.toBe(original.id);
    expect(receipt.record.content).toEqual({
      kind: "draft",
      draft: {
        ...c.draft,
        items: c.draft.items.map((line, index) => ({
          ...line,
          exemptReceipt: null,
          lotId: original.snapshot.items[index]?.lotId,
          previousLineNo: index + 1,
        })),
      },
    });
    expect(await lots()).toEqual(beforeLots);
    expect((await store.getLiveRecord(c.tenant, c.actor, original.id)).content).toEqual(
      before.content,
    );
    const state = await businessState();
    expect(await store.amend(c.tenant, c.actor, original.id, command, "retry")).toEqual(receipt);
    expect(await businessState()).toEqual(state);
    expect(
      (
        await f.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.amendment_started'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.amendment_started",
        outcome: "success",
        target_type: "traceability_event",
        target_id: receipt.eventId,
        before,
        after: {
          rootId: original.id,
          revision: 2,
          reason: "Correct receipt",
          result: "draft_started",
          record: receipt.record,
        },
        request_id: "amend-request",
      },
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT event_id,result FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.amend' AND operation_key=$2",
          [c.tenant, command.operationKey],
        )
      ).rows,
    ).toEqual([{ event_id: receipt.eventId, result: receipt }]);
  });
  it("cancels the pending draft without changing basis and never reuses its revision", async () => {
    const original = await finalized();
    const started = await store.amend(c.tenant, c.actor, original.id, amendInput(), "amend");
    const basis = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
    const beforeLots = await lots();
    const command = voidInput(3, 1);
    const receipt = await store.void(c.tenant, c.actor, started.eventId, command, "void-draft");
    expect(receipt.record).toMatchObject({
      status: "void",
      revision: 2,
      lifecycle: {
        lifecycleVersion: 4,
        currentEventId: original.id,
        pendingDraftId: null,
        voidReason: command.reason,
        voidedBy: c.actor,
      },
    });
    expect(receipt.record.content).toEqual(started.record.content);
    expect(await lots()).toEqual(beforeLots);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(basis);
    const next = await store.amend(c.tenant, c.actor, original.id, amendInput(4), "amend-again");
    expect(next.record.revision).toBe(3);
    expect(next.eventId).not.toBe(started.eventId);
    expect(await store.void(c.tenant, c.actor, started.eventId, command, "old-void-retry")).toEqual(
      receipt,
    );
  });
  it("voids an effective receipt without modifying frozen content or any lot business field", async () => {
    const original = await finalized();
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "recalled" })
      .where(eq(schema.traceabilityLots.id, c.lot));
    const beforeLots = await lots();
    const before = await store.getLiveRecord(c.tenant, c.actor, original.id);
    const command = voidInput(2, null);
    const receipt = await store.void(c.tenant, c.actor, original.id, command, "void-finalized");
    expect(receipt.record).toMatchObject({
      status: "void",
      lifecycle: {
        currentEventId: null,
        pendingDraftId: null,
        lifecycleVersion: 3,
        voidedBy: c.actor,
        voidReason: command.reason,
      },
    });
    expect(receipt.record.content).toEqual(before.content);
    expect(await lots()).toEqual(
      beforeLots.map(({ lot }) => ({
        lot: { ...lot, receiving_basis_version: lot.receiving_basis_version + 1 },
      })),
    );
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      state: "missing",
      supportCount: 0,
      basisVersion: 3,
    });
    const state = await businessState();
    expect(await store.void(c.tenant, c.actor, original.id, command, "retry")).toEqual(receipt);
    expect(await businessState()).toEqual(state);
    expect(
      (
        await f.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.voided'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.voided",
        outcome: "success",
        target_type: "traceability_event",
        target_id: original.id,
        before,
        after: {
          rootId: original.id,
          revision: 1,
          reason: command.reason,
          result: "voided",
          record: receipt.record,
        },
        request_id: "void-finalized",
      },
    ]);
  });
  it("voids an incomplete original draft with its exact saved version and no frozen payload", async () => {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, locationId: null, dateReceived: null, items: [], documentIds: [] },
      },
      "incomplete",
    );
    const beforeLots = await lots();
    const receipt = await store.void(c.tenant, c.actor, saved.id, voidInput(1, 1), "void");
    expect(receipt.record).toMatchObject({
      status: "void",
      lifecycle: { lifecycleVersion: 2, currentEventId: null, pendingDraftId: null },
      content: { kind: "draft", draft: saved.draft },
    });
    expect(await lots()).toEqual(beforeLots);
  });
  it("rejects a new amend key or effective void while a pending amendment exists", async () => {
    const original = await finalized();
    const started = await store.amend(c.tenant, c.actor, original.id, amendInput(), "amend");
    const before = await businessState();
    for (const call of [
      () => store.amend(c.tenant, c.actor, original.id, amendInput(3), "second"),
      () => store.void(c.tenant, c.actor, original.id, voidInput(3, null), "hidden-cancel"),
    ])
      await expect(call()).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_pending_amendment", pendingDraftId: started.eventId },
      });
    expect(await businessState()).toEqual(before);
  });
  it("rejects stale root and saved versions without remembering failed commands", async () => {
    const saved = await create();
    const before = await businessState();
    await expect(
      store.void(c.tenant, c.actor, saved.id, voidInput(2, 1), "stale-root"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "receiving_lifecycle_conflict",
        rootId: saved.id,
        lifecycleVersion: 1,
        currentEventId: null,
        pendingDraftId: saved.id,
      },
    });
    for (const version of [null, 2])
      await expect(
        store.void(c.tenant, c.actor, saved.id, voidInput(1, version), "stale-draft"),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
    expect(await businessState()).toEqual(before);
    const original = await finalized();
    await expect(
      store.amend(c.tenant, c.actor, original.id, amendInput(1), "stale-amend"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
    await expect(
      store.void(c.tenant, c.actor, original.id, voidInput(2, 1), "not-a-draft"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
  });
  it.each([
    "traceability_receiving",
    "traceability_auditor",
    "traceability_shipping",
    "traceability_production",
    "manager",
  ])("requires current QA before first execution and successful replay for %s", async (role) => {
    const original = await finalized();
    const command = amendInput();
    const amended = await store.amend(c.tenant, c.actor, original.id, command, "amend");
    const cancel = voidInput(3, 1);
    await store.void(c.tenant, c.actor, amended.eventId, cancel, "cancel");
    await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
    const before = await businessState();
    for (const call of [
      () => store.amend(c.tenant, c.actor, original.id, command, "retry"),
      () => store.amend(c.tenant, c.actor, original.id, amendInput(4), "new"),
      () => store.void(c.tenant, c.actor, amended.eventId, cancel, "retry"),
      () => store.void(c.tenant, c.actor, original.id, voidInput(4, null), "new"),
    ])
      await expect(call()).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
    expect(await businessState()).toEqual(before);
  });
  it("allows the traceability QA role without requiring owner authority", async () => {
    const original = await finalized();
    await f.db
      .update(schema.member)
      .set({ role: "traceability_qa" })
      .where(eq(schema.member.id, c.member));
    const amended = await store.amend(c.tenant, c.actor, original.id, amendInput(), "qa-amend");
    expect(amended.record.createdBy).toBe(c.actor);
    expect(
      (await store.void(c.tenant, c.actor, amended.eventId, voidInput(3, 1), "qa-void")).record
        .status,
    ).toBe("void");
  });
  it("uses the current QA actor for lifecycle metadata without replacing the original finalizer", async () => {
    const original = await finalized(),
      qa = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: qa, name: "Synthetic QA", email: `${qa}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      userId: qa,
      organizationId: c.tenant,
      role: "traceability_qa",
      createdAt: new Date(),
    });
    const receipt = await store.amend(c.tenant, qa, original.id, amendInput(), "qa-amend");
    expect(receipt.record).toMatchObject({ createdBy: qa, updatedBy: qa });
    await store.void(c.tenant, qa, receipt.eventId, voidInput(3, 1), "qa-cancel");
    const ended = await store.void(c.tenant, qa, original.id, voidInput(4, null), "qa-void");
    expect(ended.record).toMatchObject({
      updatedBy: c.actor,
      lifecycle: { voidedBy: qa },
      content: { kind: "finalized", finalizedBy: c.actor, finalizedAt: original.finalizedAt },
    });
    expect(
      (
        await f.pool.query(
          "SELECT actor_user_id,target_id FROM tenant_audit_events WHERE organization_id=$1 AND request_id='qa-void'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ actor_user_id: qa, target_id: original.id }]);
  });
  it("bumps one basis token for duplicate lot lines and rolls back an exhausted token", async () => {
    const line = c.draft.items[1];
    if (!line) throw new Error("Missing linked line");
    c.draft.items = [line, { ...line, quantity: "5" }];
    const original = await finalized();
    await f.pool.query(
      "UPDATE traceability_lots SET receiving_basis_version=2147483647 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.lot],
    );
    const before = await businessState(),
      command = voidInput(2, null);
    await expect(
      store.void(c.tenant, c.actor, original.id, command, "overflow"),
    ).rejects.toMatchObject({ status: 503 });
    expect(await businessState()).toEqual(before);
    await f.pool.query(
      "UPDATE traceability_lots SET receiving_basis_version=2 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.lot],
    );
    await store.void(c.tenant, c.actor, original.id, command, "retry");
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 3,
      state: "missing",
    });
  });
  it.each(["40001", "40P01"])(
    "stops after three retryable %s failures with no committed effect",
    async (code) => {
      const original = await finalized(),
        command = amendInput(),
        before = await businessState();
      await f.pool.query(
        `CREATE SEQUENCE synthetic_lifecycle_attempt; CREATE FUNCTION synthetic_lifecycle_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_lifecycle_attempt'); RAISE EXCEPTION 'synthetic retry' USING ERRCODE='${code}'; END $$; CREATE TRIGGER synthetic_lifecycle_retry BEFORE INSERT ON receiving_operations FOR EACH ROW EXECUTE FUNCTION synthetic_lifecycle_retry()`,
      );
      try {
        await expect(
          store.amend(c.tenant, c.actor, original.id, command, "retry-exhausted"),
        ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
        expect(
          (await f.pool.query("SELECT last_value::int FROM synthetic_lifecycle_attempt")).rows,
        ).toEqual([{ last_value: 3 }]);
        expect(await businessState()).toEqual(before);
      } finally {
        await f.pool.query(
          "DROP TRIGGER synthetic_lifecycle_retry ON receiving_operations; DROP FUNCTION synthetic_lifecycle_retry(); DROP SEQUENCE synthetic_lifecycle_attempt",
        );
      }
      expect(
        (await store.amend(c.tenant, c.actor, original.id, command, "retry-after-recovery")).record
          .revision,
      ).toBe(2);
    },
  );
  it("rejects missing profile on replay and isolates foreign or missing targets", async () => {
    const original = await finalized(),
      command = amendInput();
    await store.amend(c.tenant, c.actor, original.id, command, "amend");
    const other = await seedCompleteReceiving(f.db);
    for (const id of [original.id, randomUUID()]) {
      await expect(
        store.amend(other.tenant, other.actor, id, command, "foreign"),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        store.void(other.tenant, other.actor, id, voidInput(2, null), "foreign"),
      ).rejects.toMatchObject({ status: 404 });
    }
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(
      store.amend(c.tenant, c.actor, original.id, command, "revoked-profile"),
    ).rejects.toMatchObject({ status: 403, response: { code: "traceability_profile_required" } });
  });
  it("conflicts on same-key changed target, reason or version and returns a historical acknowledgement after void", async () => {
    const original = await finalized(),
      command = amendInput();
    const receipt = await store.amend(c.tenant, c.actor, original.id, command, "amend");
    await store.void(c.tenant, c.actor, receipt.eventId, voidInput(3, 1), "cancel");
    await store.void(c.tenant, c.actor, original.id, voidInput(4, null), "void-original");
    const before = await businessState();
    expect(await store.amend(c.tenant, c.actor, original.id, command, "lost-ack")).toEqual(receipt);
    expect((await store.getLiveRecord(c.tenant, c.actor, receipt.eventId)).status).toBe("void");
    for (const [id, input] of [
      [randomUUID(), command],
      [original.id, { ...command, reason: "Different reason" }],
      [original.id, { ...command, expectedLifecycleVersion: 4 }],
    ] as const)
      await expect(store.amend(c.tenant, c.actor, id, input, "different")).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_operation_conflict" },
      });
    await expect(
      store.amend(c.tenant, c.actor, original.id, amendInput(5), "resurrect"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
    await expect(
      store.void(c.tenant, c.actor, original.id, voidInput(5, null), "void-again"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
    expect(await businessState()).toEqual(before);
  });
  it.each(["amend", "void"] as const)(
    "rejects strict malformed %s inputs before any write",
    async (kind) => {
      const original = await finalized();
      const before = await businessState();
      const valid = kind === "amend" ? amendInput() : voidInput(2, null);
      for (const patch of [
        { commandVersion: 1 },
        { reason: "  " },
        { reason: "x\u0000" },
        { reason: "x".repeat(2001) },
        { expectedLifecycleVersion: 0 },
        { extra: true },
        { operationKey: "not-a-uuid" },
      ])
        await expect(
          store[kind](c.tenant, c.actor, original.id, { ...valid, ...patch }, "bad"),
        ).rejects.toMatchObject({ status: 400 });
      await expect(
        store[kind](c.tenant, c.actor, "not-a-uuid", valid, "bad-id"),
      ).rejects.toMatchObject({ status: 400 });
      expect(await businessState()).toEqual(before);
    },
  );
  it.each(["amend", "void"] as const)(
    "rejects corrupt stored %s receipts without performing another command",
    async (kind) => {
      const original = await finalized();
      const command = kind === "amend" ? amendInput() : voidInput(2, null);
      const receipt = await store[kind](c.tenant, c.actor, original.id, command, "first");
      for (const result of [
        {},
        { ...receipt, operationKey: randomUUID() },
        { ...receipt, inputDigest: "0".repeat(64) },
        { ...receipt, eventId: randomUUID() },
      ]) {
        await f.pool.query(
          "UPDATE receiving_operations SET result=$1 WHERE tenant_id=$2 AND command=$3 AND operation_key=$4",
          [result, c.tenant, `receiving.${kind}`, command.operationKey],
        );
        const before = await businessState();
        await expect(
          store[kind](c.tenant, c.actor, original.id, command, "corrupt-retry"),
        ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
        expect(await businessState()).toEqual(before);
      }
    },
  );
  it.each(["amend-audit", "amend-receipt", "void-audit", "void-receipt"] as const)(
    "rolls back every effect after %s failure and permits the exact retry",
    async (failure) => {
      const original = await finalized();
      const kind = failure.startsWith("amend") ? "amend" : "void";
      const command = kind === "amend" ? amendInput() : voidInput(2, null);
      const table = failure.endsWith("audit") ? "tenant_audit_events" : "receiving_operations";
      const before = await businessState();
      await f.pool.query(
        `CREATE FUNCTION synthetic_lifecycle_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic lifecycle failure'; END $$; CREATE TRIGGER synthetic_lifecycle_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_lifecycle_fail()`,
      );
      try {
        await expect(
          store[kind](c.tenant, c.actor, original.id, command, "failed"),
        ).rejects.toBeDefined();
      } finally {
        await f.pool.query(
          `DROP TRIGGER synthetic_lifecycle_fail ON ${table}; DROP FUNCTION synthetic_lifecycle_fail()`,
        );
      }
      expect(await businessState()).toEqual(before);
      expect(
        (await store[kind](c.tenant, c.actor, original.id, command, "retry")).record.status,
      ).toBe(kind === "amend" ? "draft" : "void");
    },
  );
  it("fails closed on unknown stored CTE kinds before even a draft cancellation", async () => {
    const saved = await create(),
      unknown = await create();
    const constraint = (
      await f.pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='traceability_events'::regclass AND conname='traceability_events_lifecycle_valid'",
      )
    ).rows[0]?.definition;
    if (!constraint) throw new Error("Missing synthetic constraint");
    const connection = await f.pool.connect();
    try {
      await connection.query(
        "BEGIN; SET LOCAL session_replication_role='replica'; ALTER TABLE traceability_events DROP CONSTRAINT traceability_events_lifecycle_valid",
      );
      await connection.query(
        "UPDATE traceability_events SET type='shipping' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, unknown.id],
      );
      await connection.query("COMMIT");
      const before = await businessState();
      await expect(
        store.void(c.tenant, c.actor, saved.id, voidInput(1, 1), "unknown-kind"),
      ).rejects.toMatchObject({ status: 503 });
      expect(await businessState()).toEqual(before);
    } finally {
      await connection.query("BEGIN; SET LOCAL session_replication_role='replica'");
      await connection.query(
        "UPDATE traceability_events SET type='receiving' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, unknown.id],
      );
      await connection.query(
        `ALTER TABLE traceability_events ADD CONSTRAINT traceability_events_lifecycle_valid ${constraint}`,
      );
      await connection.query("COMMIT");
      connection.release();
    }
  });
});
