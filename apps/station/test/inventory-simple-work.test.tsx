// @vitest-environment jsdom

import { DatabaseSync } from "node:sqlite";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash, type StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import { applyMigrations } from "../src/lib/mirror.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { InventoryWorkScreen } from "../src/pages/InventoryWorkScreen.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const GTIN = "04600000000015";

const manifest: StationInventoryBundleManifest & { mode: "check" } = {
  inventoryId: INVENTORY_ID,
  inventoryNumber: "ИНВ-42",
  snapshotId: SNAPSHOT_ID,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 4,
  productId: "55555555-5555-4555-8555-555555555555",
  productName: "Пиво светлое 0,45 л",
  gtin14: GTIN,
  boxCapacity: 20,
  mode: "check",
  lineId: "66666666-6666-4666-8666-666666666666",
  lineName: "Упаковка А",
  productionDateFrom: "2026-08-19",
  productionDateTo: "2026-09-19",
  boxLabelTemplate: null,
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

function raw(serial: string): string {
  return `01${GTIN}21${serial}`;
}

function scanner() {
  let listener: ScanListener | null = null;
  const stop = vi.fn();
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
        stop();
      };
    },
  };
  return {
    source,
    emit(scannerRaw: string) {
      act(() => listener?.(scannerRaw));
    },
    stop,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'ИНВ-42', ?)",
  ).run(INVENTORY_ID, SNAPSHOT_ID);
  for (const [serial, sourceStatus, sourceState, expected, protectedFlag] of [
    ["EXPECTED", "INTRODUCED", null, 1, 0],
    ["PROTECTED", "INTRODUCED", "MOVING_BY_UD", 0, 1],
    ["INELIGIBLE", "APPLIED", null, 0, 0],
  ] as const) {
    const km = canonicalizeKm(raw(serial));
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
       (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
        source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-19', NULL, ?, ?)`,
    ).run(
      SNAPSHOT_ID,
      kmHash(km),
      km.raw,
      km.gtin14,
      km.serial,
      sourceStatus,
      sourceState,
      expected,
      protectedFlag,
    );
  }
  return { db, exec };
}

beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

afterEach(cleanup);

describe("simple inventory work screen", () => {
  it("owns the scanner queue and renders durable expected, protected, unknown, ineligible, and duplicate verdicts", async () => {
    const { exec } = await fixture();
    const scan = scanner();
    const onQueueRegister = vi.fn(() => vi.fn());
    const view = render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        onScanQueueRegister={onQueueRegister}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Проверка продукции" })).toBeDefined();
    expect(screen.getByText("ИНВ-42")).toBeDefined();
    expect(screen.getByText("Пиво светлое 0,45 л")).toBeDefined();
    expect(screen.getByText("19.08.2026")).toBeDefined();
    await waitFor(() => expect(onQueueRegister).toHaveBeenCalledOnce());

    scan.emit(raw("EXPECTED"));
    expect(await screen.findByText("Код принят")).toBeDefined();
    scan.emit(raw("PROTECTED"));
    expect(await screen.findByText("Код не учтён: уже в отгрузке")).toBeDefined();
    scan.emit(raw("PHYSICAL-ONLY-SECRET"));
    expect(await screen.findByText("Код отсутствует в исходном снимке")).toBeDefined();
    scan.emit(raw("INELIGIBLE"));
    expect(await screen.findByText("Код не участвует в инвентаризации")).toBeDefined();
    scan.emit(raw("EXPECTED"));
    expect(await screen.findByText("Код уже проверен на этом терминале")).toBeDefined();

    expect(screen.getByText("1", { selector: "[data-testid='inventory-verified']" })).toBeDefined();
    expect(
      screen.getByText("2", { selector: "[data-testid='inventory-discrepancies']" }),
    ).toBeDefined();
    expect(screen.queryByText("PHYSICAL-ONLY-SECRET")).toBeNull();

    view.unmount();
    expect(scan.stop).toHaveBeenCalledOnce();

    const restartedScanner = scanner();
    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={restartedScanner.source}
      />,
    );
    expect(await screen.findByText("Код уже проверен на этом терминале")).toBeDefined();
    expect(screen.queryByText("PHYSICAL-ONLY-SECRET")).toBeNull();
  });

  it("persists a changed date and applies it to the next accepted scan", async () => {
    const { db, exec } = await fixture();
    const scan = scanner();
    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
      />,
    );
    await screen.findByText("19.08.2026");
    fireEvent.click(screen.getByRole("button", { name: "Изменить дату производства" }));
    fireEvent.change(screen.getByLabelText("Дата производства"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить дату" }));
    await screen.findByText("20.08.2026");

    scan.emit(raw("EXPECTED"));
    await waitFor(() =>
      expect(
        db.prepare("SELECT observed_production_date FROM inventory_code_results_mirror").get(),
      ).toEqual({ observed_production_date: "2026-08-20" }),
    );
  });

  it("orders a date change behind already-buffered scans and ahead of later scans", async () => {
    const { db, exec } = await fixture();
    const gate = deferred();
    let held = false;
    const suspended: SqlExecutor = {
      run: (sql, params) => exec.run(sql, params),
      all: async <T,>(sql: string, params?: unknown[]) => {
        if (!held && /FROM inventory_snapshot_codes_mirror/i.test(sql)) {
          held = true;
          await gate.promise;
        }
        return exec.all<T>(sql, params);
      },
    };
    const scan = scanner();
    render(
      <InventoryWorkScreen
        exec={suspended}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
      />,
    );
    await screen.findByText("19.08.2026");
    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(held).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Изменить дату производства" }));
    fireEvent.change(screen.getByLabelText("Дата производства"), {
      target: { value: "2026-08-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить дату" }));
    gate.release();
    await screen.findByText("Код принят");
    await screen.findByText("20.08.2026");
    scan.emit(raw("INELIGIBLE"));
    await screen.findByText("Код не участвует в инвентаризации");

    expect(
      db
        .prepare(
          "SELECT observed_production_date FROM inventory_code_results_mirror ORDER BY winning_scanned_at, code_hash",
        )
        .all(),
    ).toEqual([
      { observed_production_date: "2026-08-19" },
      { observed_production_date: "2026-08-20" },
    ]);
  });
});
