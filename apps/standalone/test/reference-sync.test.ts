import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { ChangeItem, ChangesResponse } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
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
    // The three upserts found nothing newer; only the sync state was written.
    expect(recorded.batches).toEqual([[0, 0, 0, 3]]);
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

  it("gives up when the host goes back twice in one sync", async () => {
    const { executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({
      20: page(12, []),
      0: page(8, [line(LINE_1, 8, "Линия 1")], true),
      8: page(5, []),
    });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /went back twice/,
    );
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
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });

    const changes = feed({ 0: page(5, [line(LINE_1, 5, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 5 }]);
    expect(tables(db).state).toEqual(state(5));
  });

  it("stops at a feed from another host without applying anything", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).resolves.toEqual({
      kind: "other_host",
    });
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });
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

  it("applies nothing of a page with an unreadable record", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [line(LINE_1, 40, "Линия 1"), broken]) });
    await expect(syncReferences({ changes, local: executor, hostId: HOST_ID })).rejects.toThrow(
      /site record 1/,
    );
    expect(tables(db)).toEqual({ org: [], site: [], lines: [], state: [] });
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
});
