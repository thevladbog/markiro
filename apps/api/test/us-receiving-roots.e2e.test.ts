import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving root compatibility bridge", () => {
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
  async function roots() {
    return (
      await f.pool.query("SELECT * FROM receiving_event_roots WHERE tenant_id=$1 ORDER BY id", [
        c.tenant,
      ])
    ).rows;
  }
  it("allocates an atomic original root, keeps it on save, and swaps pointers once on finalization", async () => {
    const create = { operationKey: randomUUID(), draft: c.draft };
    const saved = await store.createDraft(c.tenant, c.actor, create, "create");
    expect(
      (
        await f.pool.query(
          "SELECT to_jsonb(e)->>'root_event_id' AS root FROM traceability_events e WHERE tenant_id=$1 AND id=$2",
          [c.tenant, saved.id],
        )
      ).rows,
    ).toEqual([{ root: saved.id }]);
    const initial = {
      id: saved.id,
      tenant_id: c.tenant,
      event_number: saved.eventNumber,
      lifecycle_version: 1,
      next_revision: 2,
      current_event_id: null,
      pending_draft_id: saved.id,
    };
    expect(await roots()).toEqual([initial]);
    const noop = await store.saveDraft(
      c.tenant,
      c.actor,
      saved.id,
      { operationKey: randomUUID(), expectedDraftVersion: 1, draft: c.draft },
      "noop",
    );
    expect(noop).toEqual(saved);
    expect(await roots()).toEqual([initial]);
    const changed = await store.saveDraft(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...c.draft, notes: "Correct note" },
      },
      "save",
    );
    expect(changed.draftVersion).toBe(2);
    expect(await roots()).toEqual([initial]);
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 2,
    });
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
    };
    const finalized = await store.finalize(c.tenant, c.actor, saved.id, command, "finalize");
    expect(finalized.snapshot.snapshotVersion).toBe(2);
    const current = {
      ...initial,
      lifecycle_version: 2,
      current_event_id: saved.id,
      pending_draft_id: null,
    };
    expect(await roots()).toEqual([current]);
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(finalized);
    expect(await store.createDraft(c.tenant, c.actor, create, "old-create")).toEqual(saved);
    expect(await roots()).toEqual([current]);
    expect(JSON.stringify({ saved, finalized })).not.toMatch(
      /rootEventId|lifecycleVersion|nextRevision/,
    );
  });
  it("rolls root allocation back with a failed create audit", async () => {
    await f.pool.query(
      "CREATE FUNCTION synthetic_root_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.receiving.draft_created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_root_audit_fail BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_root_audit_fail()",
    );
    try {
      await expect(
        store.createDraft(
          c.tenant,
          c.actor,
          { operationKey: randomUUID(), draft: c.draft },
          "fail",
        ),
      ).rejects.toBeDefined();
    } finally {
      await f.pool.query(
        "DROP TRIGGER synthetic_root_audit_fail ON tenant_audit_events; DROP FUNCTION synthetic_root_audit_fail()",
      );
    }
    expect(await roots()).toEqual([]);
    expect(
      (await f.pool.query("SELECT id FROM traceability_events WHERE tenant_id=$1", [c.tenant]))
        .rows,
    ).toEqual([]);
    expect(
      (await f.pool.query("SELECT sequence FROM receiving_counters WHERE tenant_id=$1", [c.tenant]))
        .rows,
    ).toEqual([]);
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
  async function businessState() {
    return (
      await f.pool.query(
        `SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [c.tenant],
      )
    ).rows;
  }
  it("rolls pointers, snapshot, lots, tokens and receipts back when final audit fails", async () => {
    const { saved, command } = await ready();
    const before = await businessState();
    await f.pool.query(
      "CREATE FUNCTION synthetic_root_finalize_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.receiving.finalized' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_root_finalize_fail BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_root_finalize_fail()",
    );
    try {
      await expect(
        store.finalize(c.tenant, c.actor, saved.id, command, "fail"),
      ).rejects.toBeDefined();
    } finally {
      await f.pool.query(
        "DROP TRIGGER synthetic_root_finalize_fail ON tenant_audit_events; DROP FUNCTION synthetic_root_finalize_fail()",
      );
    }
    expect(await businessState()).toEqual(before);
    expect((await store.finalize(c.tenant, c.actor, saved.id, command, "retry")).status).toBe(
      "finalized",
    );
  });
  it("denies foreign and missing event identities before acquiring any foreign root", async () => {
    const { saved, command } = await ready();
    const other = await seedCompleteReceiving(f.db);
    const before = await businessState();
    for (const id of [saved.id, randomUUID()]) {
      await expect(
        store.saveDraft(
          other.tenant,
          other.actor,
          id,
          { operationKey: randomUUID(), expectedDraftVersion: 1, draft: other.draft },
          "foreign",
        ),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
      await expect(
        store.finalize(other.tenant, other.actor, id, command, "foreign"),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
    }
    expect(await businessState()).toEqual(before);
    expect(
      (
        await f.pool.query("SELECT id FROM receiving_event_roots WHERE tenant_id=$1", [
          other.tenant,
        ])
      ).rows,
    ).toEqual([]);
  });
  it.each(["save", "finalize"] as const)("locks root before event for %s", async (commandName) => {
    const { saved, command } = await ready();
    const connection = await f.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await connection.query("BEGIN");
      const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid;
      if (!pid) throw new Error("Missing barrier PID");
      await connection.query(
        "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [c.tenant, saved.id],
      );
      pending =
        commandName === "save"
          ? store.saveDraft(
              c.tenant,
              c.actor,
              saved.id,
              {
                operationKey: randomUUID(),
                expectedDraftVersion: 1,
                draft: { ...c.draft, notes: "serialized" },
              },
              "save",
            )
          : store.finalize(c.tenant, c.actor, saved.id, command, "finalize");
      // Attach rejection handling before waiting; inspect the result after release.
      const result = pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      pending = result;
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ query: string }>(
                "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows.map((row) => row.query),
          { timeout: 5000 },
        )
        .toEqual([expect.stringMatching(/receiving_event_roots.*for update/i)]);
      // NOWAIT succeeds only if the blocked command has not locked the event yet.
      await connection.query(
        "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
        [c.tenant, saved.id],
      );
      await connection.query("COMMIT");
      expect((await result).error).toBeUndefined();
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await pending;
    }
  });
});
