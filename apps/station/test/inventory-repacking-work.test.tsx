// @vitest-environment jsdom

import { DatabaseSync } from "node:sqlite";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash, type StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
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
  productPrintName: "Пиво светлое 0,45 л",
  gtin14: GTIN,
  egaisCode: "200000000001",
  shelfLifeDays: 180,
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
  let starts = 0;
  let stops = 0;
  const source: ScanSource = {
    start(next) {
      starts += 1;
      listener = next;
      return () => {
        stops += 1;
        listener = null;
      };
    },
  };
  return {
    source,
    emit: (raw: string) => act(() => listener?.(raw)),
    active: () => listener !== null,
    starts: () => starts,
    stops: () => stops,
  };
}

beforeAll(async () => i18n.changeLanguage("ru"));
afterEach(cleanup);

describe("repack inventory work screen", () => {
  it("shows twenty fixed positions, reserves the new box once, and scans every bottle", async () => {
    const db = new DatabaseSync(":memory:");
    const baseExec = makeExec(db);
    let failCorrection = false;
    const exec: SqlExecutor = {
      all: (sql, params) => baseExec.all(sql, params),
      run: (sql, params) => {
        if (failCorrection && sql.includes("INSERT INTO inventory_repack_journal")) {
          throw new Error("simulated correction failure");
        }
        return baseExec.run(sql, params);
      },
    };
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

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByRole("dialog");
    expect(scan.active()).toBe(false);
    expect(scan.stops()).toBe(1);
    fireEvent.change(screen.getByLabelText("Дата производства"), {
      target: { value: "2026-10-01" },
    });
    expect(
      (screen.getByRole("button", { name: "Применить дату" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    scan.emit(OLD_SSCC);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_repack_boxes_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(scan.active()).toBe(true));
    expect(scan.starts()).toBe(2);

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

    fireEvent.click(screen.getByRole("button", { name: "Исправления" }));
    expect(await screen.findByRole("button", { name: "Убрать последнюю бутылку" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Закрыть неполный короб" })).toBeNull();
    failCorrection = true;
    fireEvent.click(screen.getByRole("button", { name: "Очистить открытый короб" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(scan.active()).toBe(true));
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 2,
    });
    await act(async () => i18n.changeLanguage("en"));
    expect(screen.getByLabelText("Position 1: occupied")).toBeDefined();
    expect(screen.getByLabelText("Position 2: free")).toBeDefined();
    await act(async () => i18n.changeLanguage("ru"));
  });

  it("offers one explicit recovery transition for an invalidated owned box", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'ИНВ-Р-42', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    const boxId = "88888888-8888-4888-8888-888888888888";
    const losingEventId = "99999999-9999-4999-8999-999999999999";
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          open_repack_box_id, next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', ?, 2, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID, boxId);
    db.prepare(
      `INSERT INTO inventory_repack_boxes_mirror
         (inventory_id, snapshot_id, box_id, opened_event_id, old_sscc_context, new_sscc,
          owner_device_id, capacity, production_date, state, print_state, opened_at,
          invalidated_at, invalidation_source, updated_at)
       VALUES (?, ?, ?, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?, '046006820000621515',
               ?, 20, '2026-08-19', 'invalidated', 'not_ready',
               '2026-08-25T09:00:00.000Z', '2026-08-25T10:00:00.000Z', 'claim_lost',
               '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, boxId, OLD_SSCC, DEVICE_ID);
    db.prepare(
      `INSERT INTO inventory_repack_items_mirror
         (inventory_id, snapshot_id, item_id, source_event_id, box_id, code_hash,
          position, production_date, added_at)
       VALUES (?, ?, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ?, ?, ?, 1,
               '2026-08-19', '2026-08-25T09:01:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, losingEventId, boxId, "c".repeat(64));
    db.prepare(
      `INSERT INTO inventory_conflicts_mirror
         (inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
          winning_event_id, winning_device_id, winning_scanned_at, detected_at, state)
       VALUES (?, ?, 'conflict-1', ?, ?, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
               'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-08-25T08:59:00.000Z',
               '2026-08-25T10:00:00.000Z', 'open')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, "c".repeat(64), losingEventId);

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scanner().source}
        createEventId={() => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}
        now={() => "2026-08-25T10:01:00.000Z"}
      />,
    );

    expect(await screen.findByText("Короб заблокирован из-за конфликта")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Исправления" }));
    const resolve = await screen.findByRole("button", {
      name: "Очистить конфликт и продолжить",
    });
    fireEvent.click(resolve);
    await waitFor(() => expect(screen.getByText("Сканируйте каждую бутылку")).toBeDefined());
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT state FROM inventory_conflicts_mirror WHERE conflict_id = 'conflict-1'")
        .get(),
    ).toEqual({ state: "resolved" });
  });

  it("hides local composition controls for a non-empty admin-invalidated box", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'ИНВ-Р-42', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    const boxId = "12121212-1212-4212-8212-121212121212";
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          open_repack_box_id, next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', ?, 2, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID, boxId);
    db.prepare(
      `INSERT INTO inventory_repack_boxes_mirror
         (inventory_id, snapshot_id, box_id, opened_event_id, old_sscc_context, new_sscc,
          owner_device_id, capacity, production_date, state, print_state, opened_at,
          invalidated_at, invalidation_source, updated_at)
       VALUES (?, ?, ?, '13131313-1313-4313-8313-131313131313', ?, '046006820000621515',
               ?, 20, '2026-08-19', 'invalidated', 'not_ready',
               '2026-08-25T09:00:00.000Z', '2026-08-25T10:00:00.000Z', 'admin',
               '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, boxId, OLD_SSCC, DEVICE_ID);
    db.prepare(
      `INSERT INTO inventory_repack_items_mirror
         (inventory_id, snapshot_id, item_id, source_event_id, box_id, code_hash,
          position, production_date, added_at)
       VALUES (?, ?, '15151515-1515-4515-8515-151515151515',
               '16161616-1616-4616-8616-161616161616', ?, ?, 1,
               '2026-08-19', '2026-08-25T09:01:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, boxId, "d".repeat(64));

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scanner().source}
        createEventId={() => "14141414-1414-4414-8414-141414141414"}
        now={() => "2026-08-25T10:01:00.000Z"}
      />,
    );

    expect(await screen.findByText("Короб аннулирован администратором")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Исправления" }));
    expect(screen.queryByRole("button", { name: "Очистить конфликт и продолжить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Убрать последнюю бутылку" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Очистить открытый короб" })).toBeNull();
  });

  it("prints a full box automatically, pauses product scanning, and exposes no skip step", async () => {
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
    const km = canonicalizeKm(`01${GTIN}21REPACK-PRINT`);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, 'INTRODUCED', '2026-08-19', ?, 1, 0)`,
    ).run(SNAPSHOT_ID, kmHash(km), km.raw, GTIN, km.serial, OLD_SSCC);
    const scan = scanner();
    let finishPrint: (() => void) | undefined;
    const print = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPrint = resolve;
        }),
    );

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={{ ...manifest, boxCapacity: 1 }}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        printing={{
          target: { kind: "usb", printer: "Zebra" },
          language: "zpl",
          print,
        }}
        createEventId={() => crypto.randomUUID()}
        now={() => "2026-08-25T10:00:01.000Z"}
      />,
    );

    await waitFor(() => expect(scan.active()).toBe(true));
    scan.emit(OLD_SSCC);
    await screen.findByText("Старый короб выбран");
    scan.emit(km.raw);
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(scan.active()).toBe(false);
    expect(screen.queryByText(/пропустить/i)).toBeNull();
    expect(screen.queryByText(/следующий короб/i)).toBeNull();

    await act(async () => finishPrint?.());
    expect(await screen.findByText("Этикетка напечатана")).toBeDefined();
    await waitFor(() => expect(scan.active()).toBe(true));
    expect(db.prepare("SELECT print_state FROM inventory_repack_boxes_mirror").get()).toEqual({
      print_state: "printed",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM inventory_repack_print_attempts").get(),
    ).toEqual({ count: 1 });

    const printedSscc = String(
      db.prepare("SELECT new_sscc FROM inventory_repack_boxes_mirror").get()?.new_sscc,
    );
    fireEvent.click(screen.getByRole("button", { name: "Исправления" }));
    await screen.findByLabelText("SSCC короба");
    await waitFor(() => expect(scan.active()).toBe(true));
    scan.emit(`(00)${printedSscc}`);
    expect(await screen.findByDisplayValue(printedSscc)).toBeDefined();
    await screen.findByRole("button", { name: "Перепечатать" });
    // Changing the query must synchronously drop the previous matches so a
    // stale row cannot be tapped while the new lookup is in flight.
    fireEvent.change(screen.getByLabelText("SSCC короба"), { target: { value: "999999" } });
    expect(screen.queryByRole("button", { name: "Перепечатать" })).toBeNull();
    fireEvent.change(screen.getByLabelText("SSCC короба"), { target: { value: printedSscc } });
    fireEvent.click(await screen.findByRole("button", { name: "Перепечатать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(scan.active()).toBe(false);
    await act(async () => finishPrint?.());
    await waitFor(() =>
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM inventory_repack_print_attempts").get(),
      ).toEqual({ count: 2 }),
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT box.new_sscc) AS count FROM inventory_repack_print_attempts attempt JOIN inventory_repack_boxes_mirror box ON box.box_id = attempt.box_id",
        )
        .get(),
    ).toEqual({ count: 1 });
  });
});
