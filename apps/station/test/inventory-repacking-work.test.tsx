// @vitest-environment jsdom

import { DatabaseSync } from "node:sqlite";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash, type StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import { applyMigrations } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { InventoryWorkScreen } from "../src/pages/InventoryWorkScreen.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const GTIN = "04600000000015";
const OLD_SSCC = "346006820000000014";

const manifest: StationInventoryBundleManifest & { mode: "repack" } = {
  inventoryId: INVENTORY_ID,
  inventoryNumber: "ИНВ-Р-42",
  snapshotId: SNAPSHOT_ID,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 1,
  productId: "55555555-5555-4555-8555-555555555555",
  productName: "Пиво светлое 0,45 л",
  gtin14: GTIN,
  boxCapacity: 20,
  mode: "repack",
  lineId: "66666666-6666-4666-8666-666666666666",
  lineName: "Упаковка А",
  productionDateFrom: "2026-08-19",
  productionDateTo: "2026-09-19",
  boxLabelTemplate: {
    id: "77777777-7777-4777-8777-777777777777",
    name: "Короб",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: {
    allocationOrder: 1,
    issuerPrefix: "460068200",
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 100,
    consumedThroughSerial: null,
  },
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

function scanner() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return { source, emit: (raw: string) => act(() => listener?.(raw)) };
}

beforeAll(async () => i18n.changeLanguage("ru"));
afterEach(cleanup);

describe("repack inventory work screen", () => {
  it("shows twenty fixed positions, reserves the new box once, and scans every bottle", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'ИНВ-Р-42', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    db.prepare(
      `INSERT INTO sscc_pool
         (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
       VALUES ('460068200', 0, 1, 100, 1)`,
    ).run();
    const km = canonicalizeKm(`01${GTIN}21REPACK-ONE`);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, 'INTRODUCED', '2026-08-19', ?, 1, 0)`,
    ).run(SNAPSHOT_ID, kmHash(km), km.raw, GTIN, km.serial, OLD_SSCC);
    const scan = scanner();
    const onScanQueueRegister = vi.fn(() => vi.fn());

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        onScanQueueRegister={onScanQueueRegister}
        createEventId={() => crypto.randomUUID()}
        now={() => "2026-08-25T10:00:01.000Z"}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Переупаковка" })).toBeDefined();
    expect(screen.getAllByTestId("repack-position")).toHaveLength(20);
    expect(screen.getByText("Отсканируйте старый короб")).toBeDefined();
    expect(screen.getByRole("button", { name: "Исправления" })).toBeDefined();
    await waitFor(() => expect(onScanQueueRegister).toHaveBeenCalledOnce());

    scan.emit(OLD_SSCC);
    expect(await screen.findByText("Старый короб выбран")).toBeDefined();
    expect(screen.getByText("Сканируйте каждую бутылку")).toBeDefined();
    expect(screen.getByText(/^0\d{17}$/)).toBeDefined();

    scan.emit(km.raw);
    await waitFor(() => expect(screen.getByTestId("repack-count").textContent).toBe("1 / 20"));
    expect(screen.getAllByTestId("repack-position")[0]?.getAttribute("data-filled")).toBe("true");
    expect(screen.queryByText(km.raw)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 2,
    });
  });
});
