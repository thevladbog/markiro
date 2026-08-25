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
const SNAPSHOT_C = "77777777-7777-4777-8777-777777777777";
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

const alternateRow = {
  ...rows[0],
  codeHash: "629f45be66be2b61b0343375808c0ff52c5afae069dbfa071fa5c6b69f3c058d",
  canonicalRaw: "010460000000001521SERIAL-D",
  serial: "SERIAL-D",
} as const;

function legacyManifest(value: InventoryBundleManifest): Record<string, unknown> {
  const legacy = structuredClone(value) as Record<string, unknown>;
  delete legacy.snapshotFixedAt;
  delete legacy.contentDigest;
  return legacy;
}

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
    ssccRevokedBlocks: [],
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
        allocationOrder: 10,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 2000,
        consumedThroughSerial: 10,
      },
      ssccRevokedFrom: [] as number[],
      ssccRevokedBlocks: [],
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
      ssccRevokedBlocks: [{ allocationOrder: 3, fromSerial: 3000, toSerial: 3999 }],
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
      ssccRevokedBlocks: [{ allocationOrder: 3 }],
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM inventory_snapshot_codes_mirror").get(),
    ).toEqual({ count: 3 });
  });

  it("recomputes legacy active rows and restages instead of trusting an incoming proof", async () => {
    const first = await beginInventoryMirror(exec, manifest());
    await ingestInventoryPage(exec, first, null, page(SNAPSHOT_A, DIGEST_A, rows, null));
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    db.prepare(
      `UPDATE inventory_snapshot_codes_mirror
          SET code_hash = ?, canonical_raw = ?, serial = ?
        WHERE snapshot_id = ? AND code_hash = ?`,
    ).run(
      alternateRow.codeHash,
      alternateRow.canonicalRaw,
      alternateRow.serial,
      SNAPSHOT_A,
      rows[0].codeHash,
    );
    db.prepare(
      `UPDATE inventory_task_mirror
          SET active_snapshot_fixed_at = NULL,
              active_content_digest = NULL,
              active_manifest_json = ?
        WHERE inventory_id = ?`,
    ).run(JSON.stringify(legacyManifest(manifest())), INVENTORY_ID);

    const recovered = await beginInventoryMirror(exec, manifest());
    expect(recovered.alreadyActive).toBe(false);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: null,
      stagedSnapshotId: SNAPSHOT_A,
      nextCursor: null,
      stagedCodeCount: 0,
    });
  });

  it("upgrades a legacy active proof only after its durable rows match the server", async () => {
    const expected = manifest();
    const first = await beginInventoryMirror(exec, expected);
    await ingestInventoryPage(exec, first, null, page(SNAPSHOT_A, DIGEST_A, rows, null));
    expect(await publishInventorySnapshot(exec, first)).toBe(true);
    db.prepare(
      `UPDATE inventory_task_mirror
          SET active_snapshot_fixed_at = NULL,
              active_content_digest = NULL,
              active_manifest_json = ?
        WHERE inventory_id = ?`,
    ).run(JSON.stringify(legacyManifest(expected)), INVENTORY_ID);

    const recovered = await beginInventoryMirror(exec, expected);
    expect(recovered.alreadyActive).toBe(true);
    const stored = db
      .prepare(
        `SELECT active_snapshot_fixed_at, active_content_digest, active_manifest_json
           FROM inventory_task_mirror WHERE inventory_id = ?`,
      )
      .get(INVENTORY_ID) as {
      active_snapshot_fixed_at: string;
      active_content_digest: string;
      active_manifest_json: string;
    };
    expect(stored).toMatchObject({
      active_snapshot_fixed_at: expected.snapshotFixedAt,
      active_content_digest: expected.contentDigest,
    });
    expect(JSON.parse(stored.active_manifest_json)).toMatchObject({
      snapshotFixedAt: expected.snapshotFixedAt,
      contentDigest: expected.contentDigest,
    });
  });

  it("resets a same-snapshot legacy partial stage and removes its inactive rows", async () => {
    const expected = manifest();
    db.prepare(
      `INSERT INTO inventory_task_mirror (
         inventory_id, inventory_number, staged_snapshot_id, staged_snapshot_revision,
         staged_combined_digest, staged_code_count, staged_manifest_json,
         staged_next_cursor, staging_generation
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 4)`,
    ).run(
      INVENTORY_ID,
      expected.inventoryNumber,
      SNAPSHOT_A,
      DIGEST_A,
      expected.codeCount,
      JSON.stringify(legacyManifest(expected)),
      rows[0].codeHash,
    );
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror (
         snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
         source_production_date, parent_sscc, expected, protected
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SNAPSHOT_A,
      rows[0].codeHash,
      rows[0].canonicalRaw,
      rows[0].gtin14,
      rows[0].serial,
      rows[0].sourceStatus,
      rows[0].sourceState,
      rows[0].sourceProductionDate,
      rows[0].parentSscc,
      1,
      0,
    );

    const recovered = await beginInventoryMirror(exec, expected);
    expect(recovered.alreadyActive).toBe(false);
    expect(recovered.generation).toBeGreaterThan(4);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: null,
      stagedSnapshotId: SNAPSHOT_A,
      nextCursor: null,
      stagedCodeCount: 0,
    });
  });

  it("replaces a legacy partial stage with a newer snapshot without touching active rows", async () => {
    const active = await beginInventoryMirror(exec, manifest());
    await ingestInventoryPage(exec, active, null, page(SNAPSHOT_A, DIGEST_A, rows, null));
    expect(await publishInventorySnapshot(exec, active)).toBe(true);

    const legacy = { ...manifest(), snapshotId: SNAPSHOT_C };
    db.prepare(
      `UPDATE inventory_task_mirror
          SET staged_snapshot_id = ?, staged_snapshot_revision = 1,
              staged_snapshot_fixed_at = NULL, staged_combined_digest = ?,
              staged_content_digest = NULL, staged_code_count = ?, staged_manifest_json = ?,
              staged_next_cursor = ?, staging_generation = staging_generation + 1
        WHERE inventory_id = ?`,
    ).run(
      SNAPSHOT_C,
      DIGEST_A,
      legacy.codeCount,
      JSON.stringify(legacyManifest(legacy)),
      rows[0].codeHash,
      INVENTORY_ID,
    );
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror (
         snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
         source_production_date, parent_sscc, expected, protected
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SNAPSHOT_C,
      rows[0].codeHash,
      rows[0].canonicalRaw,
      rows[0].gtin14,
      rows[0].serial,
      rows[0].sourceStatus,
      rows[0].sourceState,
      rows[0].sourceProductionDate,
      rows[0].parentSscc,
      1,
      0,
    );

    const next = await beginInventoryMirror(exec, manifest(SNAPSHOT_B, DIGEST_B));
    expect(next.alreadyActive).toBe(false);
    expect(await readInventoryMirrorState(exec, INVENTORY_ID)).toMatchObject({
      activeSnapshotId: SNAPSHOT_A,
      stagedSnapshotId: SNAPSHOT_B,
      stagedCodeCount: 0,
    });
    expect(
      db
        .prepare(
          "SELECT snapshot_id, COUNT(*) AS count FROM inventory_snapshot_codes_mirror GROUP BY snapshot_id ORDER BY snapshot_id",
        )
        .all(),
    ).toEqual([{ snapshot_id: SNAPSHOT_A, count: 3 }]);
  });

  it("recovers final verification markers from an exact one-page replay after a crash", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    const finalPage = page(SNAPSHOT_A, DIGEST_A, rows, null);
    await ingestInventoryPage(exec, candidate, null, finalPage);
    db.prepare(
      `UPDATE inventory_task_mirror
          SET staged_verified_digest = NULL, staged_verified_content_digest = NULL
        WHERE inventory_id = ?`,
    ).run(INVENTORY_ID);

    await expect(ingestInventoryPage(exec, candidate, null, finalPage)).resolves.toBeUndefined();
    await expect(publishInventorySnapshot(exec, candidate)).resolves.toBe(true);
  });

  it("recovers final verification markers from a multi-page final replay after a crash", async () => {
    const candidate = await beginInventoryMirror(exec, manifest());
    const firstPage = page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), rows[1].codeHash);
    const finalPage = page(SNAPSHOT_A, DIGEST_A, rows.slice(2), null, rows[1].codeHash);
    await ingestInventoryPage(exec, candidate, null, firstPage);
    await ingestInventoryPage(exec, candidate, rows[1].codeHash, finalPage);
    db.prepare(
      `UPDATE inventory_task_mirror
          SET staged_verified_digest = NULL, staged_verified_content_digest = NULL
        WHERE inventory_id = ?`,
    ).run(INVENTORY_ID);

    await expect(
      ingestInventoryPage(exec, candidate, rows[1].codeHash, finalPage),
    ).resolves.toBeUndefined();
    await expect(publishInventorySnapshot(exec, candidate)).resolves.toBe(true);
  });

  it("accepts an explicitly safe lower-numbered SSCC reseed", async () => {
    const initial = {
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
        allocationOrder: 10,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1000,
        toSerial: 1999,
        consumedThroughSerial: 1999,
      },
      ssccRevokedFrom: [] as number[],
      ssccRevokedBlocks: [],
    };
    const first = await beginInventoryMirror(exec, initial);
    await ingestInventoryPage(
      exec,
      first,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows, null, null, initial),
    );
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const reseeded = {
      ...initial,
      sscc: {
        ...initial.sscc,
        allocationOrder: 11,
        fromSerial: 1,
        toSerial: 999,
        consumedThroughSerial: null,
      },
      ssccRevokedFrom: [1000],
      ssccRevokedBlocks: [{ allocationOrder: 10, fromSerial: 1000, toSerial: 1999 }],
    };
    const refreshed = await beginInventoryMirror(exec, reseeded);
    expect(refreshed.alreadyActive).toBe(true);
    const stored = db.prepare("SELECT active_manifest_json FROM inventory_task_mirror").get() as {
      active_manifest_json: string;
    };
    expect(JSON.parse(stored.active_manifest_json)).toMatchObject({
      sscc: { fromSerial: 1, toSerial: 999, consumedThroughSerial: null },
      ssccRevokedFrom: [1000],
      ssccRevokedBlocks: [{ allocationOrder: 10 }],
    });
  });

  it("accepts a newer allocation reusing the same serial range and ignores delayed older state", async () => {
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
        allocationOrder: 20,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1000,
        toSerial: 1999,
        consumedThroughSerial: 1999,
      },
      ssccRevokedFrom: [] as number[],
      ssccRevokedBlocks: [],
    };
    const first = await beginInventoryMirror(exec, base);
    await ingestInventoryPage(
      exec,
      first,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows, null, null, base),
    );
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const replacement = {
      ...base,
      sscc: { ...base.sscc, allocationOrder: 21, consumedThroughSerial: 1010 },
      ssccRevokedBlocks: [{ allocationOrder: 20, fromSerial: 1000, toSerial: 1999 }],
    };
    expect((await beginInventoryMirror(exec, replacement)).alreadyActive).toBe(true);
    expect((await beginInventoryMirror(exec, base)).alreadyActive).toBe(true);

    const stored = db.prepare("SELECT active_manifest_json FROM inventory_task_mirror").get() as {
      active_manifest_json: string;
    };
    expect(JSON.parse(stored.active_manifest_json)).toMatchObject({
      sscc: { allocationOrder: 21, consumedThroughSerial: 1010 },
      ssccRevokedBlocks: [{ allocationOrder: 20 }],
    });
  });

  it("rejects an unproven newer allocation even when it reuses the same serial range", async () => {
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
        allocationOrder: 30,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1000,
        toSerial: 1999,
        consumedThroughSerial: 1010,
      },
      ssccRevokedFrom: [] as number[],
      ssccRevokedBlocks: [],
    };
    const first = await beginInventoryMirror(exec, base);
    await ingestInventoryPage(
      exec,
      first,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows, null, null, base),
    );
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    await expect(
      beginInventoryMirror(exec, {
        ...base,
        sscc: { ...base.sscc, allocationOrder: 31, consumedThroughSerial: null },
      }),
    ).rejects.toThrow("unsafe inventory SSCC transition");
  });

  it("upgrades a pre-allocation-order active manifest from authoritative live facts", async () => {
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
        allocationOrder: 40,
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: 1000,
        toSerial: 1999,
        consumedThroughSerial: 1010,
      },
      ssccRevokedFrom: [] as number[],
      ssccRevokedBlocks: [],
    };
    const first = await beginInventoryMirror(exec, base);
    await ingestInventoryPage(
      exec,
      first,
      null,
      page(SNAPSHOT_A, DIGEST_A, rows, null, null, base),
    );
    expect(await publishInventorySnapshot(exec, first)).toBe(true);

    const stored = db.prepare("SELECT active_manifest_json FROM inventory_task_mirror").get() as {
      active_manifest_json: string;
    };
    const legacy = JSON.parse(stored.active_manifest_json) as Record<string, unknown>;
    const legacySscc = legacy.sscc as Record<string, unknown>;
    delete legacySscc.allocationOrder;
    delete legacy.ssccRevokedBlocks;
    db.prepare("UPDATE inventory_task_mirror SET active_manifest_json = ?").run(
      JSON.stringify(legacy),
    );

    const refreshed = await beginInventoryMirror(exec, {
      ...base,
      sscc: { ...base.sscc, consumedThroughSerial: null },
      ssccRevokedBlocks: [{ allocationOrder: 39, fromSerial: 1000, toSerial: 1999 }],
    });
    expect(refreshed.alreadyActive).toBe(true);
    const upgraded = db.prepare("SELECT active_manifest_json FROM inventory_task_mirror").get() as {
      active_manifest_json: string;
    };
    expect(JSON.parse(upgraded.active_manifest_json)).toMatchObject({
      sscc: { allocationOrder: 40, consumedThroughSerial: 1010 },
      ssccRevokedBlocks: [{ allocationOrder: 39 }],
    });
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
    const firstFinal = page(SNAPSHOT_A, DIGEST_A, rows.slice(0, 2), null);
    const mixedFinal = page(SNAPSHOT_A, DIGEST_A, [alternateRow], null);
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
