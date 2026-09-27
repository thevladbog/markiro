import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCaseBridge, caseState } from "./support/us-case-bridge-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US case concurrency", () => {
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

  // A real trigger suspends the leader while it holds row locks; pg_blocking_pids
  // proves the follower uses another connection with a pre-commit snapshot.
  async function race(
    table: "trace_lot_boxes" | "traceability_events",
    event: "INSERT" | "UPDATE",
    condition: string,
    leaderRun: () => Promise<unknown>,
    followerRun: () => Promise<unknown>,
  ) {
    const barrier = await f.pool.connect();
    const settle = (run: () => Promise<unknown>) =>
      run().then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
    let leader: ReturnType<typeof settle> | undefined,
      follower: ReturnType<typeof settle> | undefined;
    try {
      await barrier.query("SELECT pg_advisory_lock(20406)");
      await f.pool.query(
        `CREATE FUNCTION case_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(20406); END IF; RETURN NEW; END $$; CREATE TRIGGER case_race_barrier BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION case_race_barrier()`,
      );
      leader = settle(leaderRun);
      let pid: number | undefined;
      await expect
        .poll(
          async () => {
            const rows = (
              await f.pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query NOT LIKE 'SELECT pg_advisory%'",
              )
            ).rows;
            pid = rows[0]?.pid;
            return rows.length;
          },
          { timeout: 3000 },
        )
        .toBe(1);
      follower = settle(followerRun);
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0]?.n,
          { timeout: 3000 },
        )
        .toBe(1);
      await barrier.query("SELECT pg_advisory_unlock(20406)");
      return [await leader, await follower];
    } finally {
      await barrier.query("SELECT pg_advisory_unlock(20406)");
      await leader;
      await follower;
      await f.pool.query(
        `DROP TRIGGER IF EXISTS case_race_barrier ON ${table}; DROP FUNCTION IF EXISTS case_race_barrier()`,
      );
      barrier.release();
    }
  }

  it.each([true, false])(
    "concurrent link/link converges (same operation key: %s)",
    async (sameKey) => {
      const c = await seedCaseBridge(f),
        key = randomUUID();
      const first = () =>
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: key, ssccs: [c.codes[0]] },
          "leader",
        );
      const second = () =>
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: sameKey ? key : randomUUID(), ssccs: [c.codes[0]] },
          "follower",
        );
      const outcomes = await race(
        "trace_lot_boxes",
        "INSERT",
        `NEW.tenant_id='${c.tenant}'`,
        first,
        second,
      );
      expect(outcomes).toMatchObject([{ ok: true }, { ok: true }]);
      if (sameKey) expect(outcomes[0]).toEqual(outcomes[1]);
      else
        expect(outcomes[1]).toMatchObject({
          value: { created: [], unchanged: [{ ssccAtLink: c.codes[0] }] },
        });
      expect(await c.activeLinks(c.tenant, c.codes[0]!)).toHaveLength(1);
      const state = await caseState(f, c.tenant);
      expect(state.receipts).toHaveLength(sameKey ? 1 : 2);
      expect(state.audits).toHaveLength(sameKey ? 1 : 2);
    },
  );

  it("cross-lot contenders cannot both link the same box", async () => {
    const c = await seedCaseBridge(f);
    const draft = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.saved.draft,
          outputs: c.saved.draft.outputs.map((line) => ({ ...line, tlc: "SECOND-OUTPUT" })),
        },
      },
      "second",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: 1,
    });
    const origin = await c.store.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize-second",
    );
    const key = randomUUID();
    const outcomes = await race(
      "trace_lot_boxes",
      "INSERT",
      `NEW.tenant_id='${c.tenant}'`,
      () =>
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: randomUUID(), ssccs: [c.codes[0]] },
          "leader",
        ),
      () =>
        store.link(
          c.tenant,
          c.actor,
          origin.snapshot.outputs[0]!.lotId,
          { operationKey: key, ssccs: [c.codes[0]] },
          "follower",
        ),
    );
    expect(outcomes).toMatchObject([
      { ok: true },
      { ok: false, error: { response: { code: "case_link_conflict" } } },
    ]);
    expect(await c.activeLinks(c.tenant, c.codes[0]!)).toHaveLength(1);
    expect(await c.auditForOperation(c.tenant, key)).toBeUndefined();
    expect((await caseState(f, c.tenant)).receipts).toHaveLength(1);
  });

  it.each(["void", "link"] as const)("orders %s first against origin change", async (first) => {
    const c = await seedCaseBridge(f),
      key = randomUUID();
    const link = () =>
      store.link(c.tenant, c.actor, c.lotId, { operationKey: key, ssccs: [c.codes[0]] }, "link");
    const voidOrigin = () =>
      c.store.void(
        c.tenant,
        c.actor,
        c.original.id,
        { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Invalid origin" },
        "void",
      );
    const outcomes =
      first === "void"
        ? await race(
            "traceability_events",
            "UPDATE",
            `NEW.id='${c.original.id}'::uuid AND NEW.status='void'`,
            voidOrigin,
            link,
          )
        : await race("trace_lot_boxes", "INSERT", `NEW.tenant_id='${c.tenant}'`, link, voidOrigin);
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(outcomes[1]).toMatchObject(
      first === "void"
        ? { ok: false, error: { response: { code: "case_origin_not_current" } } }
        : { ok: true },
    );
    // Link-before-void is legal historical linkage; void-before-link is refused.
    expect(await c.activeLinks(c.tenant, c.codes[0]!)).toHaveLength(first === "void" ? 0 : 1);
    expect((await caseState(f, c.tenant)).receipts ?? []).toHaveLength(first === "void" ? 0 : 1);
    if (first === "void") expect(await c.auditForOperation(c.tenant, key)).toBeUndefined();
  });

  it("unlink/relink and stale unlink preserve the new link identity", async () => {
    const c = await seedCaseBridge(f);
    const first = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "first",
    );
    const oldId = first.created[0]!.linkId;
    const outcomes = await race(
      "trace_lot_boxes",
      "UPDATE",
      `NEW.id='${oldId}'::uuid`,
      () =>
        store.unlink(
          c.tenant,
          c.actor,
          c.lotId,
          oldId,
          { operationKey: randomUUID(), reason: "Wrong lot" },
          "unlink",
        ),
      () =>
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: randomUUID(), ssccs: [c.codes[0]] },
          "relink",
        ),
    );
    expect(outcomes).toMatchObject([
      { ok: true },
      { ok: true, value: { created: [{ ssccAtLink: c.codes[0] }] } },
    ]);
    const active = await c.activeLinks(c.tenant, c.codes[0]!);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).not.toBe(oldId);
    const before = await caseState(f, c.tenant);
    await expect(
      store.unlink(
        c.tenant,
        c.actor,
        c.lotId,
        oldId,
        { operationKey: randomUUID(), reason: "Delayed intent" },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "case_link_stale" } });
    expect(await caseState(f, c.tenant)).toEqual(before);
  });

  it("a stale unlink blocked behind a relink cannot remove the new row", async () => {
    const c = await seedCaseBridge(f);
    const original = await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "original",
    );
    const oldId = original.created[0]!.linkId;
    await store.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      oldId,
      { operationKey: randomUUID(), reason: "Wrong lot" },
      "unlink",
    );
    const staleKey = randomUUID();
    const outcomes = await race(
      "trace_lot_boxes",
      "INSERT",
      `NEW.tenant_id='${c.tenant}'`,
      () =>
        store.link(
          c.tenant,
          c.actor,
          c.lotId,
          { operationKey: randomUUID(), ssccs: [c.codes[0]] },
          "relink",
        ),
      () =>
        store.unlink(
          c.tenant,
          c.actor,
          c.lotId,
          oldId,
          { operationKey: staleKey, reason: "Delayed intent" },
          "stale",
        ),
    );
    expect(outcomes).toMatchObject([
      { ok: true },
      { ok: false, error: { response: { code: "case_link_stale" } } },
    ]);
    const active = await c.activeLinks(c.tenant, c.codes[0]!);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).not.toBe(oldId);
    expect(await c.auditForOperation(c.tenant, staleKey)).toBeUndefined();
    expect((await caseState(f, c.tenant)).receipts).toHaveLength(3);
  });
});
