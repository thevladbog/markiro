import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  createReceivingDraftSchema,
  saveReceivingDraftSchema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  type ReceivingCommandResult,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
function versioned(value: ReceivingCommandResult) {
  if (!("receiptVersion" in value)) throw new Error("Expected a new versioned acknowledgement");
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

describe.skipIf(!url)("Original Receiving draft command result bridge", { timeout: 15000 }, () => {
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

  const createInput = () => ({ operationKey: randomUUID(), draft: c.draft });
  const saveInput = () => ({
    operationKey: randomUUID(),
    expectedDraftVersion: 1,
    draft: { ...c.draft, notes: "Corrected note" },
  });
  async function create() {
    const input = createInput();
    const receipt = versioned(await store.createDraftCommand(c.tenant, c.actor, input, "create"));
    return { input, receipt };
  }
  async function state() {
    return (
      await f.pool.query(
        `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit,
      (SELECT jsonb_agg(to_jsonb(n) ORDER BY year) FROM receiving_counters n WHERE tenant_id=$1) AS counters`,
        [c.tenant],
      )
    ).rows[0];
  }
  async function finish(id: string, expectedDraftVersion: number) {
    const ready = await store.checkRevisionReadiness(c.tenant, c.actor, id, {
      expectedDraftVersion,
    });
    return store.finalizeRevision(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      },
      "finalize",
    );
  }
  const cancel = (id: string, lifecycleVersion: number, draftVersion: number | null) =>
    store.void(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: lifecycleVersion,
        expectedDraftVersion: draftVersion,
        reason: "Entered in error",
      },
      "void",
    );

  async function compete<A, B>(
    gateTarget: { root: string } | { createKey: string },
    first: () => Promise<A>,
    second: () => Promise<B>,
  ) {
    const gate = await f.pool.connect();
    let a: ReturnType<typeof outcome<A>> | undefined;
    let b: ReturnType<typeof outcome<B>> | undefined;
    try {
      await gate.query("BEGIN");
      const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      if (!pid) throw new Error("Missing synthetic barrier");
      if ("root" in gateTarget)
        await gate.query(
          "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [c.tenant, gateTarget.root],
        );
      else
        await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify(["us-receiving", c.tenant, "receiving.create", gateTarget.createKey]),
        ]);
      async function waitFor(count: number) {
        await expect
          .poll(
            async () =>
              (
                await f.pool.query<{ count: number }>(
                  "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS count FROM blocked",
                  [pid],
                )
              ).rows[0]?.count,
            { timeout: 5000 },
          )
          .toBeGreaterThanOrEqual(count);
      }
      a = outcome(first());
      await waitFor(1);
      b = outcome(second());
      await waitFor(2);
      await gate.query("COMMIT");
      return await Promise.all([a, b]);
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
      await Promise.all([a, b]);
    }
  }

  it("serializes the same create key into one number, root, event, audit and receipt", async () => {
    const input = createInput();
    const [a, b] = await compete(
      { createKey: input.operationKey },
      () => store.createDraftCommand(c.tenant, c.actor, input, "first"),
      () => store.createDraftCommand(c.tenant, c.actor, input, "second"),
    );
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(b.value).toEqual(a.value);
    const after = await state();
    for (const field of ["events", "roots", "receipts", "audit", "counters"])
      expect(after[field]).toHaveLength(1);
    expect(after.counters[0].sequence).toBe(1);
    expect(after.audit[0]).toMatchObject({
      actor_user_id: c.actor,
      action: "traceability.receiving.draft_created",
      outcome: "success",
      request_id: "first",
    });
  });

  it.each([true, false])(
    "serializes same-key saves, including a no-op (no-op=%s)",
    async (noop) => {
      const { receipt } = await create();
      const before = await state();
      const command = { ...saveInput(), ...(noop ? { draft: c.draft } : {}) };
      const [a, b] = await compete(
        { root: receipt.eventId },
        () => store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "first"),
        () => store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "second"),
      );
      expect(a.error).toBeUndefined();
      expect(b.error).toBeUndefined();
      expect(b.value).toEqual(a.value);
      const after = await state();
      expect(after.receipts).toHaveLength(2);
      expect(after.audit).toHaveLength(noop ? 1 : 2);
      expect(after.lots).toEqual(before.lots);
      expect((await store.getLiveRecord(c.tenant, c.actor, receipt.eventId)).draftVersion).toBe(
        noop ? 1 : 2,
      );
      if (noop) expect({ ...after, receipts: null }).toEqual({ ...before, receipts: null });
    },
  );

  it("rejects a competing changed save with a different key as stale", async () => {
    const { receipt } = await create();
    const command = saveInput();
    const [a, b] = await compete(
      { root: receipt.eventId },
      () => store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "first"),
      () =>
        store.saveOriginalDraftCommand(
          c.tenant,
          c.actor,
          receipt.eventId,
          {
            ...command,
            operationKey: randomUUID(),
            draft: { ...c.draft, notes: "Competing note" },
          },
          "second",
        ),
    );
    expect(a.error).toBeUndefined();
    expect(b.error).toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
    expect((await store.getLiveRecord(c.tenant, c.actor, receipt.eventId)).content).toMatchObject({
      draft: command.draft,
    });
    expect((await state()).receipts).toHaveLength(2);
    expect((await state()).audit).toHaveLength(2);
  });

  it.each([true, false])(
    "serializes original save versus void in both orders (save first=%s)",
    async (saveFirst) => {
      const { receipt } = await create();
      const before = await state();
      const save = () =>
        store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, saveInput(), "save");
      const voidDraft = () => cancel(receipt.eventId, 1, 1);
      const [a, b] = await compete<ReceivingCommandResult, ReceivingCommandResult>(
        { root: receipt.eventId },
        saveFirst ? save : voidDraft,
        saveFirst ? voidDraft : save,
      );
      expect(a.error).toBeUndefined();
      expect(b.error).toMatchObject({
        status: 409,
        response: { code: saveFirst ? "receiving_draft_conflict" : "receiving_lifecycle_conflict" },
      });
      expect(await store.getLiveRecord(c.tenant, c.actor, receipt.eventId)).toMatchObject({
        status: saveFirst ? "draft" : "void",
        draftVersion: saveFirst ? 2 : 1,
        lifecycle: {
          lifecycleVersion: saveFirst ? 1 : 2,
          currentEventId: null,
          pendingDraftId: saveFirst ? receipt.eventId : null,
        },
      });
      const after = await state();
      expect(after.receipts).toHaveLength(2);
      expect(after.audit).toHaveLength(2);
      expect(after.lots).toEqual(before.lots);
    },
  );

  it("atomically records versioned create/save results, exact audit and unchanged lot state", async () => {
    const initial = await state();
    const { input, receipt } = await create();
    expect(receivingCreateResultSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      receiptVersion: 2,
      command: "receiving.create",
      operationKey: input.operationKey,
      eventId: receipt.record.id,
      record: {
        revision: 1,
        draftVersion: 1,
        status: "draft",
        lifecycle: {
          rootId: receipt.eventId,
          lifecycleVersion: 1,
          currentEventId: null,
          pendingDraftId: receipt.eventId,
        },
        content: { kind: "draft", draft: c.draft },
      },
    });
    expect(receipt.inputDigest).toBe(
      digest({
        commandVersion: 2,
        command: "receiving.create",
        eventId: receipt.eventId,
        input: createReceivingDraftSchema.parse(input),
      }),
    );
    const command = saveInput();
    const saved = versioned(
      await store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "save"),
    );
    expect(receivingSaveResultSchema.parse(saved)).toEqual(saved);
    expect(saved).toMatchObject({
      command: "receiving.save",
      operationKey: command.operationKey,
      eventId: receipt.eventId,
      record: {
        draftVersion: 2,
        revision: 1,
        lifecycle: receipt.record.lifecycle,
        content: { kind: "draft", draft: command.draft },
      },
    });
    expect(saved.inputDigest).toBe(
      digest({
        commandVersion: 2,
        command: "receiving.save",
        eventId: receipt.eventId,
        input: saveReceivingDraftSchema.parse(command),
      }),
    );
    expect((await state()).lots).toEqual(initial.lots);
    expect(
      (
        await f.pool.query(
          "SELECT command,operation_key,input_digest,event_id,result FROM receiving_operations WHERE tenant_id=$1 ORDER BY command",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        command: "receiving.create",
        operation_key: input.operationKey,
        input_digest: receipt.inputDigest,
        event_id: receipt.eventId,
        result: receipt,
      },
      {
        command: "receiving.save",
        operation_key: command.operationKey,
        input_digest: saved.inputDigest,
        event_id: saved.eventId,
        result: saved,
      },
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 ORDER BY created_at,id",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.draft_created",
        outcome: "success",
        target_type: "traceability_event",
        target_id: receipt.eventId,
        before: null,
        after: receipt.record,
        request_id: "create",
      },
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.draft_saved",
        outcome: "success",
        target_type: "traceability_event",
        target_id: receipt.eventId,
        before: receipt.record,
        after: saved.record,
        request_id: "save",
      },
    ]);
  });

  it("treats omitted exemption detail as a no-op but pins the exact command shape for replay", async () => {
    const { receipt } = await create();
    const before = await state();
    const command = {
      ...saveInput(),
      draft: {
        ...c.draft,
        items: c.draft.items.map(({ exemptReceipt, ...line }) => {
          void exemptReceipt;
          return line;
        }),
      },
    };
    const saved = versioned(
      await store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "noop"),
    );
    expect(saved.record).toEqual(receipt.record);
    expect({ ...(await state()), receipts: null }).toEqual({ ...before, receipts: null });
    const after = await state();
    expect(
      await store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "retry"),
    ).toEqual(saved);
    await expect(
      store.saveOriginalDraftCommand(
        c.tenant,
        c.actor,
        receipt.eventId,
        {
          ...command,
          draft: {
            ...c.draft,
            items: c.draft.items.map((line) => ({ ...line, exemptReceipt: null })),
          },
        },
        "rebound-noop",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    expect(await state()).toEqual(after);
  });

  it.each(["legacy", "versioned"] as const)(
    "replays %s create/save results exactly after real finalization and void",
    async (format) => {
      const input = createInput(),
        command = saveInput();
      const created =
        format === "legacy"
          ? await store.createDraft(c.tenant, c.actor, input, "create")
          : await store.createDraftCommand(c.tenant, c.actor, input, "create");
      const id = "receiptVersion" in created ? created.eventId : created.id;
      const saved =
        format === "legacy"
          ? await store.saveDraft(c.tenant, c.actor, id, command, "save")
          : await store.saveOriginalDraftCommand(c.tenant, c.actor, id, command, "save");
      await finish(id, 2);
      await cancel(id, 2, null);
      const before = await state();
      expect(await store.createDraftCommand(c.tenant, c.actor, input, "old-create")).toEqual(
        created,
      );
      expect(
        await store.saveOriginalDraftCommand(
          c.tenant,
          c.actor,
          id.toUpperCase(),
          command,
          "old-save",
        ),
      ).toEqual(saved);
      expect(await state()).toEqual(before);
      expect((await store.getLiveRecord(c.tenant, c.actor, id)).status).toBe("void");
      if (format === "legacy") {
        expect(
          (
            await f.pool.query(
              "SELECT input_digest FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.create'",
              [c.tenant],
            )
          ).rows,
        ).toEqual([{ input_digest: digest(createReceivingDraftSchema.parse(input)) }]);
        expect(
          (
            await f.pool.query(
              "SELECT input_digest FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.save'",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          { input_digest: digest({ eventId: id, ...saveReceivingDraftSchema.parse(command) }) },
        ]);
      }
    },
  );

  it("rejects changed keys, targets, versions and binding extensions without modifying the draft", async () => {
    const { input, receipt } = await create();
    const command = saveInput();
    await store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "save");
    const before = await state();
    await expect(
      store.createDraftCommand(
        c.tenant,
        c.actor,
        { ...input, draft: { ...c.draft, notes: "Changed" } },
        "rebound",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    await expect(
      store.saveOriginalDraftCommand(
        c.tenant,
        c.actor,
        receipt.eventId,
        { ...command, draft: c.draft },
        "rebound",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    await expect(
      store.saveOriginalDraftCommand(c.tenant, c.actor, randomUUID(), command, "other-target"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    await expect(
      store.saveOriginalDraftCommand(
        c.tenant,
        c.actor,
        receipt.eventId,
        { ...command, operationKey: randomUUID() },
        "stale",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
    await expect(
      store.saveOriginalDraftCommand(
        c.tenant,
        c.actor,
        receipt.eventId,
        { ...command, commandVersion: 2 },
        "hybrid",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.saveOriginalDraftCommand(
        c.tenant,
        c.actor,
        receipt.eventId,
        {
          ...command,
          draft: {
            ...command.draft,
            items: command.draft.items.map((line) => ({ ...line, previousLineNo: null })),
          },
        },
        "binding",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });

  it("reauthorizes before replay/input disclosure and retains receiver-only original drafting", async () => {
    await f.db
      .update(schema.member)
      .set({ role: "traceability_receiving" })
      .where(eq(schema.member.id, c.member));
    const { input, receipt } = await create();
    const command = saveInput();
    await store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "save");
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    const before = await state();
    await expect(
      store.createDraftCommand(c.tenant, c.actor, input, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.createDraftCommand(c.tenant, c.actor, {}, "invalid-revoked"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, command, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(before);
  });

  it("keeps foreign/missing targets not-found and terminal roots conflicted", async () => {
    const foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: foreign.draft },
      "foreign",
    );
    for (const id of [other.id, randomUUID()])
      await expect(
        store.saveOriginalDraftCommand(c.tenant, c.actor, id, saveInput(), "not-found"),
      ).rejects.toMatchObject({ status: 404 });
    const { receipt } = await create();
    await cancel(receipt.eventId, 1, 1);
    const before = await state();
    await expect(
      store.saveOriginalDraftCommand(c.tenant, c.actor, receipt.eventId, saveInput(), "voided"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "receiving_lifecycle_conflict",
        rootId: receipt.eventId,
        lifecycleVersion: 2,
        currentEventId: null,
        pendingDraftId: null,
      },
    });
    expect(await state()).toEqual(before);
  });

  it.each(["create", "save"] as const)(
    "fails closed on corrupt versioned %s receipts instead of falling back to legacy replay",
    async (kind) => {
      const { input, receipt } = await create();
      const command = saveInput();
      const saved =
        kind === "create"
          ? receipt
          : versioned(
              await store.saveOriginalDraftCommand(
                c.tenant,
                c.actor,
                receipt.eventId,
                command,
                "save",
              ),
            );
      const key = kind === "create" ? input.operationKey : command.operationKey;
      for (const corrupt of [
        { ...saved, receiptVersion: 99 },
        { ...saved, operationKey: randomUUID() },
        { ...saved, inputDigest: "0".repeat(64) },
        { ...saved, eventId: randomUUID() },
        { ...saved, command: "receiving.finalize" },
        {},
      ]) {
        await f.pool.query(
          "UPDATE receiving_operations SET result=$3::jsonb WHERE tenant_id=$1 AND operation_key=$2",
          [c.tenant, key, JSON.stringify(corrupt)],
        );
        const before = await state();
        const action =
          kind === "create"
            ? store.createDraftCommand(c.tenant, c.actor, input, "corrupt")
            : store.saveOriginalDraftCommand(
                c.tenant,
                c.actor,
                receipt.eventId,
                command,
                "corrupt",
              );
        await expect(action).rejects.toMatchObject({ status: 503 });
        expect(await state()).toEqual(before);
      }
    },
  );

  it.each([
    ["receiving_operations", "receiving_operations_tenant_id_command_operation_key_pk", 3],
    ["receiving_operations", "unrelated_unique_key", 1],
    ["unrelated_table", "receiving_operations_tenant_id_command_operation_key_pk", 1],
  ] as const)(
    "bounds receipt retries without swallowing other unique errors (%s/%s)",
    async (table, constraint, attempts) => {
      const { receipt } = await create();
      const command = { ...saveInput(), draft: c.draft };
      const before = await state();
      await f.pool.query(
        `CREATE SEQUENCE synthetic_bridge_attempts; CREATE FUNCTION synthetic_bridge_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_bridge_attempts'); RAISE EXCEPTION 'synthetic unique failure' USING ERRCODE='23505', TABLE='${table}', CONSTRAINT='${constraint}'; END $$; CREATE TRIGGER synthetic_bridge_retry BEFORE INSERT ON receiving_operations FOR EACH ROW EXECUTE FUNCTION synthetic_bridge_retry()`,
      );
      try {
        const action = store.saveOriginalDraftCommand(
          c.tenant,
          c.actor,
          receipt.eventId,
          command,
          "retry-bound",
        );
        if (attempts === 3)
          await expect(action).rejects.toMatchObject({
            status: 503,
            response: { code: "us_database_unavailable" },
          });
        else
          await expect(action).rejects.toMatchObject({
            cause: { code: "23505", table, constraint },
          });
        expect(
          (await f.pool.query("SELECT last_value::int AS attempts FROM synthetic_bridge_attempts"))
            .rows,
        ).toEqual([{ attempts }]);
      } finally {
        await f.pool.query(
          "DROP TRIGGER synthetic_bridge_retry ON receiving_operations; DROP FUNCTION synthetic_bridge_retry(); DROP SEQUENCE synthetic_bridge_attempts",
        );
      }
      expect(await state()).toEqual(before);
    },
  );

  it.each([
    ["create", "tenant_audit_events"],
    ["create", "receiving_operations"],
    ["save", "tenant_audit_events"],
    ["save", "receiving_operations"],
  ] as const)(
    "rolls back %s completely on %s failure and permits the exact retry",
    async (kind, table) => {
      const input = createInput();
      const current = kind === "save" ? await create() : null;
      const command = saveInput();
      const action = () =>
        current
          ? store.saveOriginalDraftCommand(
              c.tenant,
              c.actor,
              current.receipt.eventId,
              command,
              "attempt",
            )
          : store.createDraftCommand(c.tenant, c.actor, input, "attempt");
      const before = await state();
      await f.pool.query(
        `CREATE FUNCTION synthetic_draft_bridge_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic draft bridge failure'; END $$; CREATE TRIGGER synthetic_draft_bridge_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_draft_bridge_fail()`,
      );
      try {
        await expect(action()).rejects.toBeDefined();
      } finally {
        await f.pool.query(
          `DROP TRIGGER synthetic_draft_bridge_fail ON ${table}; DROP FUNCTION synthetic_draft_bridge_fail()`,
        );
      }
      expect(await state()).toEqual(before);
      expect(versioned(await action()).record.status).toBe("draft");
    },
  );
});
