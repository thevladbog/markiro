import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)("Receiving lifecycle real command races", { timeout: 15000 }, () => {
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
  const amend = () => ({
    commandVersion: 2,
    operationKey: randomUUID(),
    expectedLifecycleVersion: 2,
    reason: "Correct receipt",
  });
  const voidCommand = () => ({
    ...amend(),
    expectedDraftVersion: null,
    reason: "Entered in error",
  });
  async function ready() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(checked.state).toBe("complete");
    return {
      saved,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: checked.inputDigest,
      },
    };
  }
  async function finalized() {
    const r = await ready();
    return store.finalize(c.tenant, c.actor, r.saved.id, r.command, "finalize");
  }
  // Ordered lock queues establish both schedules using real DB blockers, not sleeps.
  async function compete<A, B>(
    query: string,
    params: unknown[],
    first: () => Promise<A>,
    second: () => Promise<B>,
  ) {
    const gate = await f.pool.connect();
    await gate.query("BEGIN");
    const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    if (!pid) throw new Error("Missing synthetic barrier");
    await gate.query(query, params);
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
    const a = outcome(first());
    let b: ReturnType<typeof outcome<B>> | undefined;
    try {
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
  const rootGate = "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE";
  it.each([
    ["save", "legacy"],
    ["save", "void"],
    ["finalize", "legacy"],
    ["finalize", "void"],
  ] as const)(
    "serializes original %s versus cancellation when %s commits first",
    async (command, first) => {
      const r = await ready();
      const legacy = () =>
        command === "save"
          ? store.saveDraft(
              c.tenant,
              c.actor,
              r.saved.id,
              {
                operationKey: randomUUID(),
                expectedDraftVersion: 1,
                draft: { ...c.draft, notes: "Saved before cancellation" },
              },
              "legacy-writer",
            )
          : store.finalize(c.tenant, c.actor, r.saved.id, r.command, "legacy-writer");
      const cancel = () =>
        store.void(
          c.tenant,
          c.actor,
          r.saved.id,
          {
            ...voidCommand(),
            expectedLifecycleVersion: 1,
            expectedDraftVersion: 1,
          },
          "canceller",
        );
      type CommandResult = Awaited<ReturnType<typeof legacy> | ReturnType<typeof cancel>>;
      const [a, b] = await compete<CommandResult, CommandResult>(
        rootGate,
        [c.tenant, r.saved.id],
        first === "legacy" ? legacy : cancel,
        first === "legacy" ? cancel : legacy,
      );
      expect(a.error).toBeUndefined();
      expect(b.error).toMatchObject({
        status: 409,
        response: {
          code:
            first === "legacy" && command === "save"
              ? "receiving_draft_conflict"
              : "receiving_lifecycle_conflict",
        },
      });
      const record = await store.getLiveRecord(c.tenant, c.actor, r.saved.id);
      expect(record).toMatchObject({
        status: first === "void" ? "void" : command === "save" ? "draft" : "finalized",
        draftVersion: first === "legacy" && command === "save" ? 2 : 1,
        lifecycle: {
          lifecycleVersion: first === "legacy" && command === "save" ? 1 : 2,
          currentEventId: first === "legacy" && command === "finalize" ? r.saved.id : null,
          pendingDraftId: first === "legacy" && command === "save" ? r.saved.id : null,
        },
      });
      const action =
        first === "void"
          ? "traceability.receiving.voided"
          : command === "save"
            ? "traceability.receiving.draft_saved"
            : "traceability.receiving.finalized";
      expect(
        (
          await f.pool.query(
            "SELECT action,actor_user_id,target_id,request_id,outcome FROM tenant_audit_events WHERE organization_id=$1 AND target_type='traceability_event' AND action<>'traceability.receiving.draft_created'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          action,
          actor_user_id: c.actor,
          target_id: r.saved.id,
          request_id: first === "void" ? "canceller" : "legacy-writer",
          outcome: "success",
        },
      ]);
      expect(
        (
          await f.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM receiving_operations WHERE tenant_id=$1",
            [c.tenant],
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      expect((await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).basisVersion).toBe(
        first === "legacy" && command === "finalize" ? 2 : 1,
      );
    },
  );
  it.each([true, false])(
    "serializes competing amendments (same key=%s) with one allocated revision",
    async (same) => {
      const original = await finalized(),
        command = amend();
      const [a, b] = await compete(
        rootGate,
        [c.tenant, original.id],
        () => store.amend(c.tenant, c.actor, original.id, command, "first"),
        () => store.amend(c.tenant, c.actor, original.id, same ? command : amend(), "second"),
      );
      expect(a.error).toBeUndefined();
      if (same) {
        expect(b.error).toBeUndefined();
        expect(b.value).toEqual(a.value);
      } else
        expect(b.error).toMatchObject({
          status: 409,
          response: { code: "receiving_lifecycle_conflict" },
        });
      expect(
        (await store.listRevisions(c.tenant, c.actor, original.id, {})).items.map((i) => [
          i.revision,
          i.status,
        ]),
      ).toEqual([
        [1, "finalized"],
        [2, "draft"],
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,target_id,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.amendment_started'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([{ actor_user_id: c.actor, target_id: a.value?.eventId, request_id: "first" }]);
    },
  );
  it.each([true, false])(
    "serializes competing voids (same key=%s) without double token/audit effects",
    async (same) => {
      const original = await finalized(),
        command = voidCommand();
      const [a, b] = await compete(
        rootGate,
        [c.tenant, original.id],
        () => store.void(c.tenant, c.actor, original.id, command, "first"),
        () => store.void(c.tenant, c.actor, original.id, same ? command : voidCommand(), "second"),
      );
      expect(a.error).toBeUndefined();
      if (same) {
        expect(b.error).toBeUndefined();
        expect(b.value).toEqual(a.value);
      } else
        expect(b.error).toMatchObject({
          status: 409,
          response: { code: "receiving_lifecycle_conflict" },
        });
      expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
        basisVersion: 3,
        state: "missing",
        supportCount: 0,
      });
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,target_id,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.voided'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([{ actor_user_id: c.actor, target_id: original.id, request_id: "first" }]);
    },
  );
  it.each(["amend", "void"] as const)(
    "accepts only the first command in %s versus the other lifecycle action",
    async (first) => {
      const original = await finalized();
      const start = () => store.amend(c.tenant, c.actor, original.id, amend(), "amend");
      const cancel = () => store.void(c.tenant, c.actor, original.id, voidCommand(), "void");
      const [a, b] = await compete(
        rootGate,
        [c.tenant, original.id],
        first === "amend" ? start : cancel,
        first === "amend" ? cancel : start,
      );
      expect(a.error).toBeUndefined();
      expect(b.error).toMatchObject({
        status: 409,
        response: { code: "receiving_lifecycle_conflict" },
      });
      expect((await store.getLiveRecord(c.tenant, c.actor, original.id)).status).toBe(
        first === "amend" ? "finalized" : "void",
      );
      expect((await store.listRevisions(c.tenant, c.actor, original.id, {})).items).toHaveLength(
        first === "amend" ? 2 : 1,
      );
    },
  );
  it.each(["void", "finalize"] as const)(
    "coordinates shared-lot support when %s commits first on independent roots",
    async (first) => {
      const original = await finalized();
      c.draft.items = c.draft.items.filter((line) => line.lotLinkMode === "link_existing");
      const second = await ready();
      const cancel = () => store.void(c.tenant, c.actor, original.id, voidCommand(), "void");
      const finish = () =>
        store.finalize(c.tenant, c.actor, second.saved.id, second.command, "second-finalize");
      const query = "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE";
      const results =
        first === "void"
          ? await compete(query, [c.tenant, c.lot], cancel, finish)
          : await compete(query, [c.tenant, c.lot], finish, cancel);
      for (const result of results) expect(result.error).toBeUndefined();
      expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual({
        lotId: c.lot,
        basisVersion: 4,
        state: "present",
        supportCount: 1,
        limit: 50,
        offset: 0,
        hasMore: false,
        items: [
          {
            rootId: second.saved.id,
            eventId: second.saved.id,
            eventNumber: second.saved.eventNumber,
            revision: 1,
            lineNos: [1],
          },
        ],
      });
      expect((await store.getLiveRecord(c.tenant, c.actor, original.id)).status).toBe("void");
    },
  );
});
