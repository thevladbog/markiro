import { buildDefaultLabelTemplates } from "@markiro/domain";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createKeyboardWedgeSource, type ScanSource } from "../src/floor/scan-source.js";
import type { LocalExecutor } from "../src/local/executor.js";
import type { WarehouseLookupResult } from "../src/host/protocol.js";
import { drawLabel } from "../src/office/templates/label-renderer.js";
import type { LabelCanvas } from "../src/office/templates/label-renderer.js";
import type { LabelRendering } from "../src/office/templates/label-rendering.js";
import { labelSampleData } from "../src/office/templates/label-samples.js";
import { PAIRING } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { quietLabelRendering } from "./support/office.js";
import { setUpPrinting, ZEBRA } from "./support/printing.js";
import {
  BOX_SOURCE,
  BOX_SSCC,
  BOX_TEMPLATE,
  PALLET_SSCC,
  PALLET_TEMPLATE,
  seedWarehouseCopies,
} from "./support/warehouse.js";
import {
  OPERATOR_ID,
  PRESS_PAUSE_MS,
  renderWarehouse,
  rows,
  startedWarehouse,
} from "./support/warehouse-screen.js";

const NOT_SENT_ANSWER = async () => ({ sent: false as const, code: "not_sent" as const });

/** Every button on the screen is a floor one (64 px, `size="floor"`). */
function allFloorSized() {
  const buttons = screen.getAllByRole("button");
  expect(buttons.length).toBeGreaterThan(0);
  // The kit's own controls (the keypad's keys, the journal's segments) are floor-sized by their sheet.
  const kit = ["mk-btn--floor", "floor-keypad__key", "floor-segmented__option"];
  for (const button of buttons) {
    expect(
      kit.some((name) => button.className.includes(name)),
      button.outerHTML,
    ).toBe(true);
  }
}

describe("the guard against a second tap", () => {
  it("ignores the tap that lands on a new view for 400 ms, and takes it from 400 ms on", async () => {
    const at = await startedWarehouse({ answer: NOT_SENT_ANSWER });
    at.clock.now += 5000;
    await at.scan(BOX_SSCC);
    await screen.findByText(/Этикетка не отправлена/);
    // The finger that tapped «Отправить» lands on «Повторить отправку» of the job just failed.
    await at.pressAtOnce("Повторить отправку");
    at.clock.now += 399;
    await at.pressAtOnce("Повторить отправку");
    expect(at.shell.sends).toHaveLength(1);
    at.clock.now += 1;
    await at.pressAtOnce("Повторить отправку");
    expect(at.shell.sends).toHaveLength(2);
  });

  it("holds the button that a job's new state puts under the finger, the same job", async () => {
    let answers = 0;
    const at = await startedWarehouse({
      answer: async () => {
        answers += 1;
        return answers === 1 ? { sent: false, code: "not_sent" } : { sent: true };
      },
    });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Этикетка не отправлена/);
    // The retry's tap is a deliberate one; its result puts «Напечатать ещё раз» where it was.
    await at.press("Повторить отправку");
    await screen.findByText(/Этикетка передана на принтер/);
    await at.pressAtOnce("Напечатать ещё раз");
    expect(screen.queryByRole("heading", { name: "Причина новой попытки" })).toBeNull();
    await at.press("Напечатать ещё раз");
    expect(screen.getByRole("heading", { name: "Причина новой попытки" })).toBeTruthy();
  });

  it("holds every kind of button of the screen, the leave too", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    // The setup has just appeared: a reason, the templates and the leave wait.
    await at.pressAtOnce("Повреждена");
    expect(screen.getByRole("radio", { name: "Повреждена" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await at.pressAtOnce("Изменить: Коды единиц");
    expect(screen.queryByLabelText("Поиск шаблона")).toBeNull();
    await at.pressAtOnce("К сменам");
    expect(at.props.onLeave).not.toHaveBeenCalled();
    await at.press("Повреждена");
    expect(screen.getByRole("radio", { name: "Повреждена" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // The session starts, and the working view holds its own.
    await at.press("Начать перепечатку");
    for (const name of [
      "Ввести код вручную",
      "Причина: Повреждена",
      "Завершить сеанс",
      "К сменам",
    ]) {
      await at.pressAtOnce(name);
    }
    expect(screen.queryByLabelText(/Номер короба или паллеты/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Причина новой попытки" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Завершить сеанс перепечатки?" })).toBeNull();
    expect(at.props.onLeave).not.toHaveBeenCalled();
    // A panel just opened holds its buttons too.
    await at.press("Завершить сеанс");
    await at.pressAtOnce("Завершить");
    expect(at.props.onLeave).not.toHaveBeenCalled();
    await at.pressAtOnce("Отмена");
    expect(screen.getByRole("heading", { name: "Завершить сеанс перепечатки?" })).toBeTruthy();
  });

  it("holds the submit of the typed code, and takes it when the pause has passed", async () => {
    const at = await startedWarehouse();
    await at.press("Ввести код вручную");
    fireEvent.change(screen.getByLabelText(/Номер короба или паллеты/), {
      target: { value: BOX_SSCC },
    });
    await at.pressAtOnce("Найти и напечатать");
    expect(at.lookup).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Номер короба или паллеты/)).toBeTruthy();
    await at.press("Найти и напечатать");
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });

  it("holds the picker's buttons after another kind of label is chosen", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Изменить: Коды единиц");
    await at.press("Паллеты");
    await at.pressAtOnce("Применить шаблоны");
    expect(screen.getByLabelText("Поиск шаблона")).toBeTruthy();
    await at.press("Применить шаблоны");
    expect(screen.queryByLabelText("Поиск шаблона")).toBeNull();
  });

  it("holds the check by a scan and its cancelling alike: each is a new view", async () => {
    const at = await startedWarehouse({
      answer: async () => ({ sent: false, code: "outcome_unknown" }),
    });
    await at.scan(BOX_SSCC);
    await screen.findByText(/Неизвестно, вышла ли этикетка/);
    await at.press("Проверить сканом");
    await at.pressAtOnce("Отменить проверку");
    expect(screen.getByText("Отсканируйте новую этикетку")).toBeTruthy();
    await at.press("Отменить проверку");
    expect(screen.queryByText("Отсканируйте новую этикетку")).toBeNull();
  });

  it("puts the focus on the view, never on a button, when the view changes", async () => {
    const at = await startedWarehouse();
    await at.press("Завершить сеанс");
    const focused = document.activeElement;
    expect(focused?.getAttribute("tabindex")).toBe("-1");
    expect(focused?.tagName).not.toBe("BUTTON");
  });
});

describe("work in hand", () => {
  it("lets no other action start while a code is looked up, and leaves the leave free", async () => {
    let release: (result: WarehouseLookupResult) => void = () => undefined;
    const at = await startedWarehouse({
      lookup: () =>
        new Promise<WarehouseLookupResult>((resolve) => {
          release = resolve;
        }),
    });
    await act(async () => {
      at.scanner.emit(BOX_SSCC);
    });
    await waitFor(() => expect(at.lookup).toHaveBeenCalledTimes(1));
    at.clock.now += PRESS_PAUSE_MS;
    const finish = screen.getByRole("button", { name: "Завершить сеанс" });
    await waitFor(() => expect(finish.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(finish);
    expect(screen.queryByRole("heading", { name: "Завершить сеанс перепечатки?" })).toBeNull();
    // The leave is never held by work: the floor's own leave waits for it.
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    expect(at.props.onLeave).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ status: "found", source: BOX_SOURCE });
      await at.gate.drain();
    });
    // The label is found and sent: its detail's answer is no longer held by work.
    expect(
      (await screen.findByRole("button", { name: "Следующий код" })).getAttribute("aria-disabled"),
    ).toBe(null);
  });

  // Final review of plan СКЛ, m4: the typed code goes through the same queue and the same
  // tracking as a scan, so a leave waits for its lookup and print.
  it("holds a typed code's lookup as work in hand, and a leave's drain waits for it", async () => {
    let release: (result: WarehouseLookupResult) => void = () => undefined;
    const at = await startedWarehouse({
      lookup: () =>
        new Promise<WarehouseLookupResult>((resolve) => {
          release = resolve;
        }),
    });
    await at.press("Ввести код вручную");
    fireEvent.change(screen.getByLabelText(/Номер короба или паллеты/), {
      target: { value: BOX_SSCC },
    });
    const touches = vi.mocked(at.props.touch).mock.calls.length;
    await act(async () => {
      at.clock.now += PRESS_PAUSE_MS;
      fireEvent.click(screen.getByRole("button", { name: "Найти и напечатать" }));
    });
    await waitFor(() => expect(at.lookup).toHaveBeenCalledWith({ sscc: BOX_SSCC }));
    expect(at.gate.pending()).toBeGreaterThan(0);
    expect(vi.mocked(at.props.touch).mock.calls.length).toBeGreaterThan(touches);
    at.clock.now += PRESS_PAUSE_MS;
    const finish = screen.getByRole("button", { name: "Завершить сеанс" });
    await waitFor(() => expect(finish.getAttribute("aria-disabled")).toBe("true"));
    let drained = false;
    const draining = at.gate.drain().then(() => {
      drained = true;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(drained).toBe(false);
    await act(async () => {
      release({ status: "found", source: BOX_SOURCE });
      await draining;
    });
    expect(drained).toBe(true);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(at.gate.pending()).toBe(0);
  });

  it("runs scans one at a time: a second scan waits for the first one's print", async () => {
    const at = await startedWarehouse();
    at.shell.holdSends();
    await act(async () => {
      at.scanner.emit(BOX_SSCC);
      at.scanner.emit(PALLET_SSCC);
    });
    await waitFor(() => expect(at.shell.sends).toHaveLength(1));
    expect(at.lookup).toHaveBeenCalledTimes(1);
    await act(async () => {
      at.shell.releaseSend({ sent: true });
      await at.gate.drain();
    });
    // The second scan found the first job decided and a new code: it was looked up in its turn.
    expect(at.lookup).toHaveBeenCalledTimes(2);
  });

  it("starts no work and takes no scan once a leave is asked for", async () => {
    const at = await startedWarehouse();
    at.rerender({ isLeaving: () => true });
    await at.scan(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
    expect(at.shell.sends).toHaveLength(0);
  });

  it("tells the floor the operator is at work on every scan and every press", async () => {
    const at = await startedWarehouse();
    const before = vi.mocked(at.props.touch).mock.calls.length;
    await at.scan(BOX_SSCC);
    expect(vi.mocked(at.props.touch).mock.calls.length).toBeGreaterThan(before);
    const afterScan = vi.mocked(at.props.touch).mock.calls.length;
    await at.press("Следующий код");
    expect(vi.mocked(at.props.touch).mock.calls.length).toBeGreaterThan(afterScan);
  });

  it("hands the delivery its record even when the screen is gone before the print ends", async () => {
    const at = await startedWarehouse();
    at.shell.holdSends();
    await act(async () => {
      at.scanner.emit(BOX_SSCC);
    });
    await waitFor(() => expect(at.shell.sends).toHaveLength(1));
    vi.mocked(at.props.onRecorded).mockClear();
    at.view.unmount();
    await act(async () => {
      at.shell.releaseSend({ sent: true });
      await at.gate.drain();
    });
    expect(at.props.onRecorded).toHaveBeenCalled();
    expect(rows(at.db, "SELECT state FROM wh_jobs")).toEqual([{ state: "sent" }]);
  });

  it("hands the delivery the record of a retry too, when the screen is gone before it ends", async () => {
    const at = await startedWarehouse({
      assignments: { box: null, pallet: null, duplicate: null },
    });
    await at.scan(BOX_SSCC);
    await screen.findByText("Принтер не назначен");
    await setUpPrinting(at.local, { assignments: { box: "zebra", pallet: null, duplicate: null } });
    at.shell.holdSends();
    at.clock.now += PRESS_PAUSE_MS;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    });
    await waitFor(() => expect(at.shell.sends).toHaveLength(1));
    vi.mocked(at.props.onRecorded).mockClear();
    at.view.unmount();
    await act(async () => {
      at.shell.releaseSend({ sent: true });
      await at.gate.drain();
    });
    expect(at.props.onRecorded).toHaveBeenCalled();
    expect(rows(at.db, "SELECT state, attempts FROM wh_jobs")).toEqual([
      { state: "sent", attempts: 1 },
    ]);
  });

  it("hands a refused key of the host to the shell even when the screen is gone", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const at = await startedWarehouse({
      lookup: () =>
        new Promise<WarehouseLookupResult>((_resolve, reject) => {
          fail = reject;
        }),
    });
    await act(async () => {
      at.scanner.emit(BOX_SSCC);
    });
    await waitFor(() => expect(at.lookup).toHaveBeenCalledTimes(1));
    at.view.unmount();
    const { HostError } = await import("../src/host/client.js");
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      message: "unauthorized",
      details: { credential: "device" },
    });
    await act(async () => {
      fail(refused);
      await at.gate.drain();
    });
    expect(at.props.onHostError).toHaveBeenCalledWith(refused);
  });

  it("does not reload the session when its parent passes new functions", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Повреждена");
    at.rerender({
      onRecorded: vi.fn(),
      touch: vi.fn(),
      onHostError: vi.fn(),
      track: (work) => at.gate.track(work),
      isLeaving: () => false,
    });
    await at.settled();
    expect(screen.getByRole("radio", { name: "Повреждена" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(at.props.onRecorded).not.toHaveBeenCalled();
  });

  it("shows what the computer holds when a write fails after the bytes went: unknown, never resent", async () => {
    const db = openLocalDb();
    seedWarehouseCopies(db.db);
    await setUpPrinting(db.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    let failing = false;
    const flaky: LocalExecutor = {
      ...db.executor,
      transaction: async (statements) => {
        if (failing && statements.length === 2) {
          failing = false;
          throw new Error("disk");
        }
        return db.executor.transaction(statements);
      },
    };
    const at = await startedWarehouse({
      seeded: { db: db.db, executor: flaky },
      overrides: { local: flaky },
      answer: async () => {
        failing = true;
        return { sent: true };
      },
    });
    vi.mocked(at.props.onRecorded).mockClear();
    await at.scan(BOX_SSCC);
    expect(await screen.findByRole("button", { name: "Проверить сканом" })).toBeTruthy();
    // The failed settle wrote no record, the recovery wrote one: the delivery is told once.
    expect(at.props.onRecorded).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    expect(screen.queryByText(/Ничего не напечатано/)).toBeNull();
    expect(at.shell.sends).toHaveLength(1);
    expect(rows(db.db, "SELECT state, error_code FROM wh_jobs")).toEqual([
      { state: "unknown", error_code: "interrupted" },
    ]);
  });

  it("says a write that failed before any byte left as nothing printed", async () => {
    const db = openLocalDb();
    seedWarehouseCopies(db.db);
    await setUpPrinting(db.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    const broken: LocalExecutor = {
      ...db.executor,
      transaction: async (statements) => {
        if (statements.some((statement) => statement.sql.startsWith("INSERT INTO wh_jobs"))) {
          throw new Error("disk");
        }
        return db.executor.transaction(statements);
      },
    };
    const at = await startedWarehouse({
      seeded: { db: db.db, executor: broken },
      overrides: { local: broken },
    });
    await at.scan(BOX_SSCC);
    expect(
      await screen.findByText(
        "Не удалось записать задание на этом компьютере. Ничего не напечатано.",
      ),
    ).toBeTruthy();
    expect(at.shell.sends).toHaveLength(0);
  });
});

describe("the keyboard and the scanner", () => {
  function wedge() {
    const real = createKeyboardWedgeSource(window);
    const calls: boolean[] = [];
    const source: ScanSource = {
      ...real,
      setManualTextEntryActive(active) {
        calls.push(active);
        real.setManualTextEntryActive(active);
      },
    };
    const type = async (text: string) => {
      await act(async () => {
        for (const key of text) fireEvent.keyDown(window, { key });
        fireEvent.keyDown(window, { key: "Enter" });
      });
    };
    return { source, calls, type };
  }

  it("reads a scan of the real keyboard wedge, but not the keys typed into the open form", async () => {
    const keys = wedge();
    const at = await startedWarehouse({ source: keys.source });
    await keys.type(BOX_SSCC);
    await waitFor(() => expect(at.lookup).toHaveBeenCalledTimes(1));
    await at.settled();
    await at.press("Следующий код");
    await at.press("Ввести код вручную");
    expect(keys.calls.at(-1)).toBe(true);
    await keys.type(PALLET_SSCC);
    await at.settled();
    expect(at.lookup).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText(/Номер короба или паллеты/), { key: "Escape" });
    expect(keys.calls.at(-1)).toBe(false);
    await keys.type(PALLET_SSCC);
    await waitFor(() => expect(at.lookup).toHaveBeenCalledTimes(2));
  });

  it("gives the keyboard back when the screen goes with the typed-code form open", async () => {
    const keys = wedge();
    const at = await startedWarehouse({ source: keys.source });
    await at.press("Ввести код вручную");
    expect(keys.calls.at(-1)).toBe(true);
    at.view.unmount();
    expect(keys.calls.at(-1)).toBe(false);
    await keys.type(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
  });

  it("takes the search of the picker for the keyboard's: given back on blur and when the picker goes", async () => {
    const keys = wedge();
    const at = await startedWarehouse({ source: keys.source });
    await at.press("Шаблоны");
    const search = screen.getByLabelText("Поиск шаблона");
    fireEvent.focus(search);
    expect(keys.calls.at(-1)).toBe(true);
    await keys.type(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
    fireEvent.blur(search);
    expect(keys.calls.at(-1)).toBe(false);
    fireEvent.focus(search);
    expect(keys.calls.at(-1)).toBe(true);
    at.view.unmount();
    expect(keys.calls.at(-1)).toBe(false);
  });

  it("takes no scan while a panel is open, and the code is not looked up later", async () => {
    const at = await startedWarehouse();
    await at.press("Завершить сеанс");
    await at.scan(BOX_SSCC);
    await at.press("Отмена");
    await at.settled();
    expect(at.lookup).not.toHaveBeenCalled();
  });

  it("takes no scan before the session is started", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.scanner.listening();
    await at.scan(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
    expect(screen.queryByText(/Не удалось записать/)).toBeNull();
  });
});

describe("the templates of the picker", () => {
  const NARROW = "d1d1d1d1-0000-4000-8000-000000000009";

  /** A recording 2D context: what the preview draws. */
  function recordingCanvas(): LabelCanvas & { ops: (string | number)[][] } {
    const ops: (string | number)[][] = [];
    return {
      ops,
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      textBaseline: "alphabetic",
      textAlign: "start",
      clearRect(x, y, w, h) {
        ops.push(["clearRect", x, y, w, h]);
      },
      fillRect() {
        ops.push(["fillRect", String(this.fillStyle)]);
      },
      strokeRect: () => undefined,
      fillText(text) {
        ops.push(["fillText", text]);
      },
      measureText: (text) => ({ width: text.length * 10 }),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
    };
  }

  async function stationWithTwoBoxTemplates() {
    const station = openLocalDb();
    seedWarehouseCopies(station.db);
    const [box] = buildDefaultLabelTemplates();
    if (box === undefined) throw new Error("stock templates missing");
    station.db
      .prepare(
        "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
          "VALUES (?, 'Коробка узкая', 'box', 1, NULL, 0, ?, 5)",
      )
      .run(NARROW, JSON.stringify({ ...box.spec, widthMm: 40 }));
    await setUpPrinting(station.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    return { station, box };
  }

  it("previews the chosen template with the sample data of its purpose, and the one chosen after it", async () => {
    const { station, box } = await stationWithTwoBoxTemplates();
    const canvas = recordingCanvas();
    const labels: LabelRendering = { ...quietLabelRendering(), context: () => canvas };
    const at = await renderWarehouse({ seeded: station, labels });
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Изменить: Коды единиц");
    // The picker opens on the units; the preview of the boxes is what comes after.
    canvas.ops.length = 0;
    await at.press("Короба");
    const reference = (widthMm: number) => {
      const target = recordingCanvas();
      const scale = Math.min(280 / widthMm, 280 / box.spec.heightMm);
      drawLabel({ ...box.spec, widthMm }, target, scale, labelSampleData("box"), {});
      return target.ops;
    };
    await waitFor(() => expect(canvas.ops).toEqual(reference(box.spec.widthMm)));
    expect(screen.getByText(/Образец: данные примерные/)).toBeTruthy();
    canvas.ops.length = 0;
    await at.press(/Коробка узкая/);
    await waitFor(() => expect(canvas.ops).toEqual(reference(40)));
    expect(screen.getByText(/Коробка узкая · 40 × /, { selector: "figcaption" })).toBeTruthy();
  });

  it("writes the chosen template into the session, and prints with it", async () => {
    const { station } = await stationWithTwoBoxTemplates();
    const at = await renderWarehouse({ seeded: station });
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Изменить: Коды единиц");
    await at.press("Короба");
    await at.press(/Коробка узкая/);
    // Another kind is looked at and chosen; the boxes' choice stays.
    await at.press("Паллеты");
    await at.press(/Палета 100×150/);
    await at.press("Короба");
    expect(screen.getByRole("button", { name: /Коробка узкая/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await at.press("Применить шаблоны");
    expect(screen.getByText(`«Коробка узкая» · ${ZEBRA.name}`)).toBeTruthy();
    expect(screen.getByText(`«Палета 100×150» · ${ZEBRA.name}`)).toBeTruthy();
    await at.press("Повреждена");
    await at.press("Начать перепечатку");
    await at.scanner.listening();
    await at.scan(BOX_SSCC);
    await screen.findByText(/Этикетка передана на принтер/);
    expect(rows(station.db, "SELECT box_template_id FROM wh_sessions")).toEqual([
      { box_template_id: NARROW },
    ]);
    expect(rows(station.db, "SELECT template_id FROM wh_jobs")).toEqual([{ template_id: NARROW }]);
    expect(at.shell.sends[0]?.text).toContain("40x");
    expect(at.shell.sends[0]?.text).not.toContain(BOX_TEMPLATE);
  });

  it("starts the search again for another kind of label", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Изменить: Коды единиц");
    await at.press("Короба");
    fireEvent.change(screen.getByLabelText("Поиск шаблона"), { target: { value: "нет такого" } });
    expect(screen.getByText("По этому запросу шаблонов нет.")).toBeTruthy();
    await at.press("Паллеты");
    expect((screen.getByLabelText("Поиск шаблона") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("По этому запросу шаблонов нет.")).toBeNull();
    expect(screen.getByRole("button", { name: /Палета 100×150/ })).toBeTruthy();
  });

  it("previews nothing for a template that is not of the kind looked at", async () => {
    const station = openLocalDb();
    seedWarehouseCopies(station.db);
    await setUpPrinting(station.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    // A session whose box template is, by now, a pallet's.
    station.db
      .prepare(
        "INSERT INTO wh_sessions (id, host_id, device_id, reason, unit_template_id, box_template_id, " +
          "pallet_template_id, started_by, started_at, updated_at) " +
          "VALUES ('s1', ?, ?, 'lost', NULL, ?, NULL, ?, '2026-10-09T06:00:00.000Z', '2026-10-09T06:00:00.000Z')",
      )
      .run(PAIRING.hostId, PAIRING.deviceId, PALLET_TEMPLATE, OPERATOR_ID);
    const canvas = recordingCanvas();
    const labels: LabelRendering = { ...quietLabelRendering(), context: () => canvas };
    const at = await renderWarehouse({ seeded: station, labels });
    await screen.findByText(/Продолжен незавершённый сеанс/);
    await at.press("Шаблоны");
    await at.press("Короба");
    expect(screen.getByText("Выберите шаблон для предпросмотра.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Коробка 58×40/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("keeps the session's templates when the choice is cancelled", async () => {
    const { station } = await stationWithTwoBoxTemplates();
    const at = await startedWarehouse({ seeded: station });
    await at.press("Шаблоны");
    await at.press("Короба");
    await at.press(/Коробка узкая/);
    await at.press("Отмена");
    // The choice was cancelled: the session's box template is still the one it started with.
    await at.press("Шаблоны");
    await at.press("Короба");
    expect(screen.getByRole("button", { name: /Коробка 58×40/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /Коробка узкая/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await at.press("Отмена");
    expect(rows(station.db, "SELECT box_template_id FROM wh_sessions")).toEqual([
      { box_template_id: BOX_TEMPLATE },
    ]);
  });

  it("says a kind with no enabled template has none, and a code of that kind asks for one", async () => {
    const station = openLocalDb();
    seedWarehouseCopies(station.db);
    station.db.prepare("UPDATE ref_templates SET enabled = 0 WHERE purpose = 'pallet'").run();
    await setUpPrinting(station.executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    const at = await renderWarehouse({
      seeded: station,
      lookup: async (): Promise<WarehouseLookupResult> => ({
        status: "found",
        source: { ...BOX_SOURCE, kind: "pallet", identity: PALLET_SSCC, sscc: PALLET_SSCC },
      }),
    });
    expect(await screen.findByText(/шаблон не выбран/)).toBeTruthy();
    await at.press("Изменить: Паллеты");
    expect(
      screen.getByText("Нет включённых шаблонов этого назначения. Добавьте шаблон в офисе."),
    ).toBeTruthy();
    await at.press("Отмена");
    await at.press("Повреждена");
    await at.press("Начать перепечатку");
    await at.scanner.listening();
    await at.scan(PALLET_SSCC);
    expect(
      await screen.findByText("Не выбран шаблон для этого типа этикетки. Нажмите «Шаблоны»."),
    ).toBeTruthy();
    expect(at.shell.sends).toHaveLength(0);
  });
});

describe("what a waiting label and an empty field keep", () => {
  it("keeps the templates while a label waits for the operator", async () => {
    const at = await startedWarehouse({
      assignments: { box: null, pallet: null, duplicate: null },
    });
    await at.scan(BOX_SSCC);
    await screen.findByText("Принтер не назначен");
    // The label's detail has the label's own answers: the templates are not offered beside them.
    expect(screen.queryByRole("button", { name: "Шаблоны" })).toBeNull();
    expect(screen.queryByLabelText("Поиск шаблона")).toBeNull();
  });

  it("sends an empty typed code nowhere: the field stays", async () => {
    const at = await startedWarehouse();
    await at.press("Ввести код вручную");
    await act(async () => {
      fireEvent.submit(
        screen.getByLabelText(/Номер короба или паллеты/).closest("form") as Element,
      );
      await at.gate.drain();
    });
    expect(screen.getByLabelText(/Номер короба или паллеты/)).toBeTruthy();
    expect(at.lookup).not.toHaveBeenCalled();
  });
});

describe("what the operator can reach", () => {
  it("keeps every button at the floor's 64 px on every view", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    allFloorSized();
    await at.press("Изменить: Коды единиц");
    allFloorSized();
    await at.press("Отмена");
    await at.press("Повреждена");
    await at.press("Начать перепечатку");
    allFloorSized();
    await at.press("Ввести код вручную");
    allFloorSized();
    await at.press("Отмена");
    await at.press("Причина: Повреждена");
    allFloorSized();
    await at.press("Отмена");
    await at.press("Завершить сеанс");
    allFloorSized();
  });

  it("names the state of the job in words next to the label, and the chosen reason in words", async () => {
    const at = await startedWarehouse();
    expect(screen.getByText("Причина: Повреждена")).toBeTruthy();
    await at.scan(BOX_SSCC);
    expect(await screen.findByLabelText("Короб")).toBeTruthy();
    expect(screen.getByText(/Этикетка передана на принтер/)).toBeTruthy();
    // The reason is told in words beside the label, and is no longer a choice in the detail.
    expect(screen.getByText("Причина: Повреждена")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Повреждена" })).toBeNull();
  });

  it("marks the chosen reason as pressed, not by colour alone", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Утеряна");
    // Chosen is a fill and a tick in the row (a radio of its group), not colour alone.
    expect(screen.getByRole("radio", { name: "Утеряна" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Повреждена" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByRole("radiogroup", { name: "Причина перепечатки" })).toBeTruthy();
  });
});
