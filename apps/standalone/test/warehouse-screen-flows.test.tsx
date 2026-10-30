import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import type { PrintRuntime, SendOutcome } from "../src/floor/print/print-runtime.js";
import { HostError } from "../src/host/client.js";
import type { PalletSheets, WarehouseLookupResult } from "../src/host/protocol.js";
import { groupSscc } from "../src/floor/warehouse/warehouse-view.js";
import { openLocalDb } from "./support/local-db.js";
import { HP_A4, setUpPrinting, TSC, ZEBRA } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  KM,
  PALLET_SOURCE,
  PALLET_SSCC,
  seedWarehouseCopies,
  UNIT_SOURCE,
} from "./support/warehouse.js";
import {
  OPERATOR_ID,
  renderWarehouse,
  rows,
  startedWarehouse,
} from "./support/warehouse-screen.js";

const [STOCK_SHEET] = buildPalletSheetPresets();
if (STOCK_SHEET === undefined) throw new Error("no stock sheet");
const SHEET_SPEC = STOCK_SHEET.spec;
const SHEET_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const HOST_SHEETS: PalletSheets = {
  sheets: [
    {
      id: SHEET_ID,
      name: "Вертикальная",
      enabled: true,
      presetKey: null,
      revision: 2,
      spec: SHEET_SPEC,
    },
    {
      id: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
      name: "Другая",
      enabled: true,
      presetKey: null,
      revision: 1,
      spec: SHEET_SPEC,
    },
  ],
  defaultId: SHEET_ID,
};

const FOUND_BOX = async (): Promise<WarehouseLookupResult> => ({
  status: "found",
  source: BOX_SOURCE,
});
const UNKNOWN_ANSWER = async () => ({ sent: false as const, code: "outcome_unknown" as const });
const NOT_SENT_ANSWER = async () => ({ sent: false as const, code: "not_sent" as const });
const NO_PRINTERS = { box: null, pallet: null, duplicate: null };

describe("what the screen says of a scan that printed nothing", () => {
  const host = (code: string, kind: "api" | "transport" = "api") =>
    new HostError({ kind, code, message: code });
  it.each([
    [
      "a code the host does not know",
      async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }),
      BOX_SSCC,
      "Код не найден в базе хоста. Проверьте этикетку.",
    ],
    [
      "a code released by an exception",
      async (): Promise<WarehouseLookupResult> => ({ status: "unavailable", reason: "released" }),
      BOX_SSCC,
      "Код снят с учёта исключением: перепечатка недоступна.",
    ],
    [
      "a box taken apart",
      async (): Promise<WarehouseLookupResult> => ({
        status: "unavailable",
        reason: "disassembled",
      }),
      BOX_SSCC,
      "Короб или паллета расформированы: перепечатка недоступна.",
    ],
    [
      "a host that cannot be reached",
      () => Promise.reject(host("unreachable", "transport")),
      BOX_SSCC,
      "Нет связи с хостом: найти код нельзя. Дождитесь связи и отсканируйте снова.",
    ],
    [
      "a host without the route",
      () => Promise.reject(host("not_found")),
      BOX_SSCC,
      "Хост не поддерживает повторную печать. Обновите хост.",
    ],
    [
      "a host held by a restore",
      () => Promise.reject(host("restore_pending")),
      BOX_SSCC,
      "Хост восстановлен из копии и ждёт решения офиса: поиск недоступен.",
    ],
    [
      "a host that answered badly",
      () => Promise.reject(new Error("boom")),
      BOX_SSCC,
      "Хост не ответил на поиск. Отсканируйте снова.",
    ],
    [
      "a code that is nothing to reprint",
      async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }),
      "это не код",
      "Не удалось распознать код единицы или SSCC.",
    ],
  ])("%s", async (_name, lookup, scanned, said) => {
    const at = await startedWarehouse({ lookup });
    await at.scan(scanned);
    expect(await screen.findByText(said)).toBeTruthy();
    expect(at.shell.sends).toHaveLength(0);
  });

  it("hands a refused key of the host to the shell and prints nothing", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      message: "unauthorized",
      details: { credential: "device" },
    });
    const at = await startedWarehouse({ lookup: () => Promise.reject(refused) });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Хост не ответил на поиск. Отсканируйте снова.")).toBeTruthy();
    expect(at.props.onHostError).toHaveBeenCalledWith(refused);
    expect(at.shell.sends).toHaveLength(0);
  });

  it("looks nothing up for a code that is not a reprint's, and asks the host by hash or by SSCC", async () => {
    const at = await startedWarehouse({
      lookup: async (): Promise<WarehouseLookupResult> => ({
        status: "found",
        source: UNIT_SOURCE,
      }),
    });
    await at.scan("это не код");
    expect(at.lookup).not.toHaveBeenCalled();
    await at.scan(KM);
    expect(at.lookup).toHaveBeenCalledWith({ codeHash: UNIT_SOURCE.identity });
  });
});

describe("the kinds of label", () => {
  it("prints a unit on the duplicate printer and a pallet on the pallet printer, each told by its subject", async () => {
    const at = await startedWarehouse({
      lookup: async (request): Promise<WarehouseLookupResult> => ({
        status: "found",
        source: "codeHash" in request ? UNIT_SOURCE : PALLET_SOURCE,
      }),
    });
    await at.scan(KM);
    expect(await screen.findByLabelText("Единица · дубликат Data Matrix")).toBeTruthy();
    // The serial (AI 21) is the unit's code on screen, its GTIN beside it.
    expect(screen.getByText("S000001")).toBeTruthy();
    expect(at.shell.sends[0]?.target).toMatchObject({ kind: "serial", port: "COM4" });
    await at.press("Напечатать ещё раз");
    await at.press("Утеряна");
    await at.press("Напечатать");
    await at.scan(PALLET_SSCC);
    // A sent label is decided by the next scan only through a new job: the code is another.
    expect(await screen.findByLabelText("Паллета")).toBeTruthy();
    expect(screen.getByText(groupSscc(PALLET_SSCC))).toBeTruthy();
    expect(at.shell.sends[2]?.target).toMatchObject({ kind: "tcp", host: "192.168.1.50" });
  });
});

describe("a label that did not go out", () => {
  it("keeps a job with no printer, offers the workstation, takes no other code, and cancels it", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Для этого типа этикетки не назначен принтер/)).toBeTruthy();
    expect(screen.getByText("Принтер не назначен")).toBeTruthy();
    await at.press("Рабочее место");
    expect(at.props.onSetup).toHaveBeenCalledTimes(1);
    await at.scan(PALLET_SSCC);
    expect(await screen.findByText("Сначала завершите работу с текущей этикеткой.")).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledTimes(1);
    await at.press("Отменить печать");
    expect(await screen.findByText("Печать отменена")).toBeTruthy();
    expect(rows(at.db, "SELECT state, attempts FROM wh_jobs")).toEqual([
      { state: "cancelled", attempts: 0 },
    ]);
    // A cancelled job leaves the code free to be looked up again.
    await at.scan(BOX_SSCC);
    expect(at.lookup).toHaveBeenCalledTimes(2);
  });

  it("prints a pallet's A4 sheet on the printer of sheets, from the sheet the host gives the product by default", async () => {
    const seeded = openLocalDb();
    seedWarehouseCopies(seeded.db);
    await setUpPrinting(seeded.executor, {
      printers: [ZEBRA, TSC, HP_A4],
      assignments: { box: "zebra", pallet: "hp-a4", duplicate: "tsc" },
    });
    const sends: { paper: string | undefined; bytes: number }[] = [];
    const printing: PrintRuntime = {
      send: async (_job, _target, bytes, _mode, paper): Promise<SendOutcome> => {
        sends.push({ paper, bytes: bytes.length });
        return { kind: "answered", result: { sent: true } };
      },
      isInFlight: () => false,
      inFlight: () => [],
      checkWindowsJob: async () => ({ state: "no_receipt" }),
      supportsWindowsDriver: async () => true,
    };
    const palletSheets = vi.fn(async () => HOST_SHEETS);
    const at = await startedWarehouse({
      seeded,
      lookup: async (): Promise<WarehouseLookupResult> => ({
        status: "found",
        source: PALLET_SOURCE,
      }),
      overrides: { printing, palletSheets },
    });
    await at.scan(PALLET_SSCC);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    // The session started on «по умолчанию товара», the sheet the host names for this product.
    expect(palletSheets).toHaveBeenCalledWith(PALLET_SOURCE.product.id);
    expect(sends).toEqual([{ paper: "a4", bytes: expect.any(Number) }]);
    expect(rows(at.db, "SELECT state, template_id, template_rev FROM wh_jobs")).toEqual([
      { state: "sent", template_id: SHEET_ID, template_rev: 2 },
    ]);
  });

  it("offers the A4 sheets for pallets on a printer of sheets, the label templates on a label printer, and says when there is no printer", async () => {
    const choose = async (assignments: {
      box: string | null;
      pallet: string | null;
      duplicate: string | null;
    }) => {
      const seeded = openLocalDb();
      seedWarehouseCopies(seeded.db);
      await setUpPrinting(seeded.executor, { printers: [ZEBRA, TSC, HP_A4], assignments });
      const at = await renderWarehouse({
        seeded,
        overrides: { palletSheets: async () => HOST_SHEETS },
      });
      await screen.findByRole("button", { name: "Начать перепечатку" });
      await at.press("Изменить: Паллеты");
      return at;
    };
    // A printer of sheets: «по умолчанию товара» (chosen) and the host's sheets, no label template.
    const a4 = await choose({ box: "zebra", pallet: "hp-a4", duplicate: "tsc" });
    expect(await screen.findByRole("button", { name: "По умолчанию товара" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "По умолчанию товара" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Вертикальная" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Палета 100×150/ })).toBeNull();
    await a4.press("Другая");
    await a4.press("Применить шаблоны");
    expect(screen.getByText(`Другая · ${HP_A4.name}`)).toBeTruthy();
    cleanup();
    // A label printer: the label templates of the copies, as before.
    await choose({ box: "zebra", pallet: "zebra", duplicate: "tsc" });
    expect(screen.getByRole("button", { name: /Палета 100×150/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "По умолчанию товара" })).toBeNull();
    cleanup();
    // No printer for pallets: it is said, and nothing is offered.
    await choose({ box: "zebra", pallet: null, duplicate: "tsc" });
    expect(screen.getByText(/Принтер паллет не выбран/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Палета 100×150/ })).toBeNull();
  });

  it("says the host's sheets did not come, and tries again", async () => {
    const seeded = openLocalDb();
    seedWarehouseCopies(seeded.db);
    await setUpPrinting(seeded.executor, {
      printers: [ZEBRA, TSC, HP_A4],
      assignments: { box: "zebra", pallet: "hp-a4", duplicate: "tsc" },
    });
    let answers = 0;
    const at = await renderWarehouse({
      seeded,
      overrides: {
        palletSheets: async () => {
          answers += 1;
          if (answers === 1) throw new Error("offline");
          return HOST_SHEETS;
        },
      },
    });
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Изменить: Паллеты");
    expect(await screen.findByText("Листы А4 не получены от хоста. Проверьте связь.")).toBeTruthy();
    await at.press("Повторить");
    expect(await screen.findByRole("button", { name: "Вертикальная" })).toBeTruthy();
  });

  it("retries a failed job on the printer assigned now, once, and says it is sent", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS });
    await at.scan(BOX_SSCC);
    await screen.findByText("Принтер не назначен");
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    await at.press("Повторить отправку");
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(at.shell.sends).toHaveLength(1);
    expect(rows(at.db, "SELECT state, attempts FROM wh_jobs")).toEqual([
      { state: "sent", attempts: 1 },
    ]);
  });

  it("says a printer that took nothing as failed, and the retry is the operator's", async () => {
    const at = await startedWarehouse({ answer: NOT_SENT_ANSWER });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этикетка не отправлена/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить отправку" })).toBeTruthy();
    await act(async () => {
      await at.gate.drain();
    });
    expect(at.shell.sends).toHaveLength(1);
  });
});

describe("a label whose outcome is not known", () => {
  it("waits for the operator: no send by itself, a check by a scan or a new attempt with a reason", async () => {
    const at = await startedWarehouse({ answer: UNKNOWN_ANSWER });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Проверить сканом" })).toBeTruthy();
    // Time, the link and a rerender send nothing.
    at.rerender({ online: false });
    at.rerender({ online: true });
    at.clock.now += 60_000;
    await at.settled();
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Проверить сканом");
    expect(screen.getByText("Отсканируйте новую этикетку")).toBeTruthy();
    // The old label with «!1» is not the new one; another box is not either.
    await at.scan(`!1${BOX_SSCC}`);
    expect(await screen.findByText("Это не код новой этикетки.")).toBeTruthy();
    await at.scan(PALLET_SSCC);
    expect(
      await screen.findByText(
        "Код не совпадает с новой этикеткой. Отсканируйте именно новую этикетку.",
      ),
    ).toBeTruthy();
    expect(at.shell.sends).toHaveLength(1);
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Новая этикетка проверена")).toBeTruthy();
    expect(rows(at.db, "SELECT state, attempts FROM wh_jobs")).toEqual([
      { state: "verified", attempts: 1 },
    ]);
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });

  it("is printed again only with a reason chosen, and the confirmation waits for it", async () => {
    const at = await startedWarehouse({ answer: UNKNOWN_ANSWER });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Неизвестно, вышла ли этикетка/);
    await at.press("Напечатать ещё раз");
    expect(
      screen.getByText(
        "Этикетка могла уже выйти. На принтер уйдут те же данные: код и SSCC не меняются.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Напечатать" }).hasAttribute("disabled")).toBe(true);
    await at.press("Напечатать");
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Не напечаталась");
    expect(
      screen.getByRole("radio", { name: "Не напечаталась" }).getAttribute("aria-checked"),
    ).toBe("true");
    await at.press("Напечатать");
    expect(at.shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT reason, attempts FROM wh_jobs")).toEqual([
      { reason: "not_printed", attempts: 2 },
    ]);
  });

  it("takes «Отмена» of the confirmation as no print", async () => {
    const at = await startedWarehouse({ answer: UNKNOWN_ANSWER });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Неизвестно, вышла ли этикетка/);
    await at.press("Напечатать ещё раз");
    await at.press("Утеряна");
    await at.press("Отмена");
    expect(screen.queryByRole("heading", { name: "Причина новой попытки" })).toBeNull();
    expect(at.shell.sends).toHaveLength(1);
  });
});

describe("a restart of the screen", () => {
  it("finds the send cut by a restart as unknown and sends nothing, then the session goes on", async () => {
    const first = await startedWarehouse();
    first.shell.holdSends();
    await act(async () => {
      first.scanner.emit(BOX_SSCC);
    });
    await waitFor(() => expect(first.shell.sends).toHaveLength(1));
    // The application stops with the bytes on their way: no answer ever comes back.
    first.view.unmount();
    const again = await renderWarehouse({ seeded: { db: first.db, executor: first.local } });
    expect(await screen.findByText(/Продолжен незавершённый сеанс перепечатки\./)).toBeTruthy();
    expect(screen.getByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Проверить сканом" })).toBeTruthy();
    expect(screen.getByText("Причина: Повреждена")).toBeTruthy();
    expect(again.shell.sends).toHaveLength(0);
    expect(again.props.onRecorded).toHaveBeenCalled();
    expect(rows(again.db, "SELECT state, error_code FROM wh_jobs")).toEqual([
      { state: "unknown", error_code: "interrupted" },
    ]);
    await again.scanner.listening();
    await again.scan(PALLET_SSCC);
    expect(await screen.findByText("Сначала завершите работу с текущей этикеткой.")).toBeTruthy();
    expect(again.shell.sends).toHaveLength(0);
  });

  it("shows a prepared job that was never sent with «Отправить», and sends it only on that press", async () => {
    const first = await startedWarehouse();
    first.view.unmount();
    // A job made and cut before its send: written by the screen's own module.
    const { prepareWarehouseJob } = await import("../src/floor/warehouse/warehouse-work.js");
    const { readOpenSession } = await import("../src/floor/warehouse/warehouse-store.js");
    const { PAIRING } = await import("./support/floor-work.js");
    const session = await readOpenSession(first.local, PAIRING);
    if (session === null) throw new Error("session");
    const prepared = await prepareWarehouseJob(
      {
        local: first.local,
        pairing: PAIRING,
        runtime: first.runtime.runtime,
        now: () => new Date("2026-10-09T07:00:00.000Z"),
        newId: () => "00000000-0000-4000-8000-0000000000aa",
        render: first.props.render ?? (() => Promise.reject(new Error("no render"))),
      },
      { session, source: BOX_SOURCE, repair: null, operatorId: OPERATOR_ID },
    );
    expect(prepared).toMatchObject({ kind: "job", job: { state: "prepared" } });
    const again = await renderWarehouse({ seeded: { db: first.db, executor: first.local } });
    expect(await screen.findByText("Этикетка готова к отправке")).toBeTruthy();
    expect(again.shell.sends).toHaveLength(0);
    await again.press("Напечатать этикетку");
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(again.shell.sends).toHaveLength(1);
  });
});

describe("the operator and the copies", () => {
  it("prints nothing for an operator the copies no longer know", async () => {
    const at = await startedWarehouse({ operatorKnown: false });
    await at.scan(BOX_SSCC);
    expect(
      await screen.findByText("Доступ оператора отозван. Войдите под действующим оператором."),
    ).toBeTruthy();
    expect(at.shell.sends).toHaveLength(0);
  });
});

describe("the session", () => {
  it("changes its reason for the next labels, and a template for a kind, written for the next entry", async () => {
    const at = await startedWarehouse();
    await at.press("Причина: Повреждена");
    await at.press("Утеряна");
    await at.press("Применить причину");
    await at.settled();
    expect(screen.getByText("Причина: Утеряна")).toBeTruthy();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(rows(at.db, "SELECT reason FROM wh_sessions")).toEqual([{ reason: "lost" }]);
    expect(rows(at.db, "SELECT reason FROM wh_jobs")).toEqual([{ reason: "lost" }]);
    await at.press("Следующий код");
    await at.press("Шаблоны");
    await at.press("Паллеты");
    await at.press("Применить шаблоны");
    await at.settled();
    expect(
      rows(at.db, "SELECT unit_template_id, box_template_id, pallet_template_id FROM wh_sessions"),
    ).toHaveLength(1);
  });

  it("keeps the finish disabled with its reason while a label waits: never the session's end", async () => {
    const at = await startedWarehouse({ answer: UNKNOWN_ANSWER });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Неизвестно, вышла ли этикетка/);
    // The finish stays reachable from the detail, disabled, with the reason beside it.
    expect(
      screen.getByRole("button", { name: "Завершить сеанс" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText(/Сначала закройте этикетку/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Следующий код" })).toBeNull();
    // The store itself refuses a finish while a label waits (warehouse-store.test.ts).
    expect(rows(at.db, "SELECT finished_at FROM wh_sessions")).toEqual([{ finished_at: null }]);
    expect(at.props.onLeave).not.toHaveBeenCalled();
  });

  it("leaves a finished session finished: the next entry starts a new one", async () => {
    const at = await startedWarehouse();
    await at.press("Завершить сеанс");
    await at.press("Завершить");
    expect(at.props.onLeave).toHaveBeenCalledTimes(1);
    at.view.unmount();
    await renderWarehouse({ seeded: { db: at.db, executor: at.local } });
    expect(await screen.findByRole("button", { name: "Начать перепечатку" })).toBeTruthy();
    expect(screen.queryByText(/Продолжен незавершённый сеанс/)).toBeNull();
  });

  it("counts the labels sent and the records still waiting for the host", async () => {
    const at = await startedWarehouse();
    expect(screen.getByText("Передано на принтер: 0")).toBeTruthy();
    await at.press("Завершить сеанс");
    expect(screen.queryByText(/Записи ждут отправки на хост/)).toBeNull();
    await at.press("Отмена");
    await at.scan(BOX_SSCC);
    await screen.findByText(/Этикетка передана на принтер/);
    await at.press("Следующий код");
    expect(await screen.findByText("Передано на принтер: 1")).toBeTruthy();
    await at.press("Завершить сеанс");
    expect(screen.getByText("Записи ждут отправки на хост: 1")).toBeTruthy();
  });

  it("reads the stored session again on «Повторить» after a disk that failed to read", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    at.view.unmount();
    const failing = { ...at.local, query: vi.fn().mockRejectedValue(new Error("disk")) };
    const broken = await renderWarehouse({
      seeded: { db: at.db, executor: failing },
      overrides: { local: failing },
    });
    expect(
      await screen.findByText("Не удалось прочитать сеанс перепечатки на этом компьютере."),
    ).toBeTruthy();
    expect(broken.props.onRecorded).not.toHaveBeenCalled();
    failing.query.mockImplementation(at.local.query);
    await broken.press("Повторить");
    expect(await screen.findByRole("button", { name: "Начать перепечатку" })).toBeTruthy();
  });
});

describe("the typed code", () => {
  it("stays closed to an empty field, is left by Escape, and sends a typed code on Enter", async () => {
    const at = await startedWarehouse();
    await at.press("Ввести код вручную");
    const field = screen.getByLabelText(
      "Номер короба или паллеты (18 цифр) либо полный код единицы",
    );
    expect(
      screen.getByRole("button", { name: "Найти и напечатать" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByLabelText(/Номер короба или паллеты/)).toBeNull();
    await at.press("Ввести код вручную");
    fireEvent.change(screen.getByLabelText(/Номер короба или паллеты/), {
      target: { value: BOX_SSCC },
    });
    await act(async () => {
      fireEvent.submit(
        screen.getByLabelText(/Номер короба или паллеты/).closest("form") as Element,
      );
      await at.gate.drain();
    });
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(screen.queryByLabelText(/Номер короба или паллеты/)).toBeNull();
  });
});

describe("without the link", () => {
  it("says so on the screen at all times, and a code found only when the link is back", async () => {
    const at = await startedWarehouse({ online: false });
    expect(screen.getByText("Нет связи с хостом: найти код нельзя")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ввести код вручную" }).hasAttribute("disabled"),
    ).toBe(true);
    at.rerender({ online: true });
    expect(screen.queryByText("Нет связи с хостом: найти код нельзя")).toBeNull();
    await at.scan(BOX_SSCC);
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });

  it("still decides a label it holds: a retry of a failed job needs no host", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS, lookup: FOUND_BOX });
    await at.scan(BOX_SSCC);
    await screen.findByText("Принтер не назначен");
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    at.rerender({ online: false });
    await at.press("Повторить отправку");
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
  });
});

describe("the check of the print by a second scan: the session's switch", () => {
  const SWITCH = "Проверка распечатки повторным сканированием";

  /** A session started with the check switched as asked (the switch stands on the start screen). */
  async function startedWith(
    on: boolean,
    options: Parameters<typeof renderWarehouse>[0] = {},
  ): Promise<Awaited<ReturnType<typeof renderWarehouse>>> {
    const at = await renderWarehouse(options);
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Повреждена");
    const toggle = screen.getByRole("switch", { name: SWITCH });
    if ((toggle.getAttribute("aria-checked") === "true") !== on) fireEvent.click(toggle);
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe(
      String(on),
    );
    await at.press("Начать перепечатку");
    await at.scanner.listening();
    return at;
  }

  it("is off by default and the next code follows a sent label at once", async () => {
    const at = await startedWith(false);
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Этикетка передана на принтер")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить сканом" })).toBeNull();
    expect(screen.getByRole("button", { name: "Следующий код" })).toBeTruthy();
  });

  it("when on, holds the next code until the new label is scanned, and a wrong scan does not release it", async () => {
    const at = await startedWith(true);
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Этикетка передана на принтер")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Следующий код" })).toBeNull();
    await at.press("Проверить сканом");
    expect(screen.getByText("Отсканируйте новую этикетку")).toBeTruthy();
    await at.scan(PALLET_SSCC);
    expect(
      await screen.findByText(
        "Код не совпадает с новой этикеткой. Отсканируйте именно новую этикетку.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Следующий код" })).toBeNull();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Новая этикетка проверена")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Следующий код" })).toBeTruthy();
    expect(rows(at.db, "SELECT state, attempts FROM wh_jobs")).toEqual([
      { state: "verified", attempts: 1 },
    ]);
    // The check sent nothing more to the printer.
    expect(at.shell.sends).toHaveLength(1);
  });

  it("when on, lets the operator skip the check knowingly; no state is invented for it", async () => {
    const at = await startedWith(true);
    await at.scan(BOX_SSCC);
    await screen.findByText("Этикетка передана на принтер");
    await at.press("Пропустить проверку");
    expect(rows(at.db, "SELECT state FROM wh_jobs")).toEqual([{ state: "sent" }]);
    expect(screen.getByText("Отсканируйте код")).toBeTruthy();
  });

  it("starts as the workstation's own check is set, and the unknown outcome keeps its check either way", async () => {
    await renderWarehouse({ answer: UNKNOWN_ANSWER });
    await screen.findByRole("button", { name: "Начать перепечатку" });
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    cleanup();
    const seeded = openLocalDb();
    seedWarehouseCopies(seeded.db, { operator: true });
    await setUpPrinting(seeded.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
      verifyPrintedLabel: true,
    });
    const on = await renderWarehouse({ seeded, answer: UNKNOWN_ANSWER });
    await screen.findByRole("button", { name: "Начать перепечатку" });
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
    await on.press("Повреждена");
    await on.press("Начать перепечатку");
    await on.scanner.listening();
    await on.scan(BOX_SSCC);
    expect(await screen.findByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    await on.press("Проверить сканом");
    await on.scan(BOX_SSCC);
    expect(await screen.findByText("Новая этикетка проверена")).toBeTruthy();
    expect(on.shell.sends).toHaveLength(1);
  });
});
