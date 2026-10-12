import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { WarehouseLookupResult } from "../src/host/protocol.js";
import { setUpPrinting } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  KM,
  PALLET_SOURCE,
  PALLET_SSCC,
  UNIT_SOURCE,
} from "./support/warehouse.js";
import {
  OPERATOR_ID,
  renderWarehouse,
  rows,
  startedWarehouse,
} from "./support/warehouse-screen.js";

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
    expect(await screen.findByLabelText("Код единицы")).toBeTruthy();
    expect(at.shell.sends[0]?.target).toMatchObject({ kind: "serial", port: "COM4" });
    await at.press("Напечатать ещё раз");
    await at.press("Утеряна");
    await at.press("Напечатать");
    await at.scan(PALLET_SSCC);
    // A sent label is decided by the next scan only through a new job: the code is another.
    expect(await screen.findByLabelText(`Паллета ${PALLET_SSCC}`)).toBeTruthy();
    expect(at.shell.sends[2]?.target).toMatchObject({ kind: "tcp", host: "192.168.1.50" });
  });
});

describe("a label that did not go out", () => {
  it("keeps a job with no printer, offers the workstation, takes no other code, and cancels it", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS });
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Для этого типа этикетки не назначен принтер/)).toBeTruthy();
    expect(screen.getByText("Задание: не отправлено")).toBeTruthy();
    await at.press("Рабочее место");
    expect(at.props.onSetup).toHaveBeenCalledTimes(1);
    await at.scan(PALLET_SSCC);
    expect(await screen.findByText("Сначала решите текущую печать.")).toBeTruthy();
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

  it("retries a failed job on the printer assigned now, once, and says it is sent", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS });
    await at.scan(BOX_SSCC);
    await screen.findByText("Задание: не отправлено");
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
    expect(screen.getByText("Задание: исход неизвестен")).toBeTruthy();
    // Time, the link and a rerender send nothing.
    at.rerender({ online: false });
    at.rerender({ online: true });
    at.clock.now += 60_000;
    await at.settled();
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Проверить сканом");
    expect(screen.getByText(/Отсканируйте новую этикетку\./)).toBeTruthy();
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
      screen.getByText("Этикетка могла уже выйти. На принтер уйдут те же данные."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Напечатать" }).hasAttribute("disabled")).toBe(true);
    await at.press("Напечатать");
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Не напечаталась");
    expect(screen.getByText("Причина: Не напечаталась")).toBeTruthy();
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
    expect(screen.getByText("Задание: исход неизвестен")).toBeTruthy();
    expect(screen.getByText("Причина: Повреждена")).toBeTruthy();
    expect(again.shell.sends).toHaveLength(0);
    expect(again.props.onRecorded).toHaveBeenCalled();
    expect(rows(again.db, "SELECT state, error_code FROM wh_jobs")).toEqual([
      { state: "unknown", error_code: "interrupted" },
    ]);
    await again.scanner.listening();
    await again.scan(PALLET_SSCC);
    expect(await screen.findByText("Сначала решите текущую печать.")).toBeTruthy();
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
    expect(await screen.findByText("Задание: готово к отправке")).toBeTruthy();
    expect(again.shell.sends).toHaveLength(0);
    await again.press("Отправить");
    expect(await screen.findByText("Задание: передано на принтер")).toBeTruthy();
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
    await at.press("Изменить причину");
    await at.press("Утеряна");
    await at.press("Применить причину");
    await at.settled();
    expect(screen.getByText("Причина: Утеряна")).toBeTruthy();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(rows(at.db, "SELECT reason FROM wh_sessions")).toEqual([{ reason: "lost" }]);
    expect(rows(at.db, "SELECT reason FROM wh_jobs")).toEqual([{ reason: "lost" }]);
    await at.press("Шаблоны");
    await at.press("Паллеты");
    await at.press("Применить шаблоны");
    await at.settled();
    expect(
      rows(at.db, "SELECT unit_template_id, box_template_id, pallet_template_id FROM wh_sessions"),
    ).toHaveLength(1);
  });

  it("does not finish while a label waits, and says so", async () => {
    const at = await startedWarehouse({ answer: UNKNOWN_ANSWER });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Неизвестно, вышла ли этикетка/);
    await at.press("Завершить сеанс");
    expect(screen.getByText("Этикеток передано на принтер: 0", { exact: false })).toBeTruthy();
    await at.press("Завершить");
    expect(await screen.findByText("Сначала решите незавершённую печать.")).toBeTruthy();
    expect(at.props.onLeave).not.toHaveBeenCalled();
    expect(rows(at.db, "SELECT finished_at FROM wh_sessions")).toEqual([{ finished_at: null }]);
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
    expect(screen.getByText("Этикеток передано на принтер: 0")).toBeTruthy();
    expect(screen.queryByText(/Записи ждут отправки на хост/)).toBeNull();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText("Этикеток передано на принтер: 1")).toBeTruthy();
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
    expect(
      screen.getByText(
        "Нет связи с хостом: коды искать нельзя, пока она не вернётся. Начатую печать решить можно.",
      ),
    ).toBeTruthy();
    at.rerender({ online: true });
    expect(screen.queryByText(/коды искать нельзя, пока она не вернётся/)).toBeNull();
    await at.scan(BOX_SSCC);
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });

  it("still decides a label it holds: a retry of a failed job needs no host", async () => {
    const at = await startedWarehouse({ assignments: NO_PRINTERS, lookup: FOUND_BOX });
    await at.scan(BOX_SSCC);
    await screen.findByText("Задание: не отправлено");
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    at.rerender({ online: false });
    await at.press("Повторить отправку");
    expect(await screen.findByText("Задание: передано на принтер")).toBeTruthy();
  });
});
