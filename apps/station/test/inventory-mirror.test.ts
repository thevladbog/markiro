import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { inventorySnapshotContentDigest, inventorySnapshotPageDigest } from "@markiro/domain";

import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  beginInventoryMirror,
  ingestInventoryPage,
  publishInventorySnapshot,
  readInventoryMirrorState,
  type InventoryBundleCode,
  type InventoryBundleManifest,
  type InventoryBundlePage,
} from "../src/lib/inventory-mirror.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_A = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_B = "33333333-3333-4333-8333-333333333333";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const FIXED_A = "2026-08-25T01:00:00.000Z";
const FIXED_B = "2026-08-25T02:00:00.000Z";

const rows = [
  {
    codeHash: "066e15060b18b753ddffa6a92d9d2ce2366b5fc3c704d6d61c89bb77740b47ff",
    canonicalRaw: "010460000000001521SERIAL-B",
    gtin14: "04600000000015",
    serial: "SERIAL-B",
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: "2026-08-01",
    parentSscc: "004600000000000015",
    expected: true,
    protected: false,
  },
  {
    codeHash: "5e3da0f5df7771d7b3ea00192c6c0f5735b9a6b61778dd94143b38725d12e393",
    canonicalRaw: "010460000000001521SERIAL-C",
    gtin14: "04600000000015",
    serial: "SERIAL-C",
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: "2026-08-02",
    parentSscc: null,
    expected: true,
    protected: false,
  },
  {
    codeHash: "71ecc4669aa5893c25d6d3e42a6b2a4775097ee72ff87cd16165d8a3f7bb88b9",
    canonicalRaw: "010460000000001521SERIAL-A",
    gtin14: "04600000000015",
    serial: "SERIAL-A",
    sourceStatus: "EMITTED" as const,
    sourceState: null,
    sourceProductionDate: null,
    parentSscc: null,
    expected: false,
    protected: false,
  },
] as const;

function manifest(snapshotId = SNAPSHOT_A, combinedDigest = DIGEST_A): InventoryBundleManifest {
  const contentDigest = inventorySnapshotContentDigest(rows);
  return {
    inventoryId: INVENTORY_ID,
    inventoryNumber: "INV-2026-001",
    snapshotId,
    snapshotRevision: 1,
    snapshotFixedAt: snapshotId === SNAPSHOT_A ? FIXED_A : FIXED_B,
    combinedDigest,
    contentDigest,
    codeCount: 3,
    productId: "44444444-4444-4444-8444-444444444444",
    productName: "Сидр",
    gtin14: "04600000000015",
    boxCapacity: 12,
    mode: "check",
    lineId: "55555555-5555-4555-8555-555555555555",
    lineName: "Линия 1",
    productionDateFrom: "2026-08-01",
    productionDateTo: "2026-08-31",
    boxLabelTemplate: null,
    limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
    sscc: null,
    ssccRevokedFrom: [],
  };
}

function page(
  snapshotId: string,
  digest: string,
  items: readonly InventoryBundleCode[],
  nextCursor: string | null,
  cursor: string | null = null,
  manifestValue = manifest(snapshotId, digest),
): InventoryBundlePage {
  const proof = {
    snapshotId,
    snapshotFixedAt: manifestValue.snapshotFixedAt,
    contentDigest: manifestValue.contentDigest,
    cursor,
    items: [...items],
    nextCursor,
  };
  return {
    snapshotId,
    snapshotRevision: 1,
    snapshotFixedAt: manifestValue.snapshotFixedAt,
    combinedDigest: digest,
    contentDigest: manifestValue.contentDigest,
    cursor,
    items: [...items],
    nextCursor,
    pageDigest: inventorySnapshotPageDigest(proof),
  };
}

function makeExecutor(): { db: DatabaseSync; exec: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec: {
      async run(sql, params = []) {
        db.prepare(sql).run(...(params as never[]));
      },
      async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
    },
  };
}

describe("inventory mirror staging", () => {
  let db: DatabaseSync;
  let exec: SqlExecutor;

  beforeEach(async () => {
    ({ db, exec } = makeExecutor());
    await applyMigrations(exec);
  });

  it("resumes after page one without publishing a partial snapshot", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    await ingestInventoryPage(
      exec,
      candidate,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), rows[1].codeHash),
    );

    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: null,
      stagedSnapshotId: SNAPSHOT_A,
      nextCursor: rows[1].codeHash,
      stagedCodeCount: 2,
    });

    const resumed = await beginInventoryMirror(exec, manifest());
    expect(resumed.generation).toBe(candidate.generation);
    await ingestInventoryPage(
      exec,
      resumed,
      rows[1].codeHash,
      page(SNAPSHOT_A, DIGEST_A, rows.slice(2), null, rows[1].codeHash),
    );
    await expect(publishInventorySnapshot(exec, resumed)).resolves.toBe(true);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: SNAPSHOT_A,
      stagedSnapshotId: null,
      stagedCodeCount: 0,
    });
  });

  it("rejects a wrong cursor without advancing staging", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    await expect(
      ingestInventoryPage(
        exec,
        candidate,
        "f".repeat(64),
        page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), rows[1].codeHash),
      ),
    ).rejects.toThrow("inventory bundle cursor mismatch");
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      nextCursor: null,
      stagedCodeCount: 0,
    });
  });

  it("accepts an exact duplicate page idempotently without duplicating rows", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    const firstPage = page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), rows[1].codeHash);
    await ingestInventoryPage(exec, candidate, null, firstPage);
    await expect(ingestInventoryPage(exec, candidate, null, firstPage)).resolves.toBeUndefined();
    await expect(
      ingestInventoryPage(exec, candidate, null, { ...firstPage, nextCursor: null }),
    ).rejects.toThrow("inventory bundle page digest mismatch");

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM inventory_snapshot_codes_mirror").get(),
    ).toEqual({ count: 2 });
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      nextCursor: rows[1].codeHash,
      stagedCodeCount: 2,
    });
  });

  it("rejects a page digest mismatch and a code hash that conflicts with canonical KM identity", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    await expect(
      ingestInventoryPage(
        exec,
        candidate,
        null,
        page(SNAPSHOT_A, DIGEST_B, rows.slice(0, 2), rows[1].codeHash),
      ),
    ).rejects.toThrow("inventory bundle digest mismatch");
    await expect(
      ingestInventoryPage(
        exec,
        candidate,
        null,
        page(SNAPSHOT_A, DIGEST_A, [{ ...rows[0], codeHash: "c".repeat(64) }], null),
      ),
    ).rejects.toThrow("inventory bundle code identity mismatch");
  });

  it("does not let an older in-flight candidate replace a newer snapshot", async () => {
    const older = await beginInventoryMirror(exec, manifest(SNAPSHOT_A, DIGEST_A));
    const newer = await beginInventoryMirror(exec, manifest(SNAPSHOT_B, DIGEST_B));
    expect(newer.generation).toBeGreaterThan(older.generation);

    await expect(
      ingestInventoryPage(
        exec,
        older,
        null,
        page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), rows[1].codeHash),
      ),
    ).rejects.toThrow("inventory bundle staging was superseded");

    await ingestInventoryPage(
      exec,
      newer,
      null,
      page(SNAPSHOT_B, DIGEST_B, rows.slice(0, 2), rows[1].codeHash),
    );
    await ingestInventoryPage(
      exec,
      newer,
      rows[1].codeHash,
      page(SNAPSHOT_B, DIGEST_B, rows.slice(2), null, rows[1].codeHash),
    );
    expect(await publishInventorySnapshot(exec, newer)).toBe(true);
    expect(await publishInventorySnapshot(exec, older)).toBe(false);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: SNAPSHOT_B,
    });
  });

  it("keeps the active revision until verified publication and purges it only afterwards", async () => {
    const first = await beginInventoryMirror(exec, manifest(SNAPSHOT_A, DIGEST_A));
    await ingestInventoryPage(exec, first, null, page(SNAPSHOT_A, DIGEST_A, rows, null));
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const secondManifest = manifest(SNAPSHOT_B, DIGEST_B);
    const second = await beginInventoryMirror(exec, secondManifest);
    await expect(
      ingestInventoryPage(exec, second, null, page(SNAPSHOT_B, DIGEST_B, rows.slice(0, 2), null)),
    ).rejects.toThrow("inventory bundle content digest mismatch");
    expect(await publishInventorySnapshot(exec, second)).toBe(false);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: SNAPSHOT_A,
    });
    expect(
      db
        .prepare(
          "SELECT snapshot_id, COUNT(*) AS count FROM inventory_snapshot_codes_mirror GROUP BY snapshot_id ORDER BY snapshot_id",
        )
        .all(),
    ).toEqual([{ snapshot_id: SNAPSHOT_A, count: 3 }]);

    const corrected = await beginInventoryMirror(exec, manifest(SNAPSHOT_B, DIGEST_B));
    await ingestInventoryPage(exec, corrected, null, page(SNAPSHOT_B, DIGEST_B, rows, null));
    expect(await publishInventorySnapshot(exec, corrected)).toBe(true);
    expect(
      db.prepare("SELECT DISTINCT snapshot_id FROM inventory_snapshot_codes_mirror").all(),
    ).toEqual([{ snapshot_id: SNAPSHOT_B }]);
  });

  it("refreshes active repack SSCC safety facts monotonically without redownloading codes", async () => {
    const base = {
      ...manifest(),
      mode: "repack" as const,
      boxLabelTemplate: {
        id: "66666666-6666-4666-8666-666666666666",
        name: "Короб",
        spec: {
          widthMm: 58,
          heightMm: 40,
          dpi: 203 as const,
          language: "zpl" as const,
          elements: [],
        },
      },
      sscc: {
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 2000,
        consumedThroughSerial: 10,
      },
      ssccRevokedFrom: [] as number[],
    };
    const first = await beginInventoryMirror(exec, base);
    await ingestInventoryPage(
      exec,
      first,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows, null, null, base),
    );
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const advanced = {
      ...base,
      sscc: { ...base.sscc, consumedThroughSerial: 20 },
      ssccRevokedFrom: [3000],
    };
    const refreshed = await beginInventoryMirror(exec, advanced);
    expect(refreshed.alreadyActive).toBe(true);

    const stale = await beginInventoryMirror(exec, base);
    expect(stale.alreadyActive).toBe(true);
    const stored = db.prepare("SELECT active_manifest_json FROM inventory_task_mirror").get() as {
      active_manifest_json: string;
    };
    expect(JSON.parse(stored.active_manifest_json)).toMatchObject({
      sscc: { consumedThroughSerial: 20 },
      ssccRevokedFrom: [3000],
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM inventory_snapshot_codes_mirror").get(),
    ).toEqual({ count: 3 });
  });

  it("fences fetch-response reordering so a late older snapshot cannot roll back active state", async () => {
    const older = manifest(SNAPSHOT_A, DIGEST_A);
    const newer = manifest(SNAPSHOT_B, DIGEST_B);
    const first = await beginInventoryMirror(exec, older);
    await ingestInventoryPage(exec, first, null, page(SNAPSHOT_A, DIGEST_A, rows, null));
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const next = await beginInventoryMirror(exec, newer);
    await ingestInventoryPage(exec, next, null, page(SNAPSHOT_B, DIGEST_B, rows, null));
    expect(await publishInventorySnapshot(exec, next)).toBe(true);

    await expect(beginInventoryMirror(exec, older)).rejects.toThrow(
      "inventory snapshot rollback rejected",
    );
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: SNAPSHOT_B,
    });
  });

  it("serializes disjoint page acceptance at the same cursor with one SQLite statement", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    const left = page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 1), rows[0].codeHash);
    const right = page(SNAPSHOT_A, DIGEST_A, rows.slice(1, 2), rows[1].codeHash);

    const results = await Promise.allSettled([
      ingestInventoryPage(exec, candidate, null, left),
      ingestInventoryPage(exec, candidate, null, right),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = db
      .prepare("SELECT code_hash FROM inventory_snapshot_codes_mirror ORDER BY code_hash")
      .all();
    expect([[{ code_hash: rows[0].codeHash }], [{ code_hash: rows[1].codeHash }]]).toContainEqual(
      stored,
    );
    expect(await publishInventorySnapshot(exec, candidate)).toBe(false);
  });

  it("rejects disjoint concurrent final pages before they can combine at a shared cursor", async () => {
    const expectedManifest = manifest();
    const candidate = await beginInventoryMirror(exec, expectedManifest);
    const alternate = {
      ...rows[0],
      codeHash: "629f45be66be2b61b0343375808c0ff52c5afae069dbfa071fa5c6b69f3c058d",
      canonicalRaw: "010460000000001521SERIAL-D",
      serial: "SERIAL-D",
    };
    const firstFinal = page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), null);
    const mixedFinal = page(SNAPSHOT_A, DIGEST_A, [alternate], null);
    const results = await Promise.allSettled([
      ingestInventoryPage(exec, candidate, null, firstFinal),
      ingestInventoryPage(exec, candidate, null, mixedFinal),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(0);
    expect(await publishInventorySnapshot(exec, candidate)).toBe(false);
    const stored = db
      .prepare("SELECT code_hash FROM inventory_snapshot_codes_mirror ORDER BY code_hash")
      .all();
    expect(stored).toEqual([]);
  });
});
