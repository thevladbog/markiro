import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  beginInventoryMirror,
  ingestInventoryPage,
  publishInventorySnapshot,
  readInventoryMirrorState,
  type InventoryBundleManifest,
  type InventoryBundlePage,
} from "../src/lib/inventory-mirror.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_A = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_B = "33333333-3333-4333-8333-333333333333";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

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
  return {
    inventoryId: INVENTORY_ID,
    inventoryNumber: "INV-2026-001",
    snapshotId,
    snapshotRevision: 1,
    combinedDigest,
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
  items: InventoryBundlePage["items"],
  nextCursor: string | null,
): InventoryBundlePage {
  return { snapshotId, snapshotRevision: 1, combinedDigest: digest, items, nextCursor };
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
      page(SNAPSHOT_A, DIGEST_A, rows.slice(2), null),
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
    ).rejects.toThrow("inventory bundle next cursor mismatch");

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
      page(SNAPSHOT_B, DIGEST_B, rows.slice(2), null),
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

    const secondManifest = { ...manifest(SNAPSHOT_B, DIGEST_B), codeCount: 4 };
    const second = await beginInventoryMirror(exec, secondManifest);
    await ingestInventoryPage(exec, second, null, page(SNAPSHOT_B, DIGEST_B, rows, null));
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
    ).toEqual([
      { snapshot_id: SNAPSHOT_A, count: 3 },
      { snapshot_id: SNAPSHOT_B, count: 3 },
    ]);

    const corrected = await beginInventoryMirror(exec, manifest(SNAPSHOT_B, DIGEST_B));
    await ingestInventoryPage(exec, corrected, null, page(SNAPSHOT_B, DIGEST_B, rows, null));
    expect(await publishInventorySnapshot(exec, corrected)).toBe(true);
    expect(
      db.prepare("SELECT DISTINCT snapshot_id FROM inventory_snapshot_codes_mirror").all(),
    ).toEqual([{ snapshot_id: SNAPSHOT_B }]);
  });
});
