import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  changesResponseSchema,
  labelTemplateRecordSchema,
  type ChangeItem,
  type ChangesResponse,
} from "../src/host/protocol.js";
import { hashPin } from "../src/lib/credentials.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  copiesReady,
  createSyncScheduler,
  ENTITY_SET,
  SyncFeedError,
  syncReferences,
} from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_HOST = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
/** The device id of another pairing: with `OTHER_HOST`, or a later one with `HOST_ID`. */
const OTHER_DEVICE = "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f";
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

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** `changes-people.json`: an operator, a badge, a badge's and an operator's tombstones. */
const PEOPLE = changesResponseSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/changes-people.json", testModuleUrl), "utf8")),
);
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
/** The badge and the operator `PEOPLE` deletes. */
const OLD_PASS = "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19";
const TURNED_OFF = "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21";
const VERA = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
/** The PIN 4821 and the badge «MRK-000742», as the office hashed them (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";

function operator(id: string, rev: number, login: string, data: object = {}): ChangeItem {
  return {
    entity: "operators",
    id,
    rev,
    deleted: false,
    data: { login, name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC, ...data },
  };
}

function badge(id: string, rev: number, operatorId: string, data: object = {}): ChangeItem {
  return {
    entity: "operator_badges",
    id,
    rev,
    deleted: false,
    data: { operatorId, badgePhc: BADGE_PHC, label: null, ...data },
  };
}

/** The operator and badge copies as plain rows. */
function people(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    operators: rows("SELECT id, login, name, role, pin_phc, rev FROM ref_operators ORDER BY id"),
    badges: rows(
      "SELECT id, operator_id, badge_phc, label, rev FROM ref_operator_badges ORDER BY id",
    ),
  };
}

/**
 * `changes-catalog.json`: two templates, the organization's record with its
 * default templates, a category default, two products (the second archived and
 * a draft), and the tombstones of a category default and a template.
 */
const CATALOG = changesResponseSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/changes-catalog.json", testModuleUrl), "utf8"),
  ),
);
const BOX_58 = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const MILK_58 = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
/** The template `CATALOG` deletes. */
const OLD_TEMPLATE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const MILK = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const KEFIR = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
/** A small layout: to the sync a layout is one opaque object. */
const LAYOUT = { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] };

function product(id: string, rev: number, data: object = {}): ChangeItem {
  return {
    entity: "products",
    id,
    rev,
    deleted: false,
    data: {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л",
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: 40,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
      ...data,
    },
  };
}

function template(id: string, rev: number, data: object = {}): ChangeItem {
  return {
    entity: "label_templates",
    id,
    rev,
    deleted: false,
    data: {
      name: "Коробка 58×40",
      purpose: "box",
      enabled: true,
      chzProductGroupCodes: null,
      stock: false,
      spec: LAYOUT,
      ...data,
    },
  };
}

/** A category's default template, keyed `<code>:<purpose>` as the feed keys it. */
function categoryDefault(
  code: number,
  purpose: string,
  rev: number,
  data: object = {},
): ChangeItem {
  return {
    entity: "category_template_defaults",
    id: `${code}:${purpose}`,
    rev,
    deleted: false,
    data: { chzProductGroupCode: code, purpose, templateId: MILK_58, ...data },
  };
}

/** The catalog copies as plain rows; a template's layout is left to its own test. */
function catalog(db: DatabaseSync) {
  const rows = (sql: string) => Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  return {
    products: rows(
      "SELECT id, gtin14, name, print_name, chz_group_code, box_capacity, pallet_box_capacity, " +
        "shelf_life_days, default_box_template_id, default_pallet_template_id, archived, status, " +
        "rev FROM ref_products ORDER BY id",
    ),
    templates: rows(
      "SELECT id, name, purpose, enabled, category_codes, stock, rev FROM ref_templates ORDER BY id",
    ),
    defaults: rows(
      "SELECT id, chz_group_code, purpose, template_id, rev FROM ref_template_defaults ORDER BY id",
    ),
  };
}

/** The organization's three default templates on its copy. */
function orgDefaults(db: DatabaseSync) {
  const sql =
    "SELECT default_box_template_id, default_pallet_template_id, default_duplicate_template_id " +
    "FROM ref_org";
  return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
}

function page(rev: number, items: ChangeItem[], more = false, hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: more, items };
}

/** Every table `clear_copies` empties. */
const COPY_TABLES = [
  "ref_org",
  "ref_site",
  "ref_lines",
  "ref_operators",
  "ref_operator_badges",
  "ref_products",
  "ref_templates",
  "ref_template_defaults",
  "sync_quarantine",
  "sync_state",
];

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

function state(lastRev: number, hostId = HOST_ID, deviceId = DEVICE_ID) {
  return [
    { key: "device_id", value: deviceId },
    { key: "entity_set", value: ENTITY_SET },
    { key: "host_id", value: hostId },
    { key: "last_rev", value: String(lastRev) },
  ];
}

/** The pairing stamp alone, as a wipe for another pairing leaves it: no `last_rev`. */
function stamp(hostId = HOST_ID, deviceId = DEVICE_ID) {
  return [
    { key: "device_id", value: deviceId },
    { key: "host_id", value: hostId },
  ];
}

/** Two synced lines at revisions 10 and 20, from `HOST_ID`. */
async function syncedTwoLines(executor: LocalExecutor): Promise<void> {
  await syncReferences({
    changes: feed({ 0: page(20, [line(LINE_1, 10, "Линия 1"), line(LINE_2, 20, "Линия 2")]) }),
    local: executor,
    hostId: HOST_ID,
    deviceId: DEVICE_ID,
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
    expect(ENTITY_SET).toBe(
      "org_profile,site,lines,operators,operator_badges,products,label_templates," +
        "category_template_defaults;v4",
    );
  });
});

describe("copiesReady", () => {
  it("answers yes only after this pairing's own run applied its last page", async () => {
    const { db, executor } = openLocalDb();
    const pairing = { hostId: HOST_ID, deviceId: DEVICE_ID };
    expect(await copiesReady(executor, pairing)).toBe(false);
    await syncedTwoLines(executor);
    expect(await copiesReady(executor, pairing)).toBe(true);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: OTHER_DEVICE })).toBe(false);
    expect(await copiesReady(executor, { hostId: OTHER_HOST, deviceId: DEVICE_ID })).toBe(false);

    // A build with another entity set has not applied its first page yet.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    expect(await copiesReady(executor, pairing)).toBe(false);
  });

  it("answers no after a wipe for another pairing, which leaves the stamp alone", async () => {
    const { executor } = openLocalDb();
    await syncedTwoLines(executor);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    const next = { hostId: HOST_ID, deviceId: OTHER_DEVICE };
    await expect(syncReferences({ changes: offline, local: executor, ...next })).rejects.toThrow(
      "host unreachable",
    );
    expect(await copiesReady(executor, next)).toBe(false);
  });
});

describe("reference sync", () => {
  it("copies every record of the first full sync", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({
      0: page(42, [line(LINE_2, 40, "Линия 2", true), ORG, SITE, line(LINE_1, 42, "Линия 1")]),
    });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
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
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
    });
    expect(changes.mock.calls).toEqual([[0], [41]]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(tables(db).state).toEqual(state(42));

    // The next sync asks only for what came after.
    const next = feed({ 42: page(43, [line(LINE_1, 43, "Линия 1 (упаковка)")]) });
    await syncReferences({ changes: next, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(next.mock.calls).toEqual([[42]]);
    expect(tables(db).lines).toEqual([
      { id: LINE_1, name: "Линия 1 (упаковка)", archived: 0, rev: 43 },
    ]);
  });

  it("applies the same page again without changing a record", async () => {
    const { db, executor } = openLocalDb();
    const changes = feed({ 0: page(42, [ORG, SITE, line(LINE_1, 42, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    const before = tables(db);
    // As if the revision were lost: the same page arrives again.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    const recorded = counting(executor);
    await syncReferences({
      changes,
      local: recorded.executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(tables(db)).toEqual(before);
    // The guard passed (2: `host_id` and `device_id` still matched and were
    // touched), the three upserts found nothing newer and nothing was
    // quarantined to lift; only the sync state was written.
    expect(recorded.batches).toEqual([[2, 0, 0, 0, 0, 4]]);
  });

  it("deletes by tombstone, but never a record newer than the tombstone", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const changes = feed({ 20: page(30, [tombstone(LINE_1, 25), tombstone(LINE_2, 15)]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
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
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
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
    // A quarantined record, so the assertion below actually proves something
    // survives, not merely that an already-empty table stays empty.
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('site', '1', 5, 'badgeSalt: invalid_format', 1790000000000)",
    ).run();
    const before = tables(db);
    const quarantineBefore = quarantine(db);
    expect(quarantineBefore).toHaveLength(1);
    // The host went back (rev < since), but the refetch from zero — the
    // request that would carry the deferred wipe — never lands.
    const changes = vi.fn(async (since: number) => {
      if (since === 20) return page(12, []);
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
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
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
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
    const run = syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
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
      deviceId: OTHER_DEVICE,
    });
    // Paired with HOST_ID now, and the host is out of reach.
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    // The immediate wipe itself already committed, with no `last_rev`: the
    // copies still read as unsynced, and a stale in-flight run for the old
    // host would still find `host_id` repointed to this one.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: stamp(),
    });

    const changes = feed({ 0: page(5, [line(LINE_1, 5, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
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
      deviceId: DEVICE_ID,
    });
    // A's next sync starts a request that stays in flight until resolved below.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({
      changes: aChanges,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
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
        deviceId: OTHER_DEVICE,
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
      state: state(20, OTHER_HOST, OTHER_DEVICE),
    });
  });

  it("fails the old host's page as soon as the re-pair's own preamble commits, before B's page even lands", async () => {
    const { db, executor } = openLocalDb();
    // Host A is fully synced.
    await syncReferences({
      changes: feed({ 0: page(10, []) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // A's next sync starts a request that stays in flight.
    let resolveA: ((value: ChangesResponse) => void) | undefined;
    const aChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveA = resolve;
        }),
    );
    const runA = syncReferences({
      changes: aChanges,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
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
    const runB = syncReferences({
      changes: bChanges,
      local: executor,
      hostId: OTHER_HOST,
      deviceId: OTHER_DEVICE,
    });
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
      state: stamp(OTHER_HOST, OTHER_DEVICE),
    });

    // B's page lands second.
    resolveB?.(page(20, [line(LINE_2, 20, "Линия B")], false, OTHER_HOST));
    await expect(runB).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия B", archived: 0, rev: 20 }],
      state: state(20, OTHER_HOST, OTHER_DEVICE),
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
    const runOld = syncReferences({
      changes: oldChanges,
      local: held.executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
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
      deviceId: OTHER_DEVICE,
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
      state: state(20, OTHER_HOST, OTHER_DEVICE),
    });
  });

  it("recovers from a state with entity_set and last_rev but no host_id row, instead of looping on changes_mismatch forever", async () => {
    const { db, executor } = openLocalDb();
    // A state today's writers cannot produce (every write sets `host_id`
    // together with `entity_set`/`last_rev`), but a partial restore, a manual
    // edit, or a future writer could: the "no copies without a host_id"
    // invariant broken.
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '99'), ('entity_set', ?)",
    ).run(ENTITY_SET);
    const changes = feed({
      0: page(12, [line(LINE_1, 12, "Линия 1")]),
      // Only reached if a regression drops `stored.hostId === hostId` from
      // the continuing branch: it would treat the seeded (host-id-less)
      // state as already synced and fetch from here instead of zero.
      99: page(100, [line(LINE_1, 100, "Линия 1 (в потоке 99)")]),
    });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
      kind: "synced",
      rev: 12,
      quarantined: 0,
    });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(0);
    expect(tables(db).state).toEqual(state(12));
  });

  it("fails a page committed after clear_copies wiped the local copies mid-flight, instead of resurrecting them", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(10, [line(LINE_1, 10, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
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
    const run = syncReferences({
      changes: held,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(10));

    // `clear_copies` (`device_forget`) deletes every row of every table,
    // `sync_state` included, in one transaction of its own.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();

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

  it("fails a page of the previous pairing with the same host that lands after a forget and a new pairing", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(10, [line(LINE_1, 10, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The old pairing's next sync is still in flight...
    let resolveOld: ((value: ChangesResponse) => void) | undefined;
    const oldChanges = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const runOld = syncReferences({
      changes: oldChanges,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(oldChanges).toHaveBeenCalledWith(10));

    // ...when `device_forget` clears every table, and the device pairs with
    // the same host again under a new device id and syncs in full.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [line(LINE_2, 12, "Линия 2")]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: OTHER_DEVICE,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });

    // The old pairing's page lands last: the same host, so a guard on the
    // host alone would let it write a record and move `last_rev` back.
    resolveOld?.(page(11, [line(LINE_1, 11, "Линия 1 (прежнее подключение)")]));
    const error: unknown = await runOld.then(
      () => {
        throw new Error("expected the previous pairing's page to fail");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalDbError);
    expect(error).toMatchObject({ code: "changes_mismatch" });
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [{ id: LINE_2, name: "Линия 2", archived: 0, rev: 12 }],
      state: state(12, HOST_ID, OTHER_DEVICE),
    });
  });

  it("wipes the copies of an earlier pairing with the same host before anything else", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({
        changes: offline,
        local: executor,
        hostId: HOST_ID,
        deviceId: OTHER_DEVICE,
      }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: stamp(HOST_ID, OTHER_DEVICE),
    });
  });

  it("wipes the copies of another host at once when an older build left no device_id, so the old host's lines stop being usable", async () => {
    const { db, executor } = openLocalDb();
    // The shape an older build left: another host's copies, its `last_rev`,
    // `host_id` and `entity_set`, but no `device_id` row — so the device-id
    // clause of the wipe cannot fire and only the host clause can.
    db.prepare(
      "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Чужая линия', 0, 10)",
    ).run(LINE_1);
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('host_id', ?), ('entity_set', ?)",
    ).run(OTHER_HOST, ENTITY_SET);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    // Wiped before the fetch and stamped for the new pairing, with no
    // `last_rev` and no `entity_set`: nothing of the old host is left to read.
    expect(tables(db)).toEqual({
      org: [],
      site: [],
      lines: [],
      state: stamp(),
    });
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: DEVICE_ID })).toBe(false);
  });

  it("stamps device_id beside a host_id an older build left alone, and starts from zero keeping the copies until a page lands", async () => {
    const { db, executor } = openLocalDb();
    db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Линия 1', 0, 10)").run(
      LINE_1,
    );
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('host_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, ENTITY_SET);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    // The copies stay until a page lands, but nothing ties them to this
    // pairing: without `last_rev` they read as unsynced.
    expect(tables(db).lines).toHaveLength(1);
    expect(tables(db).state).toEqual([
      { key: "device_id", value: DEVICE_ID },
      { key: "entity_set", value: ENTITY_SET },
      { key: "host_id", value: HOST_ID },
    ]);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: DEVICE_ID })).toBe(false);

    const changes = feed({ 0: page(12, [line(LINE_2, 12, "Линия 2")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_2, name: "Линия 2", archived: 0, rev: 12 }]);
    expect(tables(db).state).toEqual(state(12));
  });

  it.each([
    {
      case: "the host alone was repointed",
      sql: "UPDATE sync_state SET value = ? WHERE key = 'host_id'",
      params: [OTHER_HOST],
    },
    {
      case: "the device id alone was repointed",
      sql: "UPDATE sync_state SET value = ? WHERE key = 'device_id'",
      params: [OTHER_DEVICE],
    },
    {
      case: "the device id row is gone",
      sql: "DELETE FROM sync_state WHERE key = 'device_id'",
      params: [],
    },
    {
      case: "the host row is gone",
      sql: "DELETE FROM sync_state WHERE key = 'host_id'",
      params: [],
    },
  ])(
    "fails a late page and rolls the whole batch back when only half the stamp still matches: $case",
    async ({ sql, params }) => {
      const { db, executor } = openLocalDb();
      await syncedTwoLines(executor);
      let resolveLate: ((value: ChangesResponse) => void) | undefined;
      const lateChanges = vi.fn(
        () =>
          new Promise<ChangesResponse>((resolve) => {
            resolveLate = resolve;
          }),
      );
      const run = syncReferences({
        changes: lateChanges,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      });
      await vi.waitFor(() => expect(lateChanges).toHaveBeenCalledWith(20));
      db.prepare(sql).run(...params);
      const before = tables(db);

      // The page would rewrite a copy and move `last_rev` on; the guard sits
      // first in the batch, so nothing of it may stay.
      resolveLate?.(page(30, [line(LINE_1, 30, "Линия 1 (поздняя)"), line(LINE_2, 30, "Линия 2")]));
      const error: unknown = await run.then(
        () => {
          throw new Error("expected the late page to fail");
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LocalDbError);
      expect(error).toMatchObject({ code: "changes_mismatch" });
      expect(tables(db)).toEqual(before);
    },
  );

  it("stamps the pairing and starts from zero when only a matching device_id is left, keeping the copies until a page lands", async () => {
    const { db, executor } = openLocalDb();
    db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, 'Линия 1', 0, 10)").run(
      LINE_1,
    );
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('device_id', ?), ('entity_set', ?)",
    ).run(DEVICE_ID, ENTITY_SET);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toHaveLength(1);
    expect(tables(db).state).toEqual([
      { key: "device_id", value: DEVICE_ID },
      { key: "entity_set", value: ENTITY_SET },
      { key: "host_id", value: HOST_ID },
    ]);
    expect(await copiesReady(executor, { hostId: HOST_ID, deviceId: DEVICE_ID })).toBe(false);
  });

  it("stops at a feed from another host without applying anything, even with a deferred wipe pending", async () => {
    const { db, executor } = openLocalDb();
    await syncedTwoLines(executor);
    // A build with a different entity set arms a deferred wipe for the next page.
    db.prepare("UPDATE sync_state SET value = 'org_profile,lines' WHERE key = 'entity_set'").run();
    // A quarantined record, so the assertion below actually proves the armed
    // wipe never ran, not merely that an already-empty table stays empty.
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('site', '1', 5, 'badgeSalt: invalid_format', 1790000000000)",
    ).run();
    const before = tables(db);
    const quarantineBefore = quarantine(db);
    expect(quarantineBefore).toHaveLength(1);
    const changes = feed({ 0: page(42, [ORG, line(LINE_1, 42, "Линия 1")], false, OTHER_HOST) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
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
      syncReferences({ changes: offline, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow("host unreachable");
    expect(offline).toHaveBeenCalledWith(0);
    expect(tables(db).lines).toHaveLength(2);

    const changes = feed({ 0: page(20, [SITE, line(LINE_1, 10, "Линия 1")]) });
    await syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 10 }]);
    expect(tables(db).site).toHaveLength(1);
    expect(tables(db).state).toEqual(state(20));
  });

  it("skips entities this build does not keep", async () => {
    const { db, executor } = openLocalDb();
    // Shifts would come with plan 2a.
    const shift: ChangeItem = {
      entity: "shifts",
      id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      rev: 42,
      deleted: false,
      data: { number: "0042" },
    };
    const changes = feed({ 0: page(42, [shift, line(LINE_1, 42, "Линия 1")]) });
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
      kind: "synced",
      rev: 42,
      quarantined: 0,
    });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    // Records of another build's entities are not this build's to judge.
    expect(quarantine(db)).toEqual([]);
  });

  it("fails the run when a successful page's own count read fails, instead of reporting quarantined: 0", async () => {
    const { executor } = openLocalDb();
    // The page's own write succeeds; only the trailing count read fails.
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        if (sql.includes("sync_quarantine")) {
          return Promise.reject(new LocalDbError("statement_failed", "disk I/O error"));
        }
        return executor.query(sql, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    };
    const changes = feed({ 0: page(42, [line(LINE_1, 42, "Линия 1")]) });
    const run = syncReferences({ changes, local, hostId: HOST_ID, deviceId: DEVICE_ID });
    await expect(run).rejects.toBeInstanceOf(LocalDbError);
    await expect(run).rejects.toMatchObject({ code: "statement_failed" });
  });
});

describe("sync quarantine", () => {
  it("quarantines a record that fails its schema and applies the rest of the page", async () => {
    const { db, executor } = openLocalDb();
    const broken: ChangeItem = { ...SITE, data: { badgeSalt: "short", boxBlockSize: 2000 } };
    const changes = feed({ 0: page(42, [ORG, broken, line(LINE_1, 42, "Линия 1")]) });
    await expect(
      syncReferences({
        changes,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
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
        reason: "badgeSalt: invalid_format; palletBlockSize: invalid_type",
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
      syncReferences({
        changes,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
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
      deviceId: DEVICE_ID,
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
        deviceId: DEVICE_ID,
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
        deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 0 });
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps one entry per record: a newer unreadable revision replaces it, the same page again does not", async () => {
    const { db, executor } = openLocalDb();
    const first = feed({ 0: page(42, [brokenLine(LINE_1, 42)]) });
    await syncReferences({
      changes: first,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      now: () => SEEN_AT,
    });
    // As if the revision were lost: the same page arrives again, later.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    await syncReferences({
      changes: first,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
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
      deviceId: DEVICE_ID,
      now: () => SEEN_AT,
    });
    // Written by the build before this one: the same entities, records of
    // the first version. A build that reads the record syncs from zero.
    db.prepare(
      "UPDATE sync_state SET value = 'org_profile,site,lines' WHERE key = 'entity_set'",
    ).run();
    const again = feed({ 0: page(43, [line(LINE_1, 43, "Линия 1")]) });
    await expect(
      syncReferences({ changes: again, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
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
      deviceId: DEVICE_ID,
      now: () => SEEN_AT,
    });
    expect(quarantine(db)).toHaveLength(1);
    const offline = vi.fn(async (): Promise<ChangesResponse> => {
      throw new Error("host unreachable");
    });
    await expect(
      syncReferences({
        changes: offline,
        local: executor,
        hostId: OTHER_HOST,
        deviceId: OTHER_DEVICE,
      }),
    ).rejects.toThrow("host unreachable");
    expect(quarantine(db)).toEqual([]);
  });

  it("keeps a quarantine entry through a rollback until the first new page lands, not merely the rollback itself", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [brokenLine(LINE_1, 20)]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
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
      syncReferences({
        changes: failingRefetch,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
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
    await expect(
      syncReferences({ changes, local: executor, hostId: HOST_ID, deviceId: DEVICE_ID }),
    ).resolves.toEqual({
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
      { entity: "operators", id: TURNED_OFF, rev: 40, deleted: true },
      operator(ANNA, 42, "0042"),
      operator(VERA, 42, "0099", { pinPhc: "4821" }),
      { entity: "operator_badges", id: OLD_PASS, rev: 40, deleted: true },
      badge(PASS_7, 42, ANNA),
      badge("9b2e4a6c-0000-4000-8000-000000000001", 42, ANNA, {
        badgePhc: PIN_PHC.replace("100000", "200000"),
      }),
      // A product never leaves as a tombstone; its unreadable record takes
      // the delete all the same.
      product(MILK, 42),
      product(KEFIR, 42, { status: "blocked" }),
      { entity: "label_templates", id: OLD_TEMPLATE, rev: 40, deleted: true },
      template(BOX_58, 42),
      template(MILK_58, 42, { spec: [] }),
      { entity: "category_template_defaults", id: "15:pallet", rev: 40, deleted: true },
      categoryDefault(8, "box", 42),
      categoryDefault(8, "pallet", 42, { templateId: "7" }),
    ];
    await expect(
      syncReferences({
        changes: feed({ 0: page(42, items) }),
        local: recorded.executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 42, quarantined: 8 });
    // The pairing stamp (and the drop of a `last_rev` there is none of),
    // then the page: the guard, the wipe (8 copy tables, the quarantine, the
    // sync state), per entity one delete and one upsert, the quarantine
    // upsert, the quarantine lift and the sync state: 3 × 8 + 6 = 30, within
    // the shell's 32. A ninth entity would make it 33.
    expect(recorded.batches.map((batch) => batch.length)).toEqual([2, 30]);
    expect(tables(db).lines).toEqual([{ id: LINE_1, name: "Линия 1", archived: 0, rev: 42 }]);
  });
});

describe("operator and badge copies", () => {
  it("keeps the people fixture's operator and badge and applies its tombstones", async () => {
    const { db, executor } = openLocalDb();
    // Synced before the fixture's page: the operator it deletes, the badge it
    // revokes.
    await syncReferences({
      changes: feed({ 0: page(54, [operator(TURNED_OFF, 50, "0043"), badge(OLD_PASS, 52, ANNA)]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(people(db).operators).toHaveLength(1);
    expect(people(db).badges).toHaveLength(1);
    await expect(
      syncReferences({
        changes: feed({ 54: PEOPLE }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 57, quarantined: 0 });
    expect(people(db)).toEqual({
      operators: [
        {
          id: ANNA,
          login: "0042",
          name: "Анна Кузнецова",
          role: "Упаковщик",
          pin_phc: PIN_PHC,
          rev: 55,
        },
      ],
      badges: [{ id: PASS_7, operator_id: ANNA, badge_phc: BADGE_PHC, label: null, rev: 56 }],
    });
    expect(tables(db).state).toEqual(state(57));
  });

  it("replaces an operator's PIN hash, name and role for a newer revision and keeps them against an older one", async () => {
    const { db, executor } = openLocalDb();
    const newPinPhc = await hashPin("5930");
    await syncReferences({
      changes: feed({ 0: page(10, [operator(ANNA, 10, "0042", { role: "Упаковщик" })]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The office changes the PIN, renames the operator and clears the role: a
    // record with a newer revision, not a tombstone. The old PIN stops working.
    await expect(
      syncReferences({
        changes: feed({
          10: page(20, [
            operator(ANNA, 20, "0042", { name: "Анна Петрова", role: null, pinPhc: newPinPhc }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    const updated = {
      id: ANNA,
      login: "0042",
      name: "Анна Петрова",
      role: null,
      pin_phc: newPinPhc,
      rev: 20,
    };
    expect(people(db).operators).toEqual([updated]);
    // The feed never sends an older revision after a newer one, but a stale
    // run of a forgotten pairing can, once the new pairing has accepted the
    // newer one instead of quarantining it: the old hash must not come back.
    await expect(
      syncReferences({
        changes: feed({ 20: page(30, [operator(ANNA, 15, "0042", { role: "Упаковщик" })]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 0 });
    expect(people(db).operators).toEqual([updated]);
  });

  it("replaces a badge's label for a newer revision and keeps it against an older one", async () => {
    // The host never changes a badge record today (a new badge gets a new id),
    // but the update path of its upsert must hold the same rule.
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(10, [badge(PASS_7, 10, ANNA)]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await expect(
      syncReferences({
        changes: feed({ 10: page(20, [badge(PASS_7, 20, ANNA, { label: "Пропуск №7" })]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 20, quarantined: 0 });
    const updated = {
      id: PASS_7,
      operator_id: ANNA,
      badge_phc: BADGE_PHC,
      label: "Пропуск №7",
      rev: 20,
    };
    expect(people(db).badges).toEqual([updated]);
    await expect(
      syncReferences({
        changes: feed({ 20: page(30, [badge(PASS_7, 15, ANNA, { label: "Старая подпись" })]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 0 });
    expect(people(db).badges).toEqual([updated]);
  });

  it("quarantines an operator or a badge this build cannot use, deletes its older copy and applies the rest", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [
          operator(ANNA, 10, "0042"),
          operator(VERA, 11, "0099"),
          badge(PASS_7, 12, ANNA),
          badge(OLD_PASS, 13, VERA),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const changes = feed({
      20: page(30, [
        // A key a newer host added: the record fails closed, not trimmed.
        operator(ANNA, 21, "0042", { shiftId: "7" }),
        // More work than a station may spend on a PIN.
        operator(VERA, 22, "0099", { pinPhc: PIN_PHC.replace("100000", "1000001") }),
        // A count the host never takes for a badge: no scan would match it.
        badge(PASS_7, 23, ANNA, { badgePhc: BADGE_PHC.replace("100000", "0100000") }),
        badge(OLD_PASS, 24, VERA, { label: "Пропуск №9" }),
      ]),
    });
    await expect(
      syncReferences({
        changes,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 3 });
    expect(people(db)).toEqual({
      operators: [],
      badges: [
        { id: OLD_PASS, operator_id: VERA, badge_phc: BADGE_PHC, label: "Пропуск №9", rev: 24 },
      ],
    });
    expect(quarantine(db)).toEqual([
      {
        entity: "operator_badges",
        id: PASS_7,
        rev: 23,
        reason: "badgePhc: custom",
        seen_at: SEEN_AT,
      },
      { entity: "operators", id: VERA, rev: 22, reason: "pinPhc: custom", seen_at: SEEN_AT },
      {
        entity: "operators",
        id: ANNA,
        rev: 21,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("keeps a badge whose operator is not among the copies: no foreign key", async () => {
    // The feed keeps the badge of an operator who was turned off, and a badge
    // can come in a page before its operator.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [badge(PASS_7, 12, ANNA)]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(people(db).operators).toEqual([]);
    expect(people(db).badges).toHaveLength(1);
  });

  it("keeps two badges of one operator with one hash: the copies hold no uniqueness of their own", async () => {
    // An operator may hold several badges, and the host keeps an active hash
    // on one badge. These two belong to one operator and carry one hash, so a
    // unique index on either column would refuse the second row: the whole
    // page would fail, and the sync would never move on.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [badge(PASS_7, 11, ANNA), badge(OLD_PASS, 12, ANNA)]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(people(db).badges).toHaveLength(2);
  });

  it("keeps two operators with one personnel number: the copies hold no uniqueness of their own", async () => {
    // The host keeps personnel numbers unique. A copy that refused a second
    // row would fail its whole page, and the sync would never move on.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(12, [operator(ANNA, 11, "0042"), operator(VERA, 12, "0042")]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(people(db).operators).toHaveLength(2);
  });

  it("keeps an older record out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [operator(ANNA, 20, "0042"), badge(PASS_7, 20, ANNA)]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({
      changes: held,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions: fields
    // this build does not read.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            operator(ANNA, 35, "0042", { shiftId: "7" }),
            badge(PASS_7, 36, ANNA, { zone: "B" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last. Here the new pairing kept the
    // same device id, so `pairingGuard` lets it through (a real re-pair gets
    // a new one, and the guard stops the page): the quarantine's own guard
    // is what keeps the older records out.
    resolve?.(page(30, [operator(ANNA, 25, "0042"), badge(PASS_7, 25, ANNA)]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    expect(people(db)).toEqual({ operators: [], badges: [] });
    expect(quarantine(db)).toEqual([
      {
        entity: "operator_badges",
        id: PASS_7,
        rev: 36,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
      {
        entity: "operators",
        id: ANNA,
        rev: 35,
        reason: "data: unrecognized_keys",
        seen_at: SEEN_AT,
      },
    ]);
  });
});

describe("catalog copies", () => {
  it("keeps the catalog fixture's templates, category default and products with their flags and nulls, and applies its tombstones", async () => {
    const { db, executor } = openLocalDb();
    // Synced before the fixture's page: the template and the category default it deletes.
    await syncReferences({
      changes: feed({
        0: page(60, [
          template(OLD_TEMPLATE, 50),
          categoryDefault(15, "pallet", 51, { templateId: OLD_TEMPLATE }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(catalog(db).templates).toHaveLength(1);
    expect(catalog(db).defaults).toHaveLength(1);
    await expect(
      syncReferences({
        changes: feed({ 60: CATALOG }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 67, quarantined: 0 });
    expect(catalog(db)).toEqual({
      products: [
        {
          id: KEFIR,
          gtin14: "04600682000020",
          name: "Кефир 1% 0,9 л",
          print_name: null,
          chz_group_code: null,
          box_capacity: null,
          pallet_box_capacity: null,
          shelf_life_days: null,
          default_box_template_id: null,
          default_pallet_template_id: null,
          archived: 1,
          status: "draft",
          rev: 66,
        },
        {
          id: MILK,
          gtin14: "04600682000013",
          name: "Молоко 3,2% 0,9 л",
          print_name: "Молоко 3,2%",
          chz_group_code: 8,
          box_capacity: 12,
          pallet_box_capacity: 40,
          shelf_life_days: 10,
          default_box_template_id: MILK_58,
          default_pallet_template_id: null,
          archived: 0,
          status: "active",
          rev: 65,
        },
      ],
      templates: [
        {
          id: BOX_58,
          name: "Коробка 58×40",
          purpose: "box",
          enabled: 1,
          category_codes: null,
          stock: 1,
          rev: 61,
        },
        {
          id: MILK_58,
          name: "Молоко 58×40",
          purpose: "box",
          enabled: 1,
          category_codes: "[8]",
          stock: 0,
          rev: 62,
        },
      ],
      defaults: [{ id: "8:box", chz_group_code: 8, purpose: "box", template_id: MILK_58, rev: 64 }],
    });
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: BOX_58,
        default_pallet_template_id: null,
        default_duplicate_template_id: null,
      },
    ]);
    expect(tables(db).state).toEqual(state(67));
  });

  it("stores a layout as the JSON text JavaScript writes for it: integer-like keys first", async () => {
    const { db, executor } = openLocalDb();
    const spec = { widthMm: 58, "10": "ten", "2": "two", elements: [{ kind: "field" }] };
    await syncReferences({
      changes: feed({ 0: page(67, [...CATALOG.items, template(MILK_58, 68, { spec })]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const rows = Array.from(
      db
        .prepare(
          "SELECT id, spec, json_extract(spec, '$.elements[1].format') AS format FROM ref_templates ORDER BY id",
        )
        .all(),
      (row) => ({ ...row }),
    );
    expect(rows).toEqual([
      {
        id: BOX_58,
        spec: JSON.stringify(labelTemplateRecordSchema.parse(CATALOG.items[0]?.data).spec),
        format: "code128",
      },
      {
        id: MILK_58,
        spec: '{"2":"two","10":"ten","widthMm":58,"elements":[{"kind":"field"}]}',
        format: null,
      },
    ]);
  });

  it("reads an organization record from a host before plan 1e1, without default templates, as none", async () => {
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({ 0: page(41, [ORG]) }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 41, quarantined: 0 });
    expect(tables(db).org).toHaveLength(1);
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: null,
        default_pallet_template_id: null,
        default_duplicate_template_id: null,
      },
    ]);
  });

  it("drops a key a newer host adds to a catalog record and keeps the record: the catalog grants no access", async () => {
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [
            product(MILK, 10, { shelfLifeHours: 240 }),
            template(BOX_58, 11, { printer: "zebra" }),
            categoryDefault(8, "box", 12, { since: "2026-10-04" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    const copies = catalog(db);
    expect([copies.products.length, copies.templates.length, copies.defaults.length]).toEqual([
      1, 1, 1,
    ]);
  });

  it("quarantines a product, a template or a category default this build cannot read, deletes its older copy and applies the rest", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [
          product(MILK, 10),
          product(KEFIR, 11),
          template(BOX_58, 12),
          template(MILK_58, 13),
          categoryDefault(8, "box", 14),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const changes = feed({
      20: page(30, [
        // A GTIN of 13 digits: no scan would find it.
        product(MILK, 21, { gtin14: "4600682000013" }),
        // A purpose a newer host might add.
        template(BOX_58, 22, { purpose: "case" }),
        // A layout that is no object.
        template(MILK_58, 23, { spec: [] }),
        categoryDefault(8, "box", 24, { templateId: "7" }),
        product(KEFIR, 25, { name: "Кефир 2,5% 0,9 л" }),
      ]),
    });
    await expect(
      syncReferences({
        changes,
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 4 });
    expect(catalog(db).products.map((row) => [row.id, row.name, row.rev])).toEqual([
      [KEFIR, "Кефир 2,5% 0,9 л", 25],
    ]);
    expect(catalog(db).templates).toEqual([]);
    expect(catalog(db).defaults).toEqual([]);
    expect(quarantine(db)).toEqual([
      {
        entity: "category_template_defaults",
        id: "8:box",
        rev: 24,
        reason: "templateId: invalid_format",
        seen_at: SEEN_AT,
      },
      {
        entity: "label_templates",
        id: BOX_58,
        rev: 22,
        reason: "purpose: invalid_value",
        seen_at: SEEN_AT,
      },
      { entity: "label_templates", id: MILK_58, rev: 23, reason: "spec: custom", seen_at: SEEN_AT },
      {
        entity: "products",
        id: MILK,
        rev: 21,
        reason: "gtin14: invalid_format",
        seen_at: SEEN_AT,
      },
    ]);
  });

  it("keeps an archived product and a disabled template as the feed sends them: the copies filter nothing", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(12, [
          product(MILK, 11, { archived: true, chzProductGroupCode: null, status: "draft" }),
          template(BOX_58, 12, { enabled: false, stock: true }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const copies = catalog(db);
    expect(copies.products.map((row) => [row.id, row.archived, row.status])).toEqual([
      [MILK, 1, "draft"],
    ]);
    expect(copies.templates.map((row) => [row.id, row.enabled, row.stock])).toEqual([
      [BOX_58, 0, 1],
    ]);
  });

  it("applies the catalog page again without changing a record", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: CATALOG }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const before = catalog(db);
    // As if the revision were lost: the same page arrives again.
    db.prepare("UPDATE sync_state SET value = '0' WHERE key = 'last_rev'").run();
    const recorded = counting(executor);
    await syncReferences({
      changes: feed({ 0: CATALOG }),
      local: recorded.executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(catalog(db)).toEqual(before);
    // The guard, then nothing newer to upsert and nothing older to delete,
    // nothing quarantined to lift; only the sync state is written.
    expect(recorded.batches).toEqual([[2, 0, 0, 0, 0, 0, 0, 0, 4]]);
  });

  it("takes a newer revision of a product, a template and a category default, and keeps each against an older one", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(10, [product(MILK, 10), template(BOX_58, 10), categoryDefault(8, "box", 10)]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await syncReferences({
      changes: feed({
        10: page(20, [
          product(MILK, 20, {
            printName: "Молоко",
            chzProductGroupCode: null,
            archived: true,
            status: "draft",
          }),
          template(BOX_58, 20, { enabled: false, chzProductGroupCodes: [8, 15] }),
          categoryDefault(8, "box", 20, { templateId: BOX_58 }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    const updated = catalog(db);
    expect(
      updated.products.map((row) => [
        row.print_name,
        row.chz_group_code,
        row.archived,
        row.status,
        row.rev,
      ]),
    ).toEqual([["Молоко", null, 1, "draft", 20]]);
    expect(updated.templates.map((row) => [row.enabled, row.category_codes, row.rev])).toEqual([
      [0, "[8,15]", 20],
    ]);
    expect(updated.defaults.map((row) => [row.template_id, row.rev])).toEqual([[BOX_58, 20]]);
    // The feed never sends an older revision after a newer one, but a stale run can.
    await syncReferences({
      changes: feed({
        20: page(30, [product(MILK, 15), template(BOX_58, 15), categoryDefault(8, "box", 15)]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(catalog(db)).toEqual(updated);
  });

  it("keeps a product and a category default that name a template absent from the copies: no foreign key", async () => {
    // A deleted template's tombstone comes before the products its delete
    // cleared, and a template a copy names may wait in the quarantine.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [
            product(MILK, 11, { defaultBoxTemplateId: MILK_58, defaultPalletTemplateId: BOX_58 }),
            categoryDefault(8, "box", 12),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(catalog(db).templates).toEqual([]);
    expect(catalog(db).products).toHaveLength(1);
    expect(catalog(db).defaults).toHaveLength(1);
  });

  it("keeps two products with one GTIN: the copies hold no uniqueness of their own", async () => {
    // An archived product keeps its GTIN without reserving it, so a product
    // in use can carry the same one; a unique index would fail the page.
    const { db, executor } = openLocalDb();
    await expect(
      syncReferences({
        changes: feed({
          0: page(12, [product(KEFIR, 11, { archived: true }), product(MILK, 12)]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 12, quarantined: 0 });
    expect(catalog(db).products.map((row) => row.gtin14)).toEqual([
      "04600682000013",
      "04600682000013",
    ]);
  });

  it("keeps an older product, template or category default out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({
        0: page(20, [product(MILK, 20), template(BOX_58, 20), categoryDefault(8, "box", 20)]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({
      changes: held,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions: values
    // this build does not read.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            product(MILK, 35, { status: "blocked" }),
            template(BOX_58, 36, { purpose: "case" }),
            categoryDefault(8, "box", 37, { purpose: "case" }),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 3 });
    // The forgotten pairing's page lands last. Here the new pairing kept the
    // same device id, so `pairingGuard` lets it through (a real re-pair gets
    // a new one, and the guard stops the page): the quarantine's own guard
    // is what keeps the older records out.
    resolve?.(page(30, [product(MILK, 25), template(BOX_58, 25), categoryDefault(8, "box", 25)]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 3 });
    expect(catalog(db)).toEqual({ products: [], templates: [], defaults: [] });
    expect(quarantine(db).map((entry) => [entry.entity, entry.id, entry.rev])).toEqual([
      ["category_template_defaults", "8:box", 37],
      ["label_templates", BOX_58, 36],
      ["products", MILK, 35],
    ]);
  });

  it("keeps an older organization or line out while its newer revision waits in quarantine, even from a stale run of a forgotten pairing with the same host", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(20, [{ ...ORG, rev: 20 }, line(LINE_1, 20, "Линия 1")]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The next sync's fetch stays in flight across `device_forget`.
    let resolve: ((value: ChangesResponse) => void) | undefined;
    const held = vi.fn(
      () =>
        new Promise<ChangesResponse>((resolveFetch) => {
          resolve = resolveFetch;
        }),
    );
    const stale = syncReferences({
      changes: held,
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledWith(20));
    // `device_forget` clears every table; the device pairs again with the
    // same host, whose first sync quarantines the newer revisions.
    for (const table of COPY_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    await expect(
      syncReferences({
        changes: feed({
          0: page(40, [
            { ...ORG, rev: 35, data: { ...(ORG.data as object), timeZone: 3 } },
            brokenLine(LINE_1, 36),
          ]),
        }),
        local: executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        now: () => SEEN_AT,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 40, quarantined: 2 });
    // The forgotten pairing's page lands last: the quarantine keeps the older
    // organization and line out, as it does for people and the catalog.
    resolve?.(page(30, [{ ...ORG, rev: 25 }, line(LINE_1, 25, "Линия старая")]));
    await expect(stale).resolves.toEqual({ kind: "synced", rev: 30, quarantined: 2 });
    expect(tables(db).org).toEqual([]);
    expect(tables(db).lines).toEqual([]);
  });

  it("applies a revision larger than a page's 1 MiB, a template's tombstone and 5000 products, in one batch", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: feed({ 0: page(60, [template(OLD_TEMPLATE, 60)]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // Deleting a template at revision 70 cleared the preference of 5000
    // products: one revision, which the feed never splits.
    const products = Array.from({ length: 5000 }, (_, n) =>
      product(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, 70, {
        gtin14: String(4_600_682_000_000 + n).padStart(14, "0"),
        name: `Товар ${n}: молоко питьевое ультрапастеризованное 3,2%, 0,9 л`,
      }),
    );
    const items: ChangeItem[] = [
      { entity: "label_templates", id: OLD_TEMPLATE, rev: 70, deleted: true },
      ...products,
    ];
    expect(Buffer.byteLength(JSON.stringify(items), "utf8")).toBeGreaterThan(1024 * 1024);
    const recorded = counting(executor);
    await expect(
      syncReferences({
        changes: feed({ 60: page(70, items) }),
        local: recorded.executor,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
      }),
    ).resolves.toEqual({ kind: "synced", rev: 70, quarantined: 0 });
    // The guard, the products' upsert, the templates' delete, the quarantine
    // lift and the sync state: one batch, one JSON parameter per entity.
    expect(recorded.batches).toEqual([[2, 5000, 1, 0, 4]]);
    expect({ ...db.prepare("SELECT count(*) AS n FROM ref_products").get() }).toEqual({ n: 5000 });
  });

  it("stores a layout of about 256 KB whole", async () => {
    const { db, executor } = openLocalDb();
    const elements = Array.from({ length: 1960 }, (_, n) => ({
      kind: "text",
      id: `line-${n}`,
      xMm: 2,
      yMm: 2 + n,
      text: "Состав: молоко нормализованное",
      fontSizePt: 8,
    }));
    const spec = { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements };
    const text = JSON.stringify(spec);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(250 * 1024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(256 * 1024);
    await syncReferences({
      changes: feed({ 0: page(5, [template(BOX_58, 5, { spec })]) }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect({ ...db.prepare("SELECT spec FROM ref_templates").get() }).toEqual({ spec: text });
  });

  it("stores every field of a product, a template, a category default and the organization's default templates from its own key, and replaces each one for a newer revision", async () => {
    const { db, executor } = openLocalDb();
    const org = (rev: number, box: string, pallet: string, duplicate: string): ChangeItem => ({
      entity: "org_profile",
      id: "1",
      rev,
      deleted: false,
      data: {
        name: "ООО «Атолл»",
        inn: null,
        gln: "4600682000013",
        gs1Prefixes: ["4600682"],
        timeZone: "Europe/Moscow",
        defaultBoxTemplateId: box,
        defaultPalletTemplateId: pallet,
        defaultDuplicateTemplateId: duplicate,
      },
    });
    const layout = (widthMm: number) => ({ ...LAYOUT, widthMm });
    const layouts = () =>
      Array.from(db.prepare("SELECT spec FROM ref_templates").all(), (row) => String(row.spec));
    await syncReferences({
      changes: feed({
        0: page(10, [
          org(10, BOX_58, MILK_58, OLD_TEMPLATE),
          product(MILK, 10, {
            gtin14: "04600682000013",
            name: "Молоко 3,2% 0,9 л",
            printName: "Молоко 3,2%",
            chzProductGroupCode: 8,
            boxCapacity: 12,
            palletBoxCapacity: 40,
            shelfLifeDays: 10,
            defaultBoxTemplateId: BOX_58,
            defaultPalletTemplateId: MILK_58,
            archived: false,
            status: "active",
          }),
          template(BOX_58, 10, {
            name: "Коробка 58×40",
            purpose: "box",
            enabled: true,
            chzProductGroupCodes: [8],
            stock: false,
            spec: layout(58),
          }),
          categoryDefault(8, "box", 10, { templateId: BOX_58 }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: BOX_58,
        default_pallet_template_id: MILK_58,
        default_duplicate_template_id: OLD_TEMPLATE,
      },
    ]);
    expect(catalog(db)).toEqual({
      products: [
        {
          id: MILK,
          gtin14: "04600682000013",
          name: "Молоко 3,2% 0,9 л",
          print_name: "Молоко 3,2%",
          chz_group_code: 8,
          box_capacity: 12,
          pallet_box_capacity: 40,
          shelf_life_days: 10,
          default_box_template_id: BOX_58,
          default_pallet_template_id: MILK_58,
          archived: 0,
          status: "active",
          rev: 10,
        },
      ],
      templates: [
        {
          id: BOX_58,
          name: "Коробка 58×40",
          purpose: "box",
          enabled: 1,
          category_codes: "[8]",
          stock: 0,
          rev: 10,
        },
      ],
      defaults: [{ id: "8:box", chz_group_code: 8, purpose: "box", template_id: BOX_58, rev: 10 }],
    });
    expect(layouts()).toEqual([JSON.stringify(layout(58))]);

    // The next revision changes every field of every record. The purpose and stock
    // changes are synthetic (the host cannot make them: an update has no `purpose`, and
    // only the wizard sets `stock`): this pins only that every column is assigned.
    await syncReferences({
      changes: feed({
        10: page(20, [
          org(20, MILK_58, OLD_TEMPLATE, BOX_58),
          product(MILK, 20, {
            gtin14: "04600682000020",
            name: "Молоко 2,5% 1 л",
            printName: "Молоко 2,5%",
            chzProductGroupCode: 15,
            boxCapacity: 6,
            palletBoxCapacity: 80,
            shelfLifeDays: 20,
            defaultBoxTemplateId: MILK_58,
            defaultPalletTemplateId: BOX_58,
            archived: true,
            status: "draft",
          }),
          template(BOX_58, 20, {
            name: "Паллета 100×150",
            purpose: "pallet",
            enabled: false,
            chzProductGroupCodes: [15, 8],
            stock: true,
            spec: layout(100),
          }),
          categoryDefault(8, "box", 20, { templateId: MILK_58 }),
        ]),
      }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    expect(orgDefaults(db)).toEqual([
      {
        default_box_template_id: MILK_58,
        default_pallet_template_id: OLD_TEMPLATE,
        default_duplicate_template_id: BOX_58,
      },
    ]);
    expect(catalog(db)).toEqual({
      products: [
        {
          id: MILK,
          gtin14: "04600682000020",
          name: "Молоко 2,5% 1 л",
          print_name: "Молоко 2,5%",
          chz_group_code: 15,
          box_capacity: 6,
          pallet_box_capacity: 80,
          shelf_life_days: 20,
          default_box_template_id: MILK_58,
          default_pallet_template_id: BOX_58,
          archived: 1,
          status: "draft",
          rev: 20,
        },
      ],
      templates: [
        {
          id: BOX_58,
          name: "Паллета 100×150",
          purpose: "pallet",
          enabled: 0,
          category_codes: "[15,8]",
          stock: 1,
          rev: 20,
        },
      ],
      defaults: [{ id: "8:box", chz_group_code: 8, purpose: "box", template_id: MILK_58, rev: 20 }],
    });
    expect(layouts()).toEqual([JSON.stringify(layout(100))]);
  });

  it("looks a scanned product up by its GTIN through an index, for plan 2a", () => {
    const { db } = openLocalDb();
    const plan = Array.from(
      db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM ref_products WHERE gtin14 = ?")
        .all("04600682000013"),
      (row) => String(row.detail),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toContain("USING INDEX ref_products_gtin14");
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
