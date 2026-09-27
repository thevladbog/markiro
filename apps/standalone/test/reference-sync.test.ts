import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  createSyncScheduler,
  ENTITY_SET,
  SyncFeedError,
  syncReferences,
} from "../src/local/reference-sync.js";
import { HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const LINE_1 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
/** When a test's pages are applied, on this computer's clock. */
const SEEN_AT = 1_790_000_000_000;

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

/** A line whose `archived` is not a boolean: it fails its schema. */
function brokenLine(id: string, rev: number): ChangeItem {
  return { entity: "lines", id, rev, deleted: false, data: { name: "Линия 1", archived: "да" } };
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

/** The quarantined records as plain rows. */
function quarantine(db: DatabaseSync) {
  const sql = "SELECT entity, id, rev, reason, seen_at FROM sync_quarantine ORDER BY entity, id";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
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
  it("names the kept entities and the version of their records", () => {
    // Derived from the entity table and `SYNC_SCHEMA_VERSION`; pinned so a
    // build cannot change one and forget the other.
    expect(ENTITY_SET).toBe("org_profile,site,lines;v2");
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
      quarantined: 0,
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
      quarantined: 0,
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
    // The guard passed (1: `host_id` still matched and was touched), the
    // three upserts found nothing newer and nothing was quarantined to lift;
    // only the sync state was written.
    expect(recorded.batches).toEqual([[1, 0, 0, 0, 0, 3]]);
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
      quarantined: 0,
    });
    expect(changes.mock.calls).toEqual([[20], [0]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (из копии)", archived: 0, rev: 12 },
    ]);
    expect(tables(db).state).toEqual(state(12));
    // The deferred wipe clears the quarantine along with the copies (there
    // was nothing quarantined here, but the wipe covers the table all the
    // same — see "keeps a quarantine entry through a rollback…" below for a
    // case where it actually holds an entry).
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps the previous copies when the rollback's own refetch fails", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const before = tables(db);
    const quarantineBefore = quarantine(db);
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
    expect(quarantine(db)).toEqual(quarantineBefore);
  });

  it("gives up when the host goes back twice in one sync", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({
      20: page(12, []),
      0: page(8, [line(LINE_1, 8, "Линия 1")], true),
      8: page(5, []),
    });
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID });
    await expect(run).rejects.toThrow(/went back twice/);
    await expect(run).rejects.toBeInstanceOf(SyncFeedError);
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
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID });
    await expect(run).rejects.toThrow(/no progress/);
    await expect(run).rejects.toBeInstanceOf(SyncFeedError);
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
    ).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });

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
    await expect(runB).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
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
    // Its closing read of the quarantine count is held like every read.
    await vi.waitFor(() => expect(held.readCount()).toBe(1));
    held.releaseRead();
    await expect(runNew).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия нового хоста", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST),
    });
  });

  it("fails a page committed after clear_copies wiped the local copies mid-flight, instead of resurrecting them", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(10, [line(LINE_1, 10, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
    });
    // The next sync's fetch is held open, as if `device_forget` ran while it
    // was still in flight.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const run = syncReferences({ changes: held, local: executor, hostId: HOST_ID });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(10));

    // `clear_copies` (`device_forget`) deletes every row of every table,
    // `sync_state` included, in one transaction of its own.
    for (const table of ["ref_org", "ref_site", "ref_lines", "sync_quarantine", "sync_state"]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    resolve?.(page(11, [line(LINE_1, 11, "Линия 1 (после сброса)")]));
    const error: unknown = await run.then(
      () => {
        throw new Error("expected the page to fail against the cleared copies");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });
    expect(quarantine(db)).toEqual([]);
  });

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // A build with a different entity set arms a deferred wipe for the next page.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    const before = tables(db);
    const quarantineBefore = quarantine(db);
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "other_host",
    });
    // The armed wipe never ran: `other_host` short-circuits before any transaction.
    expect(tables(db)).toEqual(before);
    expect(quarantine(db)).toEqual(quarantineBefore);
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
      quarantined: 0,
    });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    // Records of another build's entities are not this build's to judge.
    expect(quarantine(db)).toEqual([]);
  });
});

describe("sync quarantine", () => {
  it("quarantines a record that fails its schema and applies the rest of the page", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [ORG, broken, line(LINE_1, 42, "Линия 1")]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 1 });
    expect(tables(db).org).toHaveLength(1);
    expect(tables(db).site).toEqual([]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(tables(db).state).toEqual(state(42));
    expect(quarantine(db)).toEqual([
      {
        entity: "site",
        id: "1",
        rev: 41,
        reason: "badgeSalt: invalid_format; badgeSalt: too_small; palletBlockSize: invalid_type",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("fails closed: an unreadable record newer than the copy deletes it, an older one does not", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // Only a replay produces LINE_2's page here: outside a rollback, the
    // host feed never sends an older revision of a record after a newer
    // one, so a real host would never actually follow LINE_2's rev-20 copy
    // with a rev-15 poison in a forward-moving page.
    const changes = feed({ 20: page(30, [brokenLine(LINE_1, 25), brokenLine(LINE_2, 15)]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, now: () => SEEN_AT }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    // LINE_1 was at revision 10, older than its unreadable 25: it goes.
    // LINE_2 was at 20, newer than its unreadable 15: it stays — quarantined
    // and intact at once.
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 20 }]);
    expect(tables(db).state).toEqual(state(30));
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_2, rev: 15, reason: "archived: invalid_type", seen_at: SEEN_AT },
      { entity: "lines", id: LINE_1, rev: 25, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);
  });

  it("lifts a quarantine for a newer readable record or tombstone, never for an older one", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    await syncReferences({
      changes: feed({ 0: page(42, [broken, brokenLine(LINE_1, 42)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(2);

    // The host fixed the site; a tombstone older than the quarantined line
    // changes nothing. Only a replay produces that tombstone here too:
    // outside a rollback, the host never sends a tombstone older than a
    // revision it already quarantined.
    await expect(
      syncReferences({
        changes: feed({ 42: page(50, [{ ...SITE, rev: 45 }, tombstone(LINE_1, 40)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 50, quarantined: 1 });
    expect(tables(db).site).toEqual([
      {
        id: "1",
        badge_salt: "AAECAwQFBgcICQoLDA0ODw==",
        box_block_size: 2000,
        pallet_block_size: 200,
        rev: 45,
      },
    ]);
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_1, rev: 42, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);

    // The host deleted the line.
    await expect(
      syncReferences({
        changes: feed({ 50: page(60, [tombstone(LINE_1, 55)]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 60, quarantined: 0 });
    expect(quarantine(db)).toEqual([]);
  });

  it("lifts a quarantine for a readable record at exactly the quarantined revision", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(42, [brokenLine(LINE_1, 42)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(1);

    // The host resent the very same revision, now readable: `>=`, not a
    // strictly newer `>`, is what lifts the quarantine.
    await expect(
      syncReferences({
        changes: feed({ 42: page(42, [line(LINE_1, 42, "Линия 1")]) }),
        local: executor,
        hostId: HOST_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 0 });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps one entry per record: a newer unreadable revision replaces it, the same page again does not", async () => {
    const { db, executor } = openLocalDb();
    const first = feed({ 0: page(42, [brokenLine(LINE_1, 42)]) });
    await syncReferences({ changes: first, local: executor, hostId: HOST_ID, now: () => SEEN_AT });
    // As if the revision were lost: the same page arrives again, later.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    await syncReferences({
      changes: first,
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT + 1000,
    });
    expect(quarantine(db)).toEqual([
      { entity: "lines", id: LINE_1, rev: 42, reason: "archived: invalid_type", seen_at: SEEN_AT },
    ]);

    const renamed: ChangeItem = {
      entity: "lines",
      id: LINE_1,
      rev: 50,
      deleted: false,
      data: { name: 7, archived: false },
    };
    await syncReferences({
      changes: feed({ 42: page(50, [renamed]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT + 2000,
    });
    expect(quarantine(db)).toEqual([
      {
        entity: "lines",
        id: LINE_1,
        rev: 50,
        reason: "name: invalid_type",
        seen_at: SEEN_AT + 2000,
      },
    ]);
  });

  it("builds the reason from issue paths and codes, never a value, in at most 200 characters", async () => {
    const { db, executor } = openLocalDb();
    const leaky: ChangeItem = {
      entity: "org_profile",
      id: "1",
      rev: 41,
      deleted: false,
      data: {
        name: 7,
        inn: "7701234567",
        gln: "4600682000013",
        gs1Prefixes: Array.from({ length: 30 }, () => 4607091),
        timeZone: "Europe/Moscow",
      },
    };
    const empty: ChangeItem = { entity: "lines", id: LINE_1, rev: 42, deleted: false };
    await syncReferences({
      changes: feed({ 0: page(42, [leaky, empty]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    const [lineEntry, orgEntry] = quarantine(db);
    expect(lineEntry).toMatchObject({ entity: "lines", reason: "data: invalid_type" });
    const reason = String(orgEntry?.reason);
    expect(reason).toHaveLength(200);
    expect(reason).toMatch(/^name: invalid_type; gs1Prefixes\.0: invalid_type; gs1Prefixes\.1: /);
    for (const value of ["7701234567", "4600682000013", "4607091", "Europe/Moscow"]) {
      expect(reason).not.toContain(value);
    }
  });

  it("clears the quarantine whenever the copies start from zero", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(42, [brokenLine(LINE_1, 42)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    // Written by the build before this one: the same entities, records of
    // the first version. A build that reads the record syncs from zero.
    db.prepare(
      "UPDATE sync_state SET value = 'org_profile,site,lines' WHERE key = 'entity_set'",
    ).run();
    const again = feed({ 0: page(43, [line(LINE_1, 43, "Линия 1")]) });
    await expect(
      syncReferences({ changes: again, local: executor, hostId: HOST_ID }),
    ).resolves.toEqual({ kind: "synced", rev: 43, quarantined: 0 });
    expect(again).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 43 }]);
    expect(quarantine(db)).toEqual([]);

    // Paired with another host now, out of reach: the immediate wipe clears
    // the quarantine with the copies.
    await syncReferences({
      changes: feed({ 43: page(44, [brokenLine(LINE_2, 44)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(1);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: OTHER_HOST }),
    ).rejects.toThrow("host unreachable");
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps a quarantine entry through a rollback until the first new page lands, not merely the rollback itself", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [brokenLine(LINE_1, 20)]) }),
      local: executor,
      hostId: HOST_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(1);

    // The host went back (rev < since), but the refetch from zero — the
    // request that would carry the deferred wipe — never lands.
    const failingRefetch = vi.fn(async (since: number) => {
      if (since === 20) return page(12, []);
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: failingRefetch, local: executor, hostId: HOST_ID }),
    ).rejects.toThrow("host unreachable");
    // Deferred: the entry survives, since the wipe waits for the first new
    // page to actually land.
    expect(quarantine(db)).toHaveLength(1);

    // The refetch succeeds this time: the deferred wipe finally runs, and
    // the quarantine goes with the rest of the copies.
    const changes = feed({
      20: page(12, []),
      0: page(12, [line(LINE_1, 12, "Линия 1 (из копии)")]),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "synced",
      rev: 12,
      quarantined: 0,
    });
    expect(quarantine(db)).toEqual([]);
  });

  it("fits the worst-case page in one batch, within the shell's 32 statements", async () => {
    const { db, executor } = openLocalDb();
    const recorded = counting(executor);
    // A first sync (its first page carries the deferred wipe), and every
    // kept entity with a tombstone, a readable and an unreadable record.
    const items: ChangeItem[] = [
      { entity: "org_profile", id: "0", rev: 40, deleted: true },
      ORG,
      { ...ORG, id: "2", data: { name: "ООО «Атолл»" } },
      { entity: "site", id: "0", rev: 40, deleted: true },
      SITE,
      { ...SITE, id: "2", data: { badgeSalt: "short" } },
      tombstone(LINE_2, 40),
      line(LINE_1, 42, "Линия 1"),
      brokenLine("9b2e4a6c-0000-4000-8000-000000000000", 42),
    ];
    await expect(
      syncReferences({
        changes: feed({ 0: page(42, items) }),
        local: recorded.executor,
        hostId: HOST_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 3 });
    // The `host_id` stamp, then the page: the guard, the wipe (3 copy
    // tables, the quarantine, the sync state), per entity one delete and one
    // upsert, the quarantine upsert, the quarantine lift and the sync state:
    // 3 × 3 + 6 = 15. Each new entity adds 3 (a wipe, a delete, an upsert),
    // so plan 1d3's operators and badges make it 21, within the shell's 32.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([1, 15]);
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
