// @vitest-environment jsdom

import { DatabaseSync } from "node:sqlite";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash, type StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import type { StationClient } from "../src/lib/api-client.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { applyMigrations } from "../src/lib/mirror.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { InventoryWorkScreen } from "../src/pages/InventoryWorkScreen.js";
import { deferred } from "./support/deferred.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const GTIN = "04600000000015";

const manifest: StationInventoryBundleManifest & { mode: "check" } = {
  inventoryId: INVENTORY_ID,
  inventoryNumber: "IVN-26-0042",
  snapshotId: SNAPSHOT_ID,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 4,
  productId: "55555555-5555-4555-8555-555555555555",
  productName: "Пиво светлое 0,45 л",
  productPrintName: null,
  egaisCode: null,
  shelfLifeDays: null,
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
      const activeListener = listener;
      if (activeListener === null) throw new Error("test scanner is not listening");
      act(() => activeListener(scannerRaw));
    },
    isListening() {
      return listener !== null;
    },
    stop,
  };
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'IVN-26-0042', ?)",
  ).run(INVENTORY_ID, SNAPSHOT_ID);
  for (const [serial, sourceStatus, sourceState, expected, protectedFlag, productionDate] of [
    ["EXPECTED", "INTRODUCED", null, 1, 0, "2026-08-19"],
    ["PROTECTED", "INTRODUCED", "MOVING_BY_UD", 0, 1, "2026-08-19"],
    ["INELIGIBLE", "APPLIED", null, 0, 0, "2026-08-19"],
    ["NEXTDAY", "INTRODUCED", null, 1, 0, "2026-08-20"],
  ] as const) {
    const km = canonicalizeKm(raw(serial));
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
       (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
        source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      SNAPSHOT_ID,
      kmHash(km),
      km.raw,
      km.gtin14,
      km.serial,
      sourceStatus,
      sourceState,
      productionDate,
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
  it("refreshes visible progress when a remote-only authoritative claim is persisted", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
    const scan = scanner();
    const credentialGeneration = createCredentialGeneration("remote-progress");
    const credentialOwnership = await credentialGenerationOwnership(credentialGeneration);
    if (!credentialOwnership) throw new Error("expected credential ownership");
    const floorTaskPointerValue = JSON.stringify({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      credentialOwnership,
      activationId: "remote-progress",
    });
    db.prepare(
      "INSERT INTO station_meta (key, value) VALUES ('active_inventory_floor_task_v1', ?)",
    ).run(floorTaskPointerValue);
    const expected = canonicalizeKm(raw("EXPECTED"));
    const codeHash = kmHash(expected);
    const changeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const progressPage = {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      cursor: null,
      resultRevision: 1,
      items: [
        {
          id: changeId,
          revision: 1,
          kind: "claim",
          codeHash,
          classification: "expected",
          observedProductionDate: "2026-08-19",
          winner: {
            codeHash,
            eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            scannedAt: "2026-08-25T08:00:00.000Z",
          },
          correctedAt: "2026-08-25T10:00:00.000Z",
        },
      ],
      nextCursor: `1:${changeId}`,
    };
    const get = vi.fn();
    const client: Pick<StationClient, "get" | "post"> = {
      async post<T>() {
        return {} as T;
      },
      async get<T>() {
        get();
        return progressPage as T;
      },
    };

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        client={client}
        credentialGeneration={credentialGeneration}
        floorTaskPointerValue={floorTaskPointerValue}
      />,
    );

    await waitFor(() => expect(get).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("inventory-verified").textContent).toBe("1"));
    expect(scan.source).toBeDefined();
  });

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
    expect(screen.getByText("IVN-26-0042")).toBeDefined();
    expect(screen.getByText("Пиво светлое 0,45 л")).toBeDefined();
    expect(screen.getByText("19.08.2026")).toBeDefined();
    await waitFor(() => expect(onQueueRegister).toHaveBeenCalledOnce());
    await waitFor(() => expect(scan.isListening()).toBe(true));

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
    expect(screen.getByText(/Этот терминал · \d{2}:\d{2}:\d{2}/)).toBeDefined();
    expect(screen.queryByText(new RegExp(DEVICE_ID))).toBeNull();

    expect(screen.getByText("1", { selector: "[data-testid='inventory-verified']" })).toBeDefined();
    expect(
      screen.getByText("2", { selector: "[data-testid='inventory-discrepancies']" }),
    ).toBeDefined();
    expect(
      screen.getByText("1", { selector: "[data-testid='inventory-protected']" }),
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

  it("reconciles an orphan pending claim before scanner intake and asks for a rescan", async () => {
    const { db, exec } = await fixture();
    const expected = canonicalizeKm(raw("EXPECTED"));
    const codeHash = kmHash(expected);
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id, scanned_at,
          kind, normalized_identity, code_hash, raw_payload, active_production_date, local_verdict,
          commit_state, legacy_audit_version)
       VALUES (?, ?, 'orphan-event', ?, 1, ?, '2026-08-25T08:00:00.000Z', 'item', ?, ?, ?,
               '2026-08-19', 'expected', 'pending', 1)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      DEVICE_ID,
      OPERATOR_ID,
      `item:${codeHash}`,
      codeHash,
      expected.raw,
    );
    db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification, origin_classification,
          updated_at)
       VALUES (?, ?, ?, 'orphan-event', ?, '2026-08-25T08:00:00.000Z', '2026-08-19',
               'expected', 'expected', '2026-08-25T08:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, codeHash, DEVICE_ID);
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

    expect(await screen.findByText("Скан не сохранён — повторите сканирование")).toBeDefined();
    expect(screen.queryByText("Код принят")).toBeNull();
    expect(screen.getByText("0", { selector: "[data-testid='inventory-verified']" })).toBeDefined();
    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "failed",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("persists a changed date and applies it to the next accepted scan", async () => {
    const { db, exec } = await fixture();
    // The snapshot's own known date for this code must match the date the
    // operator is about to apply: otherwise the terminal's first-ever scan
    // silently adopts the code's own date instead (see the source production
    // date guard), which would mask the manual date change under test here.
    db.prepare(
      `UPDATE inventory_snapshot_codes_mirror SET source_production_date = '2026-08-20'
        WHERE snapshot_id = ? AND code_hash = ?`,
    ).run(SNAPSHOT_ID, kmHash(canonicalizeKm(raw("EXPECTED"))));
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

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
        if (
          !held &&
          /SELECT code_hash, canonical_raw[\s\S]*FROM inventory_snapshot_codes_mirror/i.test(sql)
        ) {
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
    await waitFor(() => expect(scan.isListening()).toBe(true));
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
    await waitFor(() => expect(scan.isListening()).toBe(true));
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

  it("holds a mismatching scan, then counts it after the operator adopts the code's date", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );
    expect(scan.isListening()).toBe(false);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Установить/ }));

    await waitFor(() =>
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get() as {
            count: number;
          }
        ).count,
      ).toBe(2),
    );
    const stored = db
      .prepare("SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID) as { active_production_date: string };
    expect(stored.active_production_date).toBe("2026-08-20");
  });

  it("leaves nothing behind when the operator skips a mismatching code", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
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
    await waitFor(() => expect(scan.isListening()).toBe(true));
    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());
    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Пропустить код" }));

    await waitFor(() => expect(scan.isListening()).toBe(true));
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    const stored = db
      .prepare("SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID) as { active_production_date: string };
    expect(stored.active_production_date).toBe("2026-08-19");
  });

  it("keeps skip disabled and inert while an adopt's write is in flight, then lets the adopt land normally", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
    const gate = deferred();
    let gated = false;
    // Holds open only the terminal-date upsert `adoptHeldDate` issues
    // (distinguished by its `active_production_date = excluded...` clause),
    // not the sequence-allocation upsert every scan also issues against the
    // same table.
    const suspended: SqlExecutor = {
      run: async (sql, params) => {
        if (
          !gated &&
          /INSERT INTO inventory_terminal_state[\s\S]*active_production_date = excluded\.active_production_date/i.test(
            sql,
          )
        ) {
          gated = true;
          await gate.promise;
        }
        return exec.run(sql, params);
      },
      all: <T,>(sql: string, params?: unknown[]) => exec.all<T>(sql, params),
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Установить/ }));
    await waitFor(() => expect(gated).toBe(true));

    // The write is still suspended on `gate.promise`. Proving the overlap
    // cannot happen means proving skip has no way to release the hold while
    // that write is in flight — not just that a click "does nothing" by
    // accident.
    const skipButton = screen.getByRole("button", {
      name: "Пропустить код",
    }) as HTMLButtonElement;
    expect(skipButton.disabled).toBe(true);

    // A disabled native button never dispatches its click handler, so this
    // must be a no-op: the dialog stays open and the scanner stays held.
    fireEvent.click(skipButton);
    expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy();
    expect(scan.isListening()).toBe(false);

    // Escape is the dialog's other release path, gated inside
    // `FullScreenDialog` by the same `backDisabled` flag — it must be inert
    // too while the write is pending.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy();
    expect(scan.isListening()).toBe(false);

    gate.release();

    // Once the write lands, the adopt completes exactly as an uncontested
    // adopt would: NEXTDAY is recorded under the adopted date, and the
    // terminal's active date stays at the adopted value — there is nothing
    // to revert, because the overlap the old compensating write guarded
    // against was never possible.
    await waitFor(() => expect(scan.isListening()).toBe(true));
    await waitFor(() =>
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get() as {
            count: number;
          }
        ).count,
      ).toBe(2),
    );
    const nextDayHash = kmHash(canonicalizeKm(raw("NEXTDAY")));
    const nextDayResult = db
      .prepare(
        "SELECT observed_production_date FROM inventory_code_results_mirror WHERE code_hash = ?",
      )
      .get(nextDayHash) as { observed_production_date: string };
    expect(nextDayResult.observed_production_date).toBe("2026-08-20");
    const stored = db
      .prepare("SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID) as { active_production_date: string };
    expect(stored.active_production_date).toBe("2026-08-20");
  });

  it("shows the mixed-dates dialog for a box whose children disagree, then counts it against the active date", async () => {
    const { db, exec } = await fixture();
    // A valid, unrelated 18-digit SSCC (mirrors the one used in
    // inventory-journal.test.ts's own mixed-box unit test).
    const SSCC = "346006820000000014";
    const children = ["CHILD-A", "CHILD-B"].map((serial, index) => {
      const km = canonicalizeKm(raw(serial));
      db.prepare(
        `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
          source_production_date, parent_sscc, expected, protected)
         VALUES (?, ?, ?, ?, ?, 'INTRODUCED', NULL, ?, ?, 1, 0)`,
      ).run(
        SNAPSHOT_ID,
        kmHash(km),
        km.raw,
        km.gtin14,
        km.serial,
        index === 0 ? "2026-08-21" : "2026-08-22",
        SSCC,
      );
      return { serial, codeHash: kmHash(km) };
    });
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    scan.emit(SSCC);
    await waitFor(() => expect(screen.getByText("В коробе несколько дат розлива")).toBeTruthy());
    expect(scan.isListening()).toBe(false);
    expect(screen.getByText(/Подставить одну дату нельзя/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Установить/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Зачесть как есть" }));

    await waitFor(() => expect(scan.isListening()).toBe(true));
    const stored = db
      .prepare(
        `SELECT code_hash, observed_production_date FROM inventory_code_results_mirror
          WHERE code_hash IN (?, ?)`,
      )
      .all(children[0]!.codeHash, children[1]!.codeHash) as {
      code_hash: string;
      observed_production_date: string;
    }[];
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.observed_production_date).toBe("2026-08-19");
    }
    const terminalDate = db
      .prepare("SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID) as { active_production_date: string };
    expect(terminalDate.active_production_date).toBe("2026-08-19");
  });

  it("clears a stale accepted result behind a held mismatching scan", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Пропустить код" }));

    // NEXTDAY was never recorded, so the floor screen must not keep showing
    // the previous scan's accepted verdict behind the (now closed) dialog —
    // otherwise the operator would believe the skipped code was counted.
    await waitFor(() => expect(scan.isListening()).toBe(true));
    expect(screen.queryByText("Код принят")).toBeNull();
  });

  it("holds only the first of two back-to-back mismatching scans and drops the second from the queue", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
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
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    // Back to back, with no `await` in between: a keyboard-wedge scanner
    // delivers a burst of codes into `source.start`'s callback inside one
    // macrotask, before React commits `heldScan` and tears the listener
    // down — both land in the scan queue's buffer before NEXTDAY's mismatch
    // outcome has a chance to hold the queue. PROTECTED needs no date match
    // to be accepted, so if it is silently processed behind the dialog it is
    // unambiguously recorded.
    scan.emit(raw("NEXTDAY"));
    scan.emit(raw("PROTECTED"));

    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );
    expect(scan.isListening()).toBe(false);
    // Only EXPECTED has ever been committed: NEXTDAY's mismatch writes
    // nothing, and PROTECTED must not have been silently processed while
    // the dialog for NEXTDAY is open.
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Пропустить код" }));

    // The scanner resumes intake with nothing queued behind it: PROTECTED
    // was dropped entirely, not silently recorded and not held as a second
    // dialog.
    await waitFor(() => expect(scan.isListening()).toBe(true));
    expect(screen.queryByText("Дата в коде отличается от активной")).toBeNull();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    // PROTECTED can still be scanned normally afterward.
    scan.emit(raw("PROTECTED"));
    expect(await screen.findByText("Код не учтён: уже в отгрузке")).toBeDefined();
  });
});
