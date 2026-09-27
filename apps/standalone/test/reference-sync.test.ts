import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import { createSyncScheduler, ENTITY_SET, syncReferences } from "../src/local/reference-sync.js";
import { HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";

const ORG: ChangeItem = {
  entity: "org_profile",
  id: "1",
  rev: 41,
  deleted: false,
  data: {
    name: "ООО «Атолл»",
    inn: null,
    gln: "4600682000013",
    gs1Prefixes: ["4600682", "4607091"],
    timeZone: "Europe/Moscow",
  },
};
const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 41,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};

function line(id: string, rev: number, name: string, archived = false): ChangeItem {
  return { entity: "lines", id, rev, deleted: false, data: { name, archived } };
}

function tombstone(id: string, rev: number): ChangeItem {
  return { entity: "lines", id, rev, deleted: true };
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}

/** A change feed answering each `since` with its page; any other `since` fails the sync. */
function feed(pages: Record<number, ChangesResponse>) {
  return vi.fn(async (since: number) => {
    const answer = pages[since];
    if (answer === undefined) throw new Error(`unexpected since=${since}`);
    return answer;
  });
}

/** The copies and the sync state as plain rows. */
function tables(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    org: rows("SELECT id, name, inn, gln, gs1_prefixes, time_zone, rev FROM ref_org"),
    site: rows("SELECT id, badge_salt, box_block_size, pallet_block_size, rev FROM ref_site"),
    lines: rows("SELECT id, name, archived, rev FROM ref_lines ORDER BY name"),
    state: rows("SELECT key, value FROM sync_state ORDER BY key"),
  };
}

function state(lastRev: number, hostId = HOST_ID) {
  return [
    { key: "entity_set", value: ENTITY_SET },
    { key: "host_id", value: hostId },
    { key: "last_rev", value: String(lastRev) },
  ];
}

/** Two synced lines at revisions 10 and 20, from `HOST_ID`. */
async function syncedTwoLines(executor: LocalExecutor): Promise<void> {
  await syncReferences({
    changes: feed({ 0: page(20, [line(LINE_1, 10, "Линия 1"), line(LINE_2, 20, "Линия 2")]) }),
    local: executor,
    hostId: HOST_ID,
  });
}

/** An executor that records how many rows each statement of each batch changed. */
function counting(executor: LocalExecutor) {
  const batches: number[][] = [];
  const counted: LocalExecutor = {
    query: (sql, params, row) => executor.query(sql, params, row),
    transaction: async (statements) => {
      const changes = await executor.transaction(statements);
      batches.push(changes);
      return changes;
    },
  };
  return { executor: counted, batches };
}

/**
 * An executor whose `query` reads immediately (capturing whatever is
 * committed at that instant) but only delivers the result once released,
 * and whose `transaction` does not run at all until released — so two
 * `syncReferences` runs can be made to race deterministically: both reading
 * `sync_state` before either writes, and their writes ordered by choice
 * rather than by whichever happens to reach `transaction` first. Reads are
 * released oldest-first (their order of arrival is reliable, since nothing
 * else runs between two synchronous `releaseRead` calls); writes are found
 * by a value one of their statements carries, since two racing preambles
 * can reach `transaction` in either order. `stopHoldingWrites` lets every
 * write after the ones the test cared about (each run's own page batch,
 * once the preamble race is already settled) proceed immediately, so the
 * test does not also have to schedule those.
 */
function heldOps(executor: LocalExecutor) {
  const reads: Array<() => void> = [];
  const writes: Array<{ statements: readonly LocalStatement[]; run: () => void }> = [];
  let holdWrites = true;
  const held: LocalExecutor = {
    query: async (sql, params, row) => {
      const result = await executor.query(sql, params, row);
      await new Promise<void>((resolve) => reads.push(resolve));
      return result;
    },
    transaction: (statements) => {
      if (!holdWrites) return executor.transaction(statements);
      return new Promise<number[]>((resolve, reject) => {
        writes.push({
          statements,
          run: () => executor.transaction(statements).then(resolve, reject),
        });
      });
    },
  };
  return {
    executor: held,
    readCount: () => reads.length,
    writeCount: () => writes.length,
    releaseRead: () => reads.shift()?.(),
    /** Releases the queued write with a statement whose `values` include `marker`. */
    releaseWrite: (marker: string) => {
      const index = writes.findIndex((w) => w.statements.some((s) => s.values?.includes(marker)));
      const [write] = writes.splice(index, 1);
      write?.run();
    },
    stopHoldingWrites: () => {
      holdWrites = false;
    },
  };
}

describe("ENTITY_SET", () => {
  it("stays org_profile,site,lines", () => {
    // Derived from the entity table; pinned so a build cannot update one and
    // forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines");
  });
});

describe("reference sync", () => {
  it("copies every record of the first full sync", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(42, [line(LINE_2, 40, "Линия 2", true), ORG, SITE, line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
    });
    expect(changes).toHaveBeenCalledWith(0);
    expect(tables(db)).toEqual({
      org: [
        {
          id: "1",
          name: "ООО «Атолл»",
          inn: null,
          gln: "4600682000013",
          gs1_prefixes: '["4600682","4607091"]',
          time_zone: "Europe/Moscow",
          rev: 41,
        },
      ],
      site: [
        {
          id: "1",
          badge_salt: "AAECAwQFBgcICQoLDA0ODw==",
          box_block_size: 2000,
          pallet_block_size: 200,
          rev: 41,
        },
      ],
      lines: [
        { id: LINE_1, name: "Линия 1", archived: 0, rev: 42 },
        { id: LINE_2, name: "Линия 2", archived: 1, rev: 40 },
      ],
      state: state(42),
    });
  });

  it("updates an existing org record when a newer revision changes its fields", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(41, [ORG]) }),
      local: executor,
      hostId: HOST_ID,
    });
    const changedOrg: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 50,
      deleted: false,
      data: {
        name: "ООО «Атолл Новый»",
        inn: "7701234567",
        gln: "4600682000099",
        gs1Prefixes: ["4611111"],
        timeZone: "Asia/Yekaterinburg",
      },
    };
    await syncReferences({
      changes: feed({ 41: page(50, [changedOrg]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(tables(db).org).toEqual([
      {
        id: "1",
        name: "ООО «Атолл Новый»",
        inn: "7701234567",
        gln: "4600682000099",
        gs1_prefixes: '["4611111"]',
        time_zone: "Asia/Yekaterinburg",
        rev: 50,
      },
    ]);
  });

  it("updates an existing site record when a newer revision changes its fields", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(41, [SITE]) }),
      local: executor,
      hostId: HOST_ID,
    });
    const changedSite: ChangeItem = {
      entity: "site",
      id: "1",
      rev: 55,
      deleted: false,
      data: { badgeSalt: "ZGVmZ2hpamtsbW5vcHFycw==", boxBlockSize: 3000, palletBlockSize: 300 },
    };
    await syncReferences({
      changes: feed({ 41: page(55, [changedSite]) }),
      local: executor,
      hostId: HOST_ID,
    });
    expect(tables(db).site).toEqual([
      {
        id: "1",
        badge_salt: "ZGVmZ2hpamtsbW5vcHFycw==",
        box_block_size: 3000,
        pallet_block_size: 300,
        rev: 55,
      },
    ]);
  });

  it("follows the feed page by page from the last applied revision", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(41, [ORG, SITE], true),
      41: page(42, [line(LINE_1, 42, "Линия 1")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
    });
    expect(changes.mock.calls).toEqual([[0], [41]]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(tables(db).state).toEqual(state(42));

    // The next sync asks only for what came after.
    const next = feed({ 42: page(43, [line(LINE_1, 43, "Линия 1 (упаковка)")]) });
    await syncReferences({ changes: next, local: executor, hostId: HOST_ID });
    expect(next.mock.calls).toEqual([[42]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (упаковка)", archived: 0, rev: 43 },
    ]);
  });

  it("applies the same page again without changing a record", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({ 0: page(42, [ORG, SITE, line(LINE_1, 42, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    const before = tables(db);
    // As if the revision were lost: the same page arrives again.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    const recorded = counting(executor);
    await syncReferences({ changes, local: recorded.executor, hostId: HOST_ID });
    expect(tables(db)).toEqual(before);
    // The guard passed (0: `host_id` still matched) and the three upserts
    // found nothing newer; only the sync state was written.
    expect(recorded.batches).toEqual([[0, 0, 0, 0, 3]]);
  });

  it("deletes by tombstone, but never a record newer than the tombstone", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({ 20: page(30, [tombstone(LINE_1, 25), tombstone(LINE_2, 15)]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 20 }]);
    expect(tables(db).state).toEqual(state(30));
  });

  it("starts again from zero when the host went back to an older revision", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Restored from a copy taken at revision 12: `rev` is below the device's.
    const changes = feed({
      20: page(12, []),
      0: page(12, [line(LINE_1, 12, "Линия 1 (из копии)")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 12,
    });
    expect(changes.mock.calls).toEqual([[20], [0]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (из копии)", archived: 0, rev: 12 },
    ]);
    expect(tables(db).state).toEqual(state(12));
  });

  it("keeps the previous copies when the rollback's own refetch fails", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const before = tables(db);
    // The host went back (rev < since), but the refetch from zero — the
    // request that would carry the deferred wipe — never lands.
    const changes = vi.fn(async (since: number) => {
      if (since === 20) return page(12, []);
      throw new Error("host unreachable");
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      "host unreachable",
    );
    expect(changes.mock.calls).toEqual([[20], [0]]);
    // Spec §5.4: the copies stay until the first new page actually lands.
    expect(tables(db)).toEqual(before);
  });

  it("gives up when the host goes back twice in one sync", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({
      20: page(12, []),
      0: page(8, [line(LINE_1, 8, "Линия 1")], true),
      8: page(5, []),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /went back twice/,
    );
    // The second rollback's page (empty, at rev 5) is caught before any
    // transaction: the copies still hold exactly what the first restart
    // applied (page 8's single line), untouched by the second.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_1, name: "Линия 1", archived: 0, rev: 8 }],
      state: state(8),
    });
  });

  it("refuses a feed that claims more pages without advancing the revision", async () => {
    const { executor } = openLocalDb();
    // Answers every `since` with a page at that same revision, forever — but
    // bounded, so a regression that drops the guard fails this test fast
    // (a distinct error) instead of hanging it: the retry loop only awaits
    // already-resolved promises, so it starves Vitest's own timer and its
    // `--testTimeout` never fires.
    let calls = 0;
    const changes = vi.fn(async (since: number) => {
      calls += 1;
      if (calls > 5) throw new Error("the loop did not stop");
      return page(since, [], true);
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /no progress/,
    );
    // The guard's own message, not the bound's: proves the guard stopped the
    // loop, not the counter. Caught on the first page, not after looping.
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("wipes the copies of a pairing with another host before anything else", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [ORG, line(LINE_2, 20, "Чужая линия")], false, OTHER_HOST) }),
      local: executor,
      hostId: OTHER_HOST,
    });
    // Paired with HOST_ID now, and the host is out of reach.
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID }),
    ).rejects.toThrow("host unreachable");
    // The immediate wipe itself already committed, with no `last_rev`: the
    // copies still read as unsynced, and a stale in-flight run for the old
    // host would still find `host_id` repointed to this one.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: [{ key: "host_id", value: HOST_ID }],
    });

    const changes = feed({ 0: page(5, [line(LINE_1, 5, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 5 }]);
    expect(tables(db).state).toEqual(state(5));
  });

  it("rejects a stale in-flight page for the old host after a re-pair wiped its copies", async () => {
    const { db, executor } = openLocalDb();
    // Host A is fully synced (no org data yet).
    await syncReferences({
      changes: feed({ 0: page(10, []) }),
      local: executor,
      hostId: HOST_ID,
    });
    // A's next sync starts a request that stays in flight until resolved below.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({ changes: aChanges, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(aChanges).toHaveBeenCalledWith(10));

    // Meanwhile the device is re-paired to B, which wipes and takes over —
    // `stop()` on A's scheduler cannot cancel A's in-flight request. B writes
    // its own org profile, at a lower row revision than A's late page below.
    const orgB: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 20,
      deleted: false,
      data: {
        name: "ООО «Б»",
        inn: null,
        gln: "4600682000099",
        gs1Prefixes: ["4611111"],
        timeZone: "Asia/Yekaterinburg",
      },
    };
    // With `hasMore: false`, the page's own `rev` must be at least every
    // item's `rev` — B's page is at revision 20, matching `orgB`.
    await expect(
      syncReferences({
        changes: feed({ 0: page(20, [orgB], false, OTHER_HOST) }),
        local: executor,
        hostId: OTHER_HOST,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 20 });

    // A's late page arrives, with a *higher* row revision for the same org id
    // ('1' on every host): unguarded, `excluded.rev > ref_org.rev` would let
    // it win and resurrect A's (stale) org profile over B's. The page's own
    // `rev` (50) matches `orgA`'s, for the same reason as B's above.
    const orgA: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 50,
      deleted: false,
      data: {
        name: "ООО «А»",
        inn: null,
        gln: "4600682000013",
        gs1Prefixes: ["4600682"],
        timeZone: "Europe/Moscow",
      },
    };
    resolveA?.(page(50, [orgA], false, HOST_ID));

    // It must be rejected instead.
    const error: unknown = await runA.then(
      () => {
        throw new Error("expected A's stale sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    expect(tables(db)).toEqual({
      org: [
        {
          id: "1",
          name: "ООО «Б»",
          inn: null,
          gln: "4600682000099",
          gs1_prefixes: '["4611111"]',
          time_zone: "Asia/Yekaterinburg",
          rev: 20,
        },
      ],
      site: [],
      lines: [],
      state: state(20, OTHER_HOST),
    });
  });

  it("fails the old host's page as soon as the re-pair's own preamble commits, before B's page even lands", async () => {
    const { db, executor } = openLocalDb();
    // Host A is fully synced.
    await syncReferences({
      changes: feed({ 0: page(10, []) }),
      local: executor,
      hostId: HOST_ID,
    });
    // A's next sync starts a request that stays in flight.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({ changes: aChanges, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(aChanges).toHaveBeenCalledWith(10));

    // B re-pairs; B's own fetch is held open too, but its preamble — the
    // immediate wipe and `host_id` stamp — runs synchronously before any
    // fetch, so it does not need to win a race against A's pending one.
    let resolveB: ((value: ChangesResponse) => void) | undefined;
    const bChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveB = resolve;
        }),
    );
    const runB = syncReferences({ changes: bChanges, local: executor, hostId: OTHER_HOST });
    await vi.waitFor(() => expect(bChanges).toHaveBeenCalledWith(0));

    // A's page lands first, while B's is still pending.
    resolveA?.(page(11, [line(LINE_1, 11, "Линия A (поздно)")], false, HOST_ID));
    const error: unknown = await runA.then(
      () => {
        throw new Error("expected A's stale sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    // B's preamble already wiped A's copies and claimed `host_id`, even
    // though B's own page has not landed yet.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: [{ key: "host_id", value: OTHER_HOST }],
    });

    // B's page lands second.
    resolveB?.(page(20, [line(LINE_2, 20, "Линия B")], false, OTHER_HOST));
    await expect(runB).resolves.toEqual({ kind: "synced", rev: 20 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия B", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
  });

  it("stamps host_id before the first fetch, so a fresh pairing's own first sync is not rejected by a stale rival's own first sync", async () => {
    const { db, executor } = openLocalDb();
    const held = heldOps(executor);

    // Two first syncs start "at the same time": both read `sync_state`
    // before either has had a chance to act on it — for example, a
    // device's very first sync for host X is still reading state when it
    // is re-paired to Y, and Y's own first sync starts and reads the same
    // still-empty state before X has committed anything.
    let resolveOld: ((value: ChangesResponse) => void) | undefined;
    const oldChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const runOld = syncReferences({ changes: oldChanges, local: held.executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(held.readCount()).toBe(1));

    let resolveNew: ((value: ChangesResponse) => void) | undefined;
    const newChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveNew = resolve;
        }),
    );
    const runNew = syncReferences({
      changes: newChanges,
      local: held.executor,
      hostId: OTHER_HOST,
    });
    await vi.waitFor(() => expect(held.readCount()).toBe(2));

    // Release both reads: each already captured `sync_state` completely
    // empty, since neither run could have written anything before both
    // reads were issued. Each now queues its own preamble stamp instead of
    // running it, so the order of those two writes can be chosen below
    // rather than left to chance.
    held.releaseRead();
    held.releaseRead();
    await vi.waitFor(() => expect(held.writeCount()).toBe(2));

    // Old's stamp commits first, New's second: New ends up "claiming"
    // `host_id`, exactly as if the re-pair to New happened a moment after
    // Old's own first sync had already started. From here on, each run's
    // own page batch (the only other transaction either will run) can
    // proceed on its own: the preamble race is already settled.
    held.releaseWrite(HOST_ID);
    await vi.waitFor(() => expect(held.writeCount()).toBe(1));
    held.releaseWrite(OTHER_HOST);
    held.stopHoldingWrites();
    await vi.waitFor(() => expect(oldChanges).toHaveBeenCalledWith(0));
    await vi.waitFor(() => expect(newChanges).toHaveBeenCalledWith(0));

    // Old's page lands...
    resolveOld?.(page(10, [line(LINE_1, 10, "Линия старого хоста")], false, HOST_ID));
    const error: unknown = await runOld.then(
      () => {
        throw new Error("expected the stale first sync to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });

    // ...and, since New's stamp is what `host_id` ended up holding, its own
    // page succeeds — the stale rival's first sync never got a chance to
    // corrupt it, even though both started from the very same empty state.
    resolveNew?.(page(20, [line(LINE_2, 20, "Линия нового хоста")], false, OTHER_HOST));
    await expect(runNew).resolves.toEqual({ kind: "synced", rev: 20 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия нового хоста", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
  });

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // A build with a different entity set arms a deferred wipe for the next page.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const before = tables(db);
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "other_host",
    });
    // The armed wipe never ran: `other_host` short-circuits before any transaction.
    expect(tables(db)).toEqual(before);
  });

  it("syncs from zero for another entity set, keeping the copies until a page arrives", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Written by a build that kept fewer entities.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toHaveLength(2);

    const changes = feed({ 0: page(20, [SITE, line(LINE_1, 10, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 10 }]);
    expect(tables(db).site).toHaveLength(1);
    expect(tables(db).state).toEqual(state(20));
  });

  it("applies nothing of a page with an unreadable record, even with a deferred wipe pending", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // A build with a different entity set arms a deferred wipe for the next page.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const before = tables(db);
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [line(LINE_1, 40, "Линия 1"), broken]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /site record 1/,
    );
    // The armed wipe never ran: the bad record fails before any transaction.
    expect(tables(db)).toEqual(before);
  });

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    const operator: ChangeItem = {
      entity: "operators",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { login: "1001" },
    };
    const changes = feed({ 0: page(42, [operator, line(LINE_1, 42, "Линия 1")]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 42,
    });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});

describe("sync scheduler", () => {
  it("runs one sync at a time and exactly once more for triggers during a run", async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const scheduler = createSyncScheduler(run);
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    finish[0]?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves a failed sync to the next trigger", async () => {
    const run = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("host unreachable"));
    run.mockResolvedValue(undefined);
    const scheduler = createSyncScheduler(run);
    scheduler.trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.trigger();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it("starts nothing after stop", async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = createSyncScheduler(run);
    scheduler.stop();
    scheduler.trigger();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it("starts no further run after stop, even with a trigger queued during the run", async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const scheduler = createSyncScheduler(run);
    scheduler.trigger(); // starts the one run
    scheduler.trigger(); // queues exactly one follow-up
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    finish[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
