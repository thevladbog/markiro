import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  beginFloorWorkRetirement,
  clearRejectedCredentialState,
  createFloorWorkRegistry,
  FloorWorkBarrierTimeoutError,
  readSealedWorkSummary,
  retireFloorWork,
} from "../src/lib/credential-recovery.js";
import {
  applyMigrations,
  readOperatorsMirror,
  replaceOperatorsMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";
import { mirrorShiftBundle } from "../src/lib/shift-bundle.js";
import { createScanQueue } from "../src/lib/scan-queue.js";

async function migratedExec(
  onRun?: (sql: string, params: unknown[]) => void,
): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      onRun?.(sql, params);
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

async function seedRecoveryFixture(exec: SqlExecutor): Promise<void> {
  await exec.run(
    `INSERT INTO operators_mirror
       (operator_id, name, login, role, pin_hash, badge_hash, active)
     VALUES (?,?,?,?,?,?,?)`,
    ["operator-a", "Operator A", "101", "operator", "pin-a", null, 1],
  );
  await exec.run(
    `INSERT INTO operators_mirror_b
       (operator_id, name, login, role, pin_hash, badge_hash, active)
     VALUES (?,?,?,?,?,?,?)`,
    ["operator-b", "Operator B", "102", "operator", "pin-b", null, 1],
  );
  await exec.run(
    `INSERT INTO product_mirror
       (id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
        default_counterparty_id, default_label_template_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ["product-1", "04600000000017", "Product", null, 10, null, "active", null, null],
  );
  await exec.run(
    `INSERT INTO shift_mirror
       (id, status, mode, product_id, product_name, pallets_enabled)
     VALUES (?,?,?,?,?,?)`,
    ["shift-1", "active", "aggregation", "product-1", "Product", 0],
  );
  await exec.run(
    `INSERT INTO codes_mirror
       (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
     VALUES (?,?,?,?,?,?)`,
    ["hash-1", "shift-1", "04600000000017", "SERIAL-1", "2026-08-06T08:00:00.000Z", "box-1"],
  );
  await exec.run(
    `INSERT INTO scan_events_mirror
       (shift_id, terminal_id, raw, verdict, scanned_at, operator_id)
     VALUES (?,?,?,?,?,?)`,
    ["shift-1", "device-1", "RAW-1", "ok", "2026-08-06T08:00:00.000Z", "operator-a"],
  );
  await exec.run(
    `INSERT INTO outbox
       (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial, box_id,
        operator_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      "shift-1",
      "device-1",
      "RAW-1",
      "ok",
      "2026-08-06T08:00:00.000Z",
      "hash-1",
      "04600000000017",
      "SERIAL-1",
      "box-1",
      "operator-a",
    ],
  );
  await exec.run(
    `INSERT INTO boxes_mirror
       (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by,
        print_verified_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      "box-1",
      "shift-1",
      "device-1",
      "046012345678901234",
      "2026-08-06T07:00:00.000Z",
      "2026-08-06T08:10:00.000Z",
      "operator-a",
      "2026-08-06T08:11:00.000Z",
    ],
  );
  await exec.run(
    `INSERT INTO boxes_mirror
       (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by, acked_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      "box-acked",
      "shift-1",
      "device-1",
      "046012345678901235",
      "2026-08-06T06:00:00.000Z",
      "2026-08-06T06:10:00.000Z",
      "operator-a",
      "2026-08-06T06:11:00.000Z",
    ],
  );
  await exec.run(
    `INSERT INTO box_exceptions_mirror
       (kind, box_id, code_hash, target_scanned_at, shift_id, terminal_id, operator_id, reason, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      "reprint",
      "box-1",
      null,
      null,
      "shift-1",
      "device-1",
      "operator-a",
      "damaged",
      "2026-08-06T08:12:00.000Z",
    ],
  );
  await exec.run(
    `INSERT INTO conflicts_mirror
       (code_hash, winning_terminal_id, winning_scanned_at, detected_at)
     VALUES (?,?,?,?)`,
    ["hash-conflict", "device-9", "2026-08-06T07:59:00.000Z", "2026-08-06T08:13:00.000Z"],
  );
  await exec.run(
    `INSERT INTO sscc_pool
       (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
     VALUES (?,?,?,?,?)`,
    ["046012345", 0, 100, 199, 117],
  );
  for (const [key, value] of [
    ["operators_slot", "a"],
    ["install_id", "install-1"],
    ["sync_pending_ceiling", "1"],
    ["sync_pending_box_ceiling", "1"],
    ["sync_pending_exception_ceiling", "1"],
    ["sync_pending_batch_id", "machine-1:install-1:1"],
    ["hardware_config", '{"scanner":null}'],
  ]) {
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [key, value]);
  }
}

async function snapshot(exec: SqlExecutor, table: string, orderBy: string): Promise<string> {
  return JSON.stringify(
    await exec.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${orderBy}`),
  );
}

describe("credential rejection recovery", () => {
  it("reports exact unsynchronized scan, box, and exception counts", async () => {
    const base = await migratedExec();
    await seedRecoveryFixture(base);
    let snapshotQueries = 0;
    let insertedAtSnapshot = false;
    const exec: SqlExecutor = {
      run: base.run,
      async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        snapshotQueries += 1;
        if (!insertedAtSnapshot) {
          insertedAtSnapshot = true;
          await base.run(
            `INSERT INTO outbox
               (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              "shift-1",
              "device-1",
              "RAW-AROUND-REJECTION",
              "ok",
              "2026-08-06T08:00:01.000Z",
              "hash-2",
              "04600000000017",
              "SERIAL-2",
            ],
          );
        }
        return base.all<T>(sql, params);
      },
    };

    await expect(readSealedWorkSummary(exec)).resolves.toEqual({
      scans: 2,
      boxes: 1,
      exceptions: 1,
      total: 4,
    });
    expect(snapshotQueries).toBe(1);
  });

  it("waits for an accepted floor scan to finish journalling before taking the summary snapshot", async () => {
    const exec = await migratedExec();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const queue = createScanQueue({
      async process(raw) {
        await writeGate;
        await exec.run(
          `INSERT INTO outbox
             (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            "shift-1",
            "device-1",
            raw,
            "ok",
            "2026-08-06T08:00:00Z",
            "hash",
            "04600000000017",
            "SERIAL",
          ],
        );
        return { raw, verdict: { status: "ok", key: "hash" }, firstSeen: null };
      },
      onOutcome: () => {},
    });
    queue.enqueue("ACCEPTED-BEFORE-UNMOUNT");
    const summary = readSealedWorkSummary(exec, [queue], 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseWrite();

    await expect(summary).resolves.toEqual({ scans: 1, boxes: 0, exceptions: 0, total: 1 });
  });

  it("fails safely instead of hanging forever when a floor work barrier never settles", async () => {
    const exec = await migratedExec();
    const neverIdle = { idle: () => new Promise<void>(() => {}) };

    await expect(readSealedWorkSummary(exec, [neverIdle], 5)).rejects.toThrow(
      "floor work barrier timed out",
    );
  });

  it("closes intake before waiting for accepted floor work", async () => {
    const order: string[] = [];
    const barrier = {
      close: vi.fn(async () => {
        order.push("close");
      }),
      idle: vi.fn(async () => {
        order.push("idle");
      }),
    };

    await retireFloorWork([barrier]);

    expect(order[0]).toBe("close");
  });

  it("rejects a bounded retirement timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = retireFloorWork(
        [{ close: () => new Promise<void>(() => {}), idle: async () => {} }],
        50,
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(FloorWorkBarrierTimeoutError);

      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses one close promise when a timed-out retirement is retried", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const close = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const retirement = beginFloorWorkRetirement([{ close, idle: async () => {} }]);

      const firstWait = retirement.wait(50);
      const firstAssertion = expect(firstWait).rejects.toBeInstanceOf(FloorWorkBarrierTimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await firstAssertion;

      const retry = retirement.wait(50);
      expect(close).toHaveBeenCalledTimes(1);
      release();
      await retry;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes a synchronous non-Error barrier failure", async () => {
    const pending = retireFloorWork([
      {
        close: () => {
          throw "close failed";
        },
        idle: async () => {},
      },
    ]);

    await expect(pending).rejects.toEqual(new Error("close failed"));
  });

  it("keeps a StrictMode replacement registration when the simulated cleanup settles late", () => {
    const registry = createFloorWorkRegistry();
    const barrier = { idle: async () => {} };
    const unregisterFirstSetup = registry.register(barrier);
    const unregisterReplacementSetup = registry.register(barrier);

    unregisterFirstSetup();
    expect([...registry.current()]).toEqual([barrier]);
    unregisterReplacementSetup();
    expect([...registry.current()]).toEqual([]);
  });

  it("clears only explicit reproducible caches after the durable credential boundary", async () => {
    const deletes: { sql: string; params: unknown[] }[] = [];
    let credentialCleared = false;
    const exec = await migratedExec((sql, params) => {
      if (/^DELETE\s/i.test(sql.trim())) {
        expect(credentialCleared).toBe(true);
        deletes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      }
    });
    await seedRecoveryFixture(exec);

    const preservedTables = [
      ["outbox", "id"],
      ["codes_mirror", "code_hash"],
      ["scan_events_mirror", "id"],
      ["boxes_mirror", "box_id"],
      ["box_exceptions_mirror", "id"],
      ["conflicts_mirror", "code_hash"],
      ["sscc_pool", "issuer_prefix, extension_digit, from_serial"],
    ] as const;
    const before = Object.fromEntries(
      await Promise.all(
        preservedTables.map(async ([table, order]) => [table, await snapshot(exec, table, order)]),
      ),
    );

    await clearRejectedCredentialState({
      exec,
      clearCredential: async () => {
        credentialCleared = true;
      },
    });

    const after = Object.fromEntries(
      await Promise.all(
        preservedTables.map(async ([table, order]) => [table, await snapshot(exec, table, order)]),
      ),
    );
    expect(after).toEqual(before);
    expect(await exec.all("SELECT * FROM operators_mirror")).toEqual([]);
    expect(await exec.all("SELECT * FROM operators_mirror_b")).toEqual([]);
    expect(await exec.all("SELECT * FROM shift_mirror")).toEqual([]);
    expect(await exec.all("SELECT * FROM product_mirror")).toEqual([]);
    expect(deletes).toEqual([
      { sql: "DELETE FROM operators_mirror", params: [] },
      { sql: "DELETE FROM operators_mirror_b", params: [] },
      { sql: "DELETE FROM station_meta WHERE key = ?", params: ["operators_slot"] },
      { sql: "DELETE FROM shift_mirror", params: [] },
      { sql: "DELETE FROM product_mirror", params: [] },
    ]);

    const retainedMeta = await exec.all<{ key: string; value: string }>(
      "SELECT key, value FROM station_meta ORDER BY key",
    );
    expect(retainedMeta).toEqual([
      { key: "hardware_config", value: '{"scanner":null}' },
      { key: "install_id", value: "install-1" },
      { key: "operators_blocked", value: "1" },
      { key: "sync_pending_batch_id", value: "machine-1:install-1:1" },
      { key: "sync_pending_box_ceiling", value: "1" },
      { key: "sync_pending_ceiling", value: "1" },
      { key: "sync_pending_exception_ceiling", value: "1" },
    ]);
  });

  it.each(["slot-a", "slot-b", "selector"])(
    "keeps roster authentication fail-closed when strict %s purge fails",
    async (failure) => {
      const base = await migratedExec();
      await seedRecoveryFixture(base);
      const factsBefore = await snapshot(base, "outbox", "id");
      const exec: SqlExecutor = {
        all: base.all,
        async run(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (
            (failure === "slot-a" && normalized === "DELETE FROM operators_mirror") ||
            (failure === "slot-b" && normalized === "DELETE FROM operators_mirror_b") ||
            (failure === "selector" &&
              normalized === "DELETE FROM station_meta WHERE key = ?" &&
              params[0] === "operators_slot")
          ) {
            throw new Error(`purge failed: ${failure}`);
          }
          await base.run(sql, params);
        },
      };

      await expect(
        clearRejectedCredentialState({ exec, clearCredential: async () => {} }),
      ).rejects.toThrow(`purge failed: ${failure}`);

      expect(await readOperatorsMirror(exec)).toEqual([]);
      expect(await snapshot(exec, "outbox", "id")).toBe(factsBefore);
      expect(
        await exec.all("SELECT value FROM station_meta WHERE key = 'operators_blocked'"),
      ).toEqual([{ value: "1" }]);
    },
  );

  it("does not touch any cache when durable credential clearing fails", async () => {
    const exec = await migratedExec();
    await seedRecoveryFixture(exec);
    const run = vi.spyOn(exec, "run");

    await expect(
      clearRejectedCredentialState({
        exec,
        clearCredential: async () => {
          throw new Error("shell unavailable");
        },
      }),
    ).rejects.toThrow("shell unavailable");

    expect(run).not.toHaveBeenCalled();
    expect(await exec.all("SELECT * FROM operators_mirror")).toHaveLength(1);
    expect(await exec.all("SELECT * FROM shift_mirror")).toHaveLength(1);
  });

  it("publishes an empty roster after an already in-flight roster refresh finishes", async () => {
    const base = await migratedExec();
    let releaseInsert!: () => void;
    const insertBlocked = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let announceBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      announceBlocked = resolve;
    });
    const exec: SqlExecutor = {
      all: base.all,
      async run(sql, params = []) {
        if (/INSERT INTO operators_mirror_b\b/.test(sql) && params[0] === "late-operator") {
          announceBlocked();
          await insertBlocked;
        }
        await base.run(sql, params);
      },
    };
    const lateRefresh = replaceOperatorsMirror(exec, [
      {
        operatorId: "late-operator",
        name: "Late Operator",
        login: "103",
        role: "operator",
        pinHash: "late-pin",
        badgeHash: null,
        active: true,
      },
    ]);
    await blocked;

    const clearing = clearRejectedCredentialState({
      exec,
      clearCredential: async () => {},
    });
    // Let an uncoordinated clear run its direct DELETEs while the older
    // refresh is still parked immediately before its INSERT.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseInsert();
    await Promise.all([lateRefresh, clearing]);

    expect(await readOperatorsMirror(exec)).toEqual([]);
    expect(await exec.all("SELECT * FROM operators_mirror")).toEqual([]);
    expect(await exec.all("SELECT * FROM operators_mirror_b")).toEqual([]);
  });

  it("waits for an already in-flight reference bundle before deleting reproducible rows", async () => {
    const exec = await migratedExec();
    let resolveBundle!: (bundle: StationBundle) => void;
    const response = new Promise<StationBundle>((resolve) => {
      resolveBundle = resolve;
    });
    const get = vi.fn().mockReturnValue(response);
    const mirroring = mirrorShiftBundle({ get }, exec, "late-shift");
    const clearing = clearRejectedCredentialState({
      exec,
      clearCredential: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveBundle({
      shift: {
        id: "late-shift",
        status: "active",
        mode: "validation",
        productId: "late-product",
        productName: "Late product",
        lineId: null,
        lineName: null,
        counterpartyId: null,
        counterpartyName: null,
        labelTemplateId: null,
        labelTemplateName: null,
        plannedQty: null,
        plannedDate: null,
        boxCapacity: null,
        palletCapacity: null,
        palletsEnabled: false,
        openedAt: null,
      },
      product: {
        id: "late-product",
        gtin14: "04600000000017",
        name: "Late product",
        productGroup: null,
        boxCapacity: null,
        palletCapacity: null,
        status: "active",
        defaultCounterpartyId: null,
        defaultLabelTemplateId: null,
      },
      labelTemplate: null,
      boxLabelTemplate: null,
      counterpartyGln: null,
      operators: [],
      sscc: null,
    });
    await Promise.all([mirroring, clearing]);

    expect(await exec.all("SELECT * FROM shift_mirror")).toEqual([]);
    expect(await exec.all("SELECT * FROM product_mirror")).toEqual([]);
  });
});
