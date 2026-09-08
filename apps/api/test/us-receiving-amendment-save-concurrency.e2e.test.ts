import { randomUUID } from "node:crypto";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
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
describe.skipIf(!url)("Receiving amendment save real transaction races", { timeout: 15000 }, () => {
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
  async function start() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    await store.finalize(
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
    const started = await store.amend(
      c.tenant,
      c.actor,
      saved.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct receipt",
      },
      "amend",
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected draft");
    const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
    draft.notes = "Checked correction";
    return {
      original: saved.id,
      started,
      command: {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedLifecycleVersion: 3,
        draft,
      },
    };
  }
  async function compete<A, B>(root: string, first: () => Promise<A>, second: () => Promise<B>) {
    const gate = await f.pool.connect();
    await gate.query("BEGIN");
    const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    if (!pid) throw new Error("Missing synthetic barrier");
    await gate.query(
      "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [c.tenant, root],
    );
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
  it("replays a concurrent no-op without rewriting its amendment or lot basis", async () => {
    const { original, started, command } = await start();
    if (started.record.content.kind !== "draft") throw new Error("Expected draft");
    const noop = {
      ...command,
      draft: receivingAmendmentDraftSchema.parse(started.record.content.draft),
    };
    const basis = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
    const [a, b] = await compete(
      original,
      () => store.saveAmendment(c.tenant, c.actor, started.eventId, noop, "first"),
      () => store.saveAmendment(c.tenant, c.actor, started.eventId, noop, "second"),
    );
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(b.value).toEqual(a.value);
    expect(a.value?.record).toEqual(started.record);
    expect(await store.getLiveRecord(c.tenant, c.actor, started.eventId)).toEqual(started.record);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(basis);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.save'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.draft_saved'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
  it.each([true, false])(
    "serializes concurrent saves (same key=%s) with one content update",
    async (same) => {
      const { original, started, command } = await start();
      const basis = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
      const [a, b] = await compete(
        original,
        () => store.saveAmendment(c.tenant, c.actor, started.eventId, command, "first"),
        () =>
          store.saveAmendment(
            c.tenant,
            c.actor,
            started.eventId,
            same
              ? command
              : {
                  ...command,
                  operationKey: randomUUID(),
                  draft: { ...command.draft, notes: "Competing correction" },
                },
            "second",
          ),
      );
      expect(a.error).toBeUndefined();
      if (same) {
        expect(b.error).toBeUndefined();
        expect(b.value).toEqual(a.value);
      } else
        expect(b.error).toMatchObject({
          status: 409,
          response: { code: "receiving_draft_conflict" },
        });
      expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(basis);
      expect(await store.getLiveRecord(c.tenant, c.actor, started.eventId)).toMatchObject({
        draftVersion: 2,
        lifecycle: { lifecycleVersion: 3 },
        content: { draft: command.draft },
      });
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,target_id,outcome,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.draft_saved'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          actor_user_id: c.actor,
          target_id: started.eventId,
          outcome: "success",
          request_id: "first",
        },
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS count FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.save'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    },
  );
  it.each([true, false])(
    "serializes save versus cancellation (save first=%s) with one accepted change",
    async (saveFirst) => {
      const { original, started, command } = await start();
      const beforeLots = (
        await f.pool.query(
          "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows;
      const save = () => store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
      const cancel = () =>
        store.void(
          c.tenant,
          c.actor,
          started.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 3,
            expectedDraftVersion: 1,
            reason: "Cancel correction",
          },
          "cancel",
        );
      const [a, b] = await compete(original, saveFirst ? save : cancel, saveFirst ? cancel : save);
      expect(a.error).toBeUndefined();
      expect(b.error).toMatchObject({
        status: 409,
        response: { code: saveFirst ? "receiving_draft_conflict" : "receiving_lifecycle_conflict" },
      });
      expect((await store.getLiveRecord(c.tenant, c.actor, original)).status).toBe("finalized");
      expect(await store.getLiveRecord(c.tenant, c.actor, started.eventId)).toMatchObject({
        status: saveFirst ? "draft" : "void",
        draftVersion: saveFirst ? 2 : 1,
        lifecycle: {
          lifecycleVersion: saveFirst ? 3 : 4,
          currentEventId: original,
          pendingDraftId: saveFirst ? started.eventId : null,
        },
      });
      expect(
        (
          await f.pool.query(
            "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
            [c.tenant],
          )
        ).rows,
      ).toEqual(beforeLots);
      expect(
        (
          await f.pool.query(
            "SELECT actor_user_id,target_id,action,outcome,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action IN ('traceability.receiving.draft_saved','traceability.receiving.voided')",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          actor_user_id: c.actor,
          target_id: started.eventId,
          action: saveFirst
            ? "traceability.receiving.draft_saved"
            : "traceability.receiving.voided",
          outcome: "success",
          request_id: saveFirst ? "save" : "cancel",
        },
      ]);
    },
  );
});
