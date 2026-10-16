import { buildSscc, formatSsccHri, type LabelTemplateSpec, type MonoBitmap } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import { createPrintRuntime, type PrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { saveWorkstationSettings } from "../src/floor/setup/workstation-settings.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { CodeCheck, SsccBlockRequest } from "../src/host/protocol.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import { km, OPERATOR_ID, PAIRING, PREFIX, rows, scanContext } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  FIRST_SSCC,
  flushPromises,
  jobRows,
  manualRuntime,
  printStation,
  renderedText,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const SECOND_SSCC = buildSscc(0, PREFIX, 1501);
/** Longer than the panel's guard after a view change. */
const PRESS_PAUSE_MS = 1000;

/** A scanner the test reads codes into. */
function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

type Station = Awaited<ReturnType<typeof printStation>>;

interface Options {
  shell?: ReturnType<typeof fakeHardware>;
  runtime?: PrintRuntime;
  onSetup?: () => void;
  onLeave?: () => void;
  /** The floor has begun to leave (a ref's value, answered at once). */
  isLeaving?: () => boolean;
  /** How a label is rendered; the rendering of the fake printers by default. */
  render?: WorkScreenProps["render"];
  /** The screen's own rendering (the shift's snapshot, with its logo) instead of the fake printers'. */
  ownRender?: boolean;
}

/** The work screen over `at`, printing through `shell` (a printer that takes every label by default). */
function work(at: Station, options: Options = {}) {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = options.shell ?? fakeHardware();
  const runtime = options.runtime ?? manualRuntime(shell.hardware).runtime;
  const power = vi.fn(async (_awake: boolean) => undefined);
  // The panel's clock: a press waits out the guard after a view change only when the test lets time pass.
  const clock = { now: 0 };
  const props: WorkScreenProps = {
    shift: at.shift,
    operator: SESSION,
    pairing: PAIRING,
    local: at.local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: options.onLeave ?? vi.fn(),
    leaving: false,
    source: scanner.source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    })),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: runtime,
    awake: createSystemAwake(power),
    labelClock: () => clock.now,
    ...(options.ownRender === true
      ? {}
      : {
          render:
            options.render ??
            (async (spec, fields, printer) => {
              const text = renderedText(printer, fields.sscc, `${spec.widthMm}x${spec.heightMm}`);
              const bytes = new Uint8Array(text.length);
              for (let index = 0; index < text.length; index += 1) {
                bytes[index] = text.charCodeAt(index);
              }
              return bytes;
            }),
        }),
    ...(options.onSetup === undefined ? {} : { onSetup: options.onSetup }),
    ...(options.isLeaving === undefined ? {} : { isLeaving: options.isLeaving }),
  };
  const view = render(
    <ThemeProvider>
      <WorkScreen {...props} />
    </ThemeProvider>,
  );
  return {
    view,
    gate,
    props,
    scanner,
    shell,
    power,
    clock,
    settled: () =>
      act(async () => {
        await gate.drain();
      }),
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
        await gate.drain();
      }),
    press: (name: string) =>
      act(async () => {
        // An operator's deliberate press, well after the view appeared.
        clock.now += PRESS_PAUSE_MS;
        fireEvent.click(screen.getByRole("button", { name }));
        await gate.drain();
      }),
  };
}

/** Twelve codes: the box fills and closes by itself. */
async function fillBox(screenWork: ReturnType<typeof work>, prefix = "P"): Promise<void> {
  await screenWork.scanner.listening();
  await screenWork.settled();
  for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`${prefix}${index}`));
}

function lastLine(): string | null {
  return document.querySelector(".work-screen__last .work-scan-hero__detail")?.textContent ?? "";
}

function scans(at: Station): unknown {
  return rows(at.db, "SELECT count(*) AS n FROM floor_scans")[0]?.["n"];
}

describe("the label of a box the work screen closes", () => {
  it("prints before the next scan is taken, and the work goes on once the printer took it", async () => {
    const at = await printStation();
    const screenWork = work(at);
    await fillBox(screenWork);
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) },
    ]);
    expect(jobRows(at.db)).toEqual([
      expect.objectContaining({ state: "sent", attempts: 1, sscc: FIRST_SSCC }),
    ]);
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("stops at a label that failed, takes no scan, and goes on once the operator printed it again", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const, { sent: true } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByText("Принтер не принял задание: этикетка не напечатана.")).toBeTruthy();
    expect(screen.getByText(`SSCC короба: ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    // No «Этикетка напечаталась»: nothing left the computer.
    expect(screen.queryByRole("button", { name: "Этикетка напечаталась" })).toBeNull();
    await screenWork.scan(km("P12"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(scans(at)).toBe(12);
    await screenWork.press("Напечатать снова");
    expect(screenWork.shell.sends).toHaveLength(2);
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("never prints a label of an unknown outcome again by itself; again only with the operator's reason", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "outcome_unknown" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(
      screen.getByText(
        "Связь с принтером оборвалась посреди передачи. Посмотрите, вышла ли этикетка.",
      ),
    ).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    // The work screen opened again (a leave and a return) sends nothing either.
    screenWork.view.unmount();
    const again = work(at, { shell });
    await again.settled();
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    await again.press("Напечатать снова");
    expect(shell.sends).toHaveLength(1);
    expect(screen.getByText("Почему печатаете снова?")).toBeTruthy();
    await again.press("Замятие в принтере");
    expect(shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT kind, reason_code FROM floor_exceptions")).toEqual([
      { kind: "reprint", reason_code: "printer_jam" },
    ]);
    expect(screen.queryByText("Неизвестно, напечаталась ли этикетка")).toBeNull();
  });

  it("takes «Этикетка напечаталась» for an unknown one, and the check comes next when asked for", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Этикетка напечаталась");
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
    expect(shell.sends).toHaveLength(1);
  });

  it("promises only what the screen has when it asks to go on without a label: the reprint in «Исключениях»", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Продолжить без этикетки");
    const body = screen.getByText(/^Короб уже закрыт/).textContent ?? "";
    // The text sends the operator to «Исключения», and the button is on the work screen to be
    // found there once the choice is made (`floor-work-exceptions.test.tsx` prints from it).
    expect(body).toContain("«Исключениях»");
    expect(body).toContain("промаркировать");
    await screenWork.press("Назад");
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(false);
  });

  it("goes on without a label only after the operator confirms, with its record", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Продолжить без этикетки");
    expect(screen.getByText("Продолжить без этикетки?")).toBeTruthy();
    await screenWork.press("Назад");
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("prints on another printer of the settings, rendering for its language and resolution", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await screenWork.press("TSC на COM4 · TSPL · 300 dpi");
    expect(shell.sends.at(-1)).toEqual({
      target: { kind: "serial", port: "COM4", baud: 9600 },
      text: renderedText({ language: "tspl", dpi: 300 }, FIRST_SSCC),
    });
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
  });

  it("says there is no printer, and offers the setup when the floor gives one", async () => {
    const at = await printStation({ assignments: { box: null, pallet: null, duplicate: null } });
    const onSetup = vi.fn();
    const screenWork = work(at, { onSetup });
    await fillBox(screenWork);
    expect(
      screen.getByText(
        "Принтер для коробов не назначен. Назначьте его в настройке рабочего места.",
      ),
    ).toBeTruthy();
    expect(screenWork.shell.sends).toEqual([]);
    await screenWork.press("Напечатать снова");
    expect(screen.getByText("Нет принтера для этикетки: настройте принтер.")).toBeTruthy();
    await screenWork.press("Настроить принтер");
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("never holds the operator: «Выйти из смены» stays open at a label that waits", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const onLeave = vi.fn();
    const screenWork = work(at, { shell, onLeave });
    await fillBox(screenWork);
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.hasAttribute("disabled")).toBe(false);
    fireEvent.click(leave);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("the check of a printed label on the work screen", () => {
  it("takes the SSCC scan before the pipeline: another box's label is refused, the right one goes on", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const screenWork = work(at);
    await fillBox(screenWork);
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    await screenWork.scan(`]C100${SECOND_SSCC}`);
    expect(
      screen.getByText(`Это этикетка другого короба: ${formatSsccHri(SECOND_SSCC)}.`),
    ).toBeTruthy();
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    await screenWork.scan(km("P12"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку короба.")).toBeTruthy();
    // Neither scan reached the pipeline: no journal row, no code accepted.
    expect(scans(at)).toBe(12);
    await screenWork.scan(formatSsccHri(FIRST_SSCC));
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "verified" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("skips the check at once, and reprints an unreadable label with a reason", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const screenWork = work(at);
    await fillBox(screenWork);
    await screenWork.press("Напечатать снова");
    await screenWork.press("Этикетка не читается");
    expect(screenWork.shell.sends).toHaveLength(2);
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    await screenWork.press("Пропустить проверку");
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped", attempts: 2 });
  });
});

describe("a label a stop of the station left", () => {
  it("shows on entry as unknown when its send was cut, and nothing is sent", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sending', attempts = 1").run();
    const screenWork = work(at);
    await screenWork.settled();
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(screen.getByText("Печать прервалась. Посмотрите, вышла ли этикетка.")).toBeTruthy();
    expect(screen.queryByText(/перезапустились/)).toBeNull();
    expect(screenWork.shell.sends).toEqual([]);
  });

  it("is sent on entry when it was written with its box and never sent", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    const screenWork = work(at);
    await screenWork.settled();
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) },
    ]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
  });

  it("keeps the next full box open while it waits", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    // A second box the station left full: it does not close while the first label waits.
    const filling = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    for (let index = 0; index < 12; index += 1) await processScan(filling, km(`Q${index}`));
    const screenWork = work(at);
    await screenWork.settled();
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 1 },
    ]);
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    // Its turn now: the full box closes, and its label prints.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, SECOND_SSCC) },
    ]);
    expect(jobRows(at.db).map((row) => row["state"])).toEqual(["skipped", "sent"]);
  });
});

describe("a send that does not answer", () => {
  it("waits on the screen, and turns unknown when its limit runs out", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const { runtime, expire } = manualRuntime(shell.hardware);
    const screenWork = work(at, { shell, runtime });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 11; index += 1) await screenWork.scan(km(`P${index}`));
    shell.holdSends();
    await act(async () => {
      screenWork.scanner.emit(km("P11"));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending" });
    expect(screen.getByText("Этикетка отправлена на принтер…")).toBeTruthy();
    await act(async () => {
      expire();
      await screenWork.gate.drain();
    });
    expect(
      screen.getByText("Принтер не ответил вовремя. Посмотрите, вышла ли этикетка."),
    ).toBeTruthy();
    expect(screen.queryByText("Этикетка отправлена на принтер…")).toBeNull();
    shell.releaseSend({ sent: true });
    await screenWork.settled();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", error_code: "timeout" });
  });
});

describe("the computer while the work screen is open", () => {
  it("stays awake, and may sleep once the screen goes", async () => {
    const at = await printStation();
    const screenWork = work(at);
    await screenWork.settled();
    await waitFor(() => expect(screenWork.power.mock.calls).toEqual([[true]]));
    screenWork.view.unmount();
    await waitFor(() => expect(screenWork.power.mock.calls).toEqual([[true], [false]]));
  });
});

/** A local database whose transactions and reads go through the hooks, as a failing disk's would. */
function around(
  local: LocalExecutor,
  hooks: {
    transaction?: (
      statements: readonly LocalStatement[],
      run: () => Promise<number[]>,
    ) => Promise<number[]>;
    query?: (sql: string) => Error | null;
  },
): LocalExecutor {
  return {
    query: (sql, params, row) => {
      const failure = hooks.query?.(sql) ?? null;
      return failure === null ? local.query(sql, params, row) : Promise.reject(failure);
    },
    transaction: (statements) =>
      hooks.transaction === undefined
        ? local.transaction(statements)
        : hooks.transaction(statements, () => local.transaction(statements)),
  };
}

/** The transaction of a box's close: its first statement spends the block's serial. */
function isClose(statements: readonly LocalStatement[]): boolean {
  return statements[0]?.sql.startsWith("UPDATE floor_sscc_blocks SET next_serial") === true;
}

/** The write that marks a job `sending`, before the bytes go. */
function marksSending(statements: readonly LocalStatement[]): boolean {
  return statements[0]?.sql.startsWith("UPDATE floor_print_jobs SET state = 'sending'") === true;
}

/** The write of where a send ended. */
function endsSend(statements: readonly LocalStatement[]): boolean {
  return (
    statements[0]?.sql.startsWith("UPDATE floor_print_jobs SET state = ?, error_code = ?") === true
  );
}

const MIDDLE_FAILED = "Этикетка короба не напечатана";
const UNKNOWN_TITLE = "Неизвестно, напечаталась ли этикетка";
const STALLED_TITLE = "Итог отправки этикетки не записан";

/** The alerts' polite region of the screen, there from the first paint. */
function alertsRegion(): Element {
  const region = document.querySelector(".work-screen__alerts");
  if (region === null) throw new Error("the alerts' region is not on the screen");
  return region;
}

/** A label whose first send answered `outcome_unknown`: the panel of an unknown outcome stands. */
async function unknownLabel(options: Options = {}, station?: Station) {
  const at = station ?? (await printStation());
  const answers = [{ sent: false, code: "outcome_unknown" } as const];
  const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
  const screenWork = work(at, { shell, ...options });
  await fillBox(screenWork);
  expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
  return { at, shell, screenWork };
}

describe("a close whose answer did not come back, and its label", () => {
  it("prints the label of a box that was written but reported as changed, found closed on the retry", async () => {
    const at = await printStation();
    let reporting = true;
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const done = await run();
        if (reporting && isClose(statements)) {
          reporting = false;
          // Committed, and reported as a lost comparison: the retry finds no open box.
          throw new LocalDbError("changes_mismatch", "reported as changed");
        }
        return done;
      },
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screen.queryByText("Короб не закрыт")).toBeNull();
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) },
    ]);
    expect(jobRows(at.db)).toEqual([expect.objectContaining({ state: "sent", attempts: 1 })]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("prints the label of a box whose close threw after it was written, once the operator retries", async () => {
    const at = await printStation();
    let losing = true;
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const done = await run();
        if (losing && isClose(statements)) throw new LocalDbError("statement_failed", "lost");
        return done;
      },
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screen.getByText("Короб не закрыт")).toBeTruthy();
    // Written with its box, not sent: the job waits for its first send.
    expect(jobRows(at.db)).toEqual([expect.objectContaining({ state: "prepared", attempts: 0 })]);
    expect(screenWork.shell.sends).toEqual([]);
    losing = false;
    await screenWork.press("Повторить");
    expect(screenWork.shell.sends).toHaveLength(1);
    expect(jobRows(at.db)).toEqual([expect.objectContaining({ state: "sent", attempts: 1 })]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs")).toEqual([{ n: 1 }]);
  });
});

describe("a label settled beside another stop of the line", () => {
  it("prints the label of the box read back and leaves the message of the failed retry standing", async () => {
    const at = await printStation();
    let losing = true;
    let hiccup = false;
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const done = await run();
        if (losing && isClose(statements)) throw new LocalDbError("statement_failed", "lost");
        return done;
      },
      query: (sql) =>
        hiccup && sql.startsWith("SELECT id, opened_at, item_count FROM floor_boxes")
          ? new LocalDbError("statement_failed", "disk")
          : null,
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screen.getByText("Короб не закрыт")).toBeTruthy();
    losing = false;
    hiccup = true;
    await screenWork.press("Повторить");
    // The box was read back and its label went; the read of the next box failed, and the line says so.
    expect(screenWork.shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(screen.getByText("Короб не закрыт")).toBeTruthy();
    hiccup = false;
    await screenWork.press("Повторить");
    expect(screen.queryByText("Короб не закрыт")).toBeNull();
    expect(screenWork.shell.sends).toHaveLength(1);
  });
});

describe("what the screen hands to the floor's gate", () => {
  it("hands the send of a label to the gate before the bytes go", async () => {
    const at = await printStation();
    let pending = () => 0;
    const seen: number[] = [];
    const shell = fakeHardware(async () => {
      seen.push(pending());
      return { sent: true };
    });
    const screenWork = work(at, { shell });
    pending = () => screenWork.gate.pending();
    await fillBox(screenWork);
    expect(shell.sends).toHaveLength(1);
    // The close that sent it was already the gate's work when the bytes went.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("makes the leave wait for a label on its way to the printer", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const screenWork = work(at, { shell });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 11; index += 1) await screenWork.scan(km(`P${index}`));
    shell.holdSends();
    await act(async () => {
      screenWork.scanner.emit(km("P11"));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    let left = false;
    void screenWork.gate.drain().then(() => {
      left = true;
    });
    await act(async () => {
      await flushPromises();
    });
    // The floor's leave would wait: the printer has not answered.
    expect(left).toBe(false);
    expect(screenWork.gate.pending()).toBeGreaterThan(0);
    await act(async () => {
      shell.releaseSend({ sent: true });
      await screenWork.gate.drain();
    });
    expect(left).toBe(true);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
  });

  it("recovers the sends a stop of the station cut once, on entering, and never beside a send", async () => {
    const at = await printStation();
    const recoveries: string[] = [];
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const text = statements.map((statement) => statement.sql).join(" ");
        if (text.includes("error_code = 'interrupted'")) recoveries.push(text);
        return run();
      },
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    for (let index = 12; index < 24; index += 1) await screenWork.scan(km(`P${index}`));
    expect(jobRows(at.db).map((row) => row["state"])).toEqual(["sent", "sent"]);
    // Two boxes closed and two labels sent in this session: the recovery ran for the entry only.
    expect(recoveries).toHaveLength(1);
  });

  it("starts no decision once the leave has begun", async () => {
    const at = await printStation();
    let leaving = false;
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell, isLeaving: () => leaving });
    await fillBox(screenWork);
    leaving = true;
    await screenWork.press("Напечатать снова");
    await screenWork.press("Продолжить без этикетки");
    await screenWork.press("Продолжить без этикетки");
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 1 });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 0 },
    ]);
  });

  it("carries out one press at a time: a second press on the same label does nothing", async () => {
    const at = await printStation();
    let marks = 0;
    const local = around(at.local, {
      transaction: (statements, run) => {
        if (marksSending(statements)) marks += 1;
        return run();
      },
    });
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work({ ...at, local }, { shell });
    await fillBox(screenWork);
    expect(marks).toBe(1);
    await act(async () => {
      const button = screen.getByRole("button", { name: "Напечатать снова" });
      fireEvent.click(button);
      fireEvent.click(button);
      await screenWork.gate.drain();
    });
    // The first send, one reprint: the second press did not even try.
    expect(marks).toBe(2);
    expect(shell.sends).toHaveLength(2);
    expect(screen.queryByText("Состояние этикетки изменилось — показано текущее.")).toBeNull();
  });

  it("queues a decision behind the work in front of it: a scan taken meanwhile waits for its outcome", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    shell.holdSends();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Напечатать снова" }));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    // The label is on its way; the scan comes behind it, in the line's order.
    await act(async () => {
      screenWork.scanner.emit(km("P12"));
    });
    expect(scans(at)).toBe(12);
    await act(async () => {
      shell.releaseSend({ sent: true });
      await screenWork.gate.drain();
    });
    expect(scans(at)).toBe(13);
  });
});

describe("a label whose state the screen could not read or write", () => {
  it("stops with its own message when the job cannot be read after a close, sends nothing, and reads it again", async () => {
    const at = await printStation();
    let broken = false;
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const done = await run();
        if (isClose(statements)) broken = true;
        return done;
      },
      query: (sql) =>
        broken && sql.includes("floor_print_jobs")
          ? new LocalDbError("statement_failed", "disk")
          : null,
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(screenWork.shell.sends).toEqual([]);
    // No scan is taken into the next box while nobody knows where the label stands.
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(12);
    broken = false;
    await screenWork.press("Понятно");
    expect(screen.queryByText("Состояние этикетки не прочитано")).toBeNull();
    // The label was never sent: this is its first send, once.
    expect(screenWork.shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("reads the job again after a send whose end could not be written, and never sends it twice", async () => {
    const at = await printStation();
    let failing = true;
    const local = around(at.local, {
      transaction: (statements, run) =>
        failing && endsSend(statements)
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : run(),
    });
    const shell = fakeHardware();
    const screenWork = work({ ...at, local }, { shell });
    await fillBox(screenWork);
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 1 });
    failing = false;
    await screenWork.press("Понятно");
    // Nothing waits for an answer any more: it is said so, and nothing is sent by itself.
    expect(screen.getByText(STALLED_TITLE)).toBeTruthy();
    expect(screen.queryByText("Этикетка отправляется на принтер")).toBeNull();
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 1 });
    // Entering the screen again reads the send that was cut as unknown, for the operator.
    screenWork.view.unmount();
    const again = work(at, { shell });
    await again.settled();
    expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
  });

  it("lets the operator check a send whose end was not written: the job turns unknown, the decisions follow, nothing is sent", async () => {
    const at = await printStation();
    let failing = true;
    const recovering: number[] = [];
    let pending = () => 0;
    const local = around(at.local, {
      transaction: (statements, run) => {
        if (statements.some((statement) => statement.sql.includes("error_code = 'interrupted'"))) {
          recovering.push(pending());
        }
        return failing && endsSend(statements)
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : run();
      },
    });
    const shell = fakeHardware();
    const screenWork = work({ ...at, local }, { shell });
    pending = () => screenWork.gate.pending();
    await fillBox(screenWork);
    failing = false;
    await screenWork.press("Понятно");
    expect(screen.getByText(STALLED_TITLE)).toBeTruthy();
    const recoveriesBefore = recovering.length;
    await screenWork.press("Проверить, вышла ли этикетка");
    // The recovery ran once more, as work the gate holds, and the job is unknown now.
    expect(recovering).toHaveLength(recoveriesBefore + 1);
    expect(recovering.at(-1)).toBeGreaterThan(0);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "unknown",
      error_code: "interrupted",
      attempts: 1,
    });
    expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
    expect(screen.getByText("Печать прервалась. Посмотрите, вышла ли этикетка.")).toBeTruthy();
    expect(screen.queryByText(STALLED_TITLE)).toBeNull();
    expect(shell.sends).toHaveLength(1);
    // The unknown label's own decisions: «Этикетка напечаталась» ends it, no new print.
    await screenWork.press("Этикетка напечаталась");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(shell.sends).toHaveLength(1);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("offers no check for a send this app still holds, nor for a label that was never sent", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = createPrintRuntime(shell.hardware.printBytes);
    const first = work(at, { shell, runtime });
    await first.scanner.listening();
    await first.settled();
    for (let index = 0; index < 11; index += 1) await first.scan(km(`P${index}`));
    shell.holdSends();
    await act(async () => {
      first.scanner.emit(km("P11"));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    first.view.unmount();
    const second = work(at, { shell, runtime });
    await act(async () => {
      await flushPromises();
    });
    // The bytes are with the shell: the answer is still to come, and there is nothing to check.
    expect(screen.getByText("Этикетка отправляется на принтер")).toBeTruthy();
    // Said as the program does it: it asks the operator, it does not know.
    expect(
      screen.getByText(
        "Дождитесь ответа принтера или выйдите из смены: при возвращении программа предложит решить, вышла ли этикетка. Сама она ничего не отправит.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить, вышла ли этикетка" })).toBeNull();
    await act(async () => {
      shell.releaseSend({ sent: true });
      await second.gate.drain();
      await first.gate.drain();
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("leaves a send this app still holds as it is when the screen is entered again", async () => {
    const at = await printStation();
    const shell = fakeHardware();
    const runtime = createPrintRuntime(shell.hardware.printBytes);
    const first = work(at, { shell, runtime });
    await first.scanner.listening();
    await first.settled();
    for (let index = 0; index < 11; index += 1) await first.scan(km(`P${index}`));
    shell.holdSends();
    await act(async () => {
      first.scanner.emit(km("P11"));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    first.view.unmount();
    const second = work(at, { shell, runtime });
    await act(async () => {
      await flushPromises();
    });
    // The bytes are with the shell: not interrupted, and not sent again.
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 1 });
    expect(shell.sends).toHaveLength(1);
    await act(async () => {
      shell.releaseSend({ sent: true });
      await second.gate.drain();
      await first.gate.drain();
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });

  it("says a failed check was not written, and goes on to read the label", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    let failing = false;
    const local = around(at.local, {
      transaction: (statements, run) =>
        failing &&
        statements[0]?.sql.startsWith(
          "UPDATE floor_print_jobs SET state = ?, error_code = NULL",
        ) === true
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : run(),
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    failing = true;
    await screenWork.scan(formatSsccHri(FIRST_SSCC));
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    failing = false;
    await screenWork.press("Понятно");
    // The label still waits for its check.
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
  });
});

describe("what the panel tells the operator", () => {
  it("names the printer a reprint goes to before the operator confirms it, and the one chosen instead", async () => {
    const { screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    expect(
      await screen.findByText("Печать пойдёт на принтер: Zebra у линии · ZPL · 203 dpi."),
    ).toBeTruthy();
    await screenWork.press("Назад");
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await screenWork.press("TSC на COM4 · TSPL · 300 dpi");
    expect(screen.getByText("Почему печатаете снова?")).toBeTruthy();
    expect(
      screen.getByText("Печать пойдёт на принтер: TSC на COM4 · TSPL · 300 dpi."),
    ).toBeTruthy();
    // Nothing was sent by looking.
    expect(screenWork.shell.sends).toHaveLength(1);
  });

  it("warns that the printer of the label is gone from the settings and another one would take it", async () => {
    const at = await printStation();
    const { screenWork } = await unknownLabel({}, at);
    // The Zebra is removed from the settings; the box's printer is now the TSC.
    await saveWorkstationSettings(at.local, {
      ...at.settings,
      printers: [TSC],
      assignments: { box: "tsc", pallet: null, duplicate: null },
    });
    screenWork.view.unmount();
    const again = work(at, { shell: screenWork.shell });
    await again.settled();
    const gone =
      "Принтер «Zebra у линии» удалён из настройки. Печать пойдёт на принтер: TSC на COM4 · TSPL · 300 dpi; этикетка, возможно, лежит у прежнего.";
    // Said on the label's own view already, before anything is pressed.
    expect(await screen.findByText(gone)).toBeTruthy();
    await again.press("Напечатать снова");
    expect(await screen.findByText(gone)).toBeTruthy();
  });

  it("does not say a label may lie at the former printer when the job failed and nothing left the computer", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const first = work(at, { shell });
    await fillBox(first);
    expect(screen.getByText(MIDDLE_FAILED)).toBeTruthy();
    // The Zebra is removed from the settings; the box's printer is now the TSC.
    await saveWorkstationSettings(at.local, {
      ...at.settings,
      printers: [TSC],
      assignments: { box: "tsc", pallet: null, duplicate: null },
    });
    first.view.unmount();
    const again = work(at, { shell });
    await again.settled();
    expect(
      await screen.findByText(
        "Принтер «Zebra у линии» удалён из настройки. Печать пойдёт на принтер: TSC на COM4 · TSPL · 300 dpi.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/возможно, лежит/)).toBeNull();
    // Looking sent nothing.
    expect(shell.sends).toHaveLength(1);
  });

  it("names the printer on the view of a label that failed, where «Напечатать снова» sends at once", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    expect(screen.getByText(MIDDLE_FAILED)).toBeTruthy();
    expect(
      await screen.findByText("Печать пойдёт на принтер: Zebra у линии · ZPL · 203 dpi."),
    ).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
  });

  it("builds the reason of a reprint from its buttons alone", async () => {
    const { at, screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    const panel = document.querySelector<HTMLElement>(".work-screen__label");
    if (panel === null) throw new Error("the label panel is not on the screen");
    const names = within(panel)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual([
      "Этикетка повреждена",
      "Этикетка не читается",
      "Замятие в принтере",
      "Требование контроля качества",
      "Другая причина",
      "Назад",
    ]);
    await screenWork.press("Требование контроля качества");
    expect(rows(at.db, "SELECT kind, reason_code FROM floor_exceptions")).toEqual([
      { kind: "reprint", reason_code: "quality_request" },
    ]);
  });

  it("suggests another printer or a restart when the printer was still busy", async () => {
    const station = await printStation();
    await closeBoxWithLabel(station);
    station.db
      .prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'printer_busy'")
      .run();
    const screenWork = work(station);
    await screenWork.settled();
    const text = screen.getByText(/Принтер ещё занят предыдущим заданием/).textContent ?? "";
    expect(text).toContain("другой принтер");
    expect(text).toContain("перезапустите программу");
  });
});

describe("the label panel for keyboards, readers and gloves", () => {
  it("sits in the screen's polite region without an alert role of its own, and every button is a floor one", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await screenWork.scanner.listening();
    const region = alertsRegion();
    expect(region.getAttribute("aria-live")).toBe("polite");
    await fillBox(screenWork);
    const title = screen.getByText(MIDDLE_FAILED);
    expect(alertsRegion()).toBe(region);
    expect(region.contains(title)).toBe(true);
    expect(title.closest('[role="alert"]')).toBeNull();
    expect(title.closest('[role="presentation"]')).not.toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
  });

  it("keeps the buttons on the keyboard while a decision runs, and does nothing on a press", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    shell.holdSends();
    const again = screen.getByRole("button", { name: "Напечатать снова" });
    again.focus();
    await act(async () => {
      fireEvent.click(again);
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    // Said in the polite region, and the buttons wait without dropping the focus.
    expect(alertsRegion().textContent).toContain("Этикетка отправлена на принтер…");
    for (const name of ["Напечатать снова", "Другой принтер", "Продолжить без этикетки"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    expect(document.activeElement).toBe(again);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
    expect(screen.queryByText("Продолжить без этикетки?")).toBeNull();
    await act(async () => {
      shell.releaseSend({ sent: true });
      await screenWork.gate.drain();
    });
    expect(screen.queryByText(MIDDLE_FAILED)).toBeNull();
    // The panel is gone, and the focus did not fall to the page.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves the focus into the view the operator opened, onto a control that sends nothing", async () => {
    const { screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    // Not on a reason: a second Space press must not choose one.
    expect(document.activeElement?.textContent).toBe("Назад");
    await screenWork.press("Назад");
    // Not on «Этикетка напечаталась» either: the panel itself holds the focus.
    expect(document.activeElement).toBe(document.querySelector("[data-label-panel]"));
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    expect(document.activeElement?.textContent).toBe("Назад");
    await screenWork.press("Назад");
    await screenWork.press("Продолжить без этикетки");
    expect(document.activeElement?.textContent).toBe("Назад");
  });

  it("does not take the second press of a double activation for a reason nobody chose", async () => {
    const { at, shell, screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    expect(screen.getByText("Почему печатаете снова?")).toBeTruthy();
    // The same Space press again, on whatever holds the focus now.
    await act(async () => {
      fireEvent.click(document.activeElement as Element);
      await screenWork.gate.drain();
    });
    expect(screen.getByText("Почему печатаете снова?")).toBeTruthy();
    // A gloved double tap: the second tap lands on the button now under the finger.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Этикетка не читается" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
  });

  it("takes a press on the reason again once the guard after the view has run out, and not before", async () => {
    const { at, shell, screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    screenWork.clock.now += 399;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Замятие в принтере" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(1);
    screenWork.clock.now += 1;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Замятие в принтере" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT reason_code FROM floor_exceptions")).toEqual([
      { reason_code: "printer_jam" },
    ]);
  });

  it("is not held by a clock that went back: the guard ends, it does not stand for ever", async () => {
    const { shell, screenWork } = await unknownLabel();
    screenWork.clock.now = 50_000;
    await screenWork.press("Напечатать снова");
    screenWork.clock.now = 100;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Замятие в принтере" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(2);
  });

  it("does not take the second tap for a printer nobody chose, nor for a decision the view before it hid", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(1);
    expect(screen.getByText("На какой принтер печатать?")).toBeTruthy();
    // Back to the label's own view: the tap that follows decides nothing either.
    await screenWork.press("Назад");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Напечатать снова" }));
      await screenWork.gate.drain();
    });
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("does not take the second tap for the skip of a label", async () => {
    const { at, screenWork } = await unknownLabel();
    await screenWork.press("Продолжить без этикетки");
    expect(screen.getByText("Продолжить без этикетки?")).toBeTruthy();
    await act(async () => {
      // The confirmation's own button, under the finger that pressed the first one.
      fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
      await screenWork.gate.drain();
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown" });
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_label'")).toEqual([
      { n: 0 },
    ]);
    expect(screen.getByText("Продолжить без этикетки?")).toBeTruthy();
  });

  it("does not take «Этикетка напечаталась» for the second tap of a «Назад»", async () => {
    const { at, screenWork } = await unknownLabel();
    await screenWork.press("Напечатать снова");
    await screenWork.press("Назад");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Этикетка напечаталась" }));
      await screenWork.gate.drain();
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
    expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
  });

  it("tells a verified label by the tone and the lit line only, and a wrong one by a flash that lets taps through", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const screenWork = work(at);
    await fillBox(screenWork);
    await screenWork.scan(`]C100${SECOND_SSCC}`);
    const flash = document.querySelector(".work-screen__flash");
    expect(flash).not.toBeNull();
    expect((flash as HTMLElement).style.pointerEvents).toBe("none");
    await screenWork.scan(formatSsccHri(FIRST_SSCC));
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(document.querySelector(".work-screen__last--cue")).not.toBeNull();
    // No overlay for the accepted scan, and nothing announced for it.
    expect(alertsRegion().textContent).not.toContain("ЭТИКЕТКА ВЕРНА");
  });
});

describe("a decision on the label that goes wrong, and the work after it", () => {
  it("hands a decision on the label to the gate: the leave waits for the printer's answer", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    shell.holdSends();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Напечатать снова" }));
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    let left = false;
    void screenWork.gate.drain().then(() => {
      left = true;
    });
    await act(async () => {
      await flushPromises();
    });
    expect(left).toBe(false);
    await act(async () => {
      shell.releaseSend({ sent: true });
      await screenWork.gate.drain();
    });
    expect(left).toBe(true);
  });

  it("stops with the label's message when a decision could not be written, and decides again after it", async () => {
    const at = await printStation();
    let failing = false;
    const local = around(at.local, {
      transaction: (statements, run) =>
        failing && marksSending(statements)
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : run(),
    });
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work({ ...at, local }, { shell });
    await fillBox(screenWork);
    failing = true;
    await screenWork.press("Напечатать снова");
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 1 });
    failing = false;
    await screenWork.press("Понятно");
    expect(screen.getByText(MIDDLE_FAILED)).toBeTruthy();
    await screenWork.press("Напечатать снова");
    expect(shell.sends).toHaveLength(2);
    expect(screen.queryByText(MIDDLE_FAILED)).toBeNull();
  });

  it("says under the label that the other printer's rendering failed, and changes nothing", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    let rendering = true;
    const screenWork = work(at, {
      shell,
      render: async (_spec, _fields, printer) => {
        if (!rendering) throw new Error("no canvas");
        return new Uint8Array([printer.dpi === 203 ? 1 : 2]);
      },
    });
    await fillBox(screenWork);
    rendering = false;
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await screenWork.press("TSC на COM4 · TSPL · 300 dpi");
    expect(screen.getByText("Этикетку не удалось подготовить для этого принтера.")).toBeTruthy();
    expect(screen.getByText(MIDDLE_FAILED)).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("says the label changed meanwhile, and shows the current one, when the decision finds it moved", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const screenWork = work(at, { shell });
    await fillBox(screenWork);
    // Something else moved the job on: the panel on the screen is out of date.
    at.db.prepare("UPDATE floor_print_jobs SET attempts = attempts + 1").run();
    await screenWork.press("Напечатать снова");
    expect(screen.getByText("Состояние этикетки изменилось — показано текущее.")).toBeTruthy();
    expect(screen.getByText(MIDDLE_FAILED)).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
  });

  it("starts nothing when a message is dismissed once the leave has begun", async () => {
    const at = await printStation();
    let broken = false;
    let leaving = false;
    const local = around(at.local, {
      transaction: async (statements, run) => {
        const done = await run();
        if (isClose(statements)) broken = true;
        return done;
      },
      query: (sql) =>
        broken && sql.includes("floor_print_jobs")
          ? new LocalDbError("statement_failed", "disk")
          : null,
    });
    const screenWork = work({ ...at, local }, { isLeaving: () => leaving });
    await fillBox(screenWork);
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    broken = false;
    leaving = true;
    await screenWork.press("Понятно");
    // The label waits for its first send: the leave does not wait for a send started now.
    expect(screenWork.shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "prepared", attempts: 0 });
  });

  it("stops at entry when the sends a stop cut cannot be recovered, and sends nothing", async () => {
    const at = await printStation();
    await closeBoxWithLabel(at);
    const local = around(at.local, {
      transaction: (statements, run) =>
        statements.some((statement) => statement.sql.includes("error_code = 'interrupted'"))
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : run(),
    });
    const screenWork = work({ ...at, local });
    await screenWork.settled();
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(screenWork.shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "prepared", attempts: 0 });
  });

  it("shows a label whose first send found the job moved as it stands, and sends nothing", async () => {
    const at = await printStation();
    let moved = true;
    const local = around(at.local, {
      transaction: (statements, run) => {
        if (moved && marksSending(statements)) {
          moved = false;
          return Promise.reject(new LocalDbError("changes_mismatch", "moved"));
        }
        return run();
      },
    });
    const screenWork = work({ ...at, local });
    await fillBox(screenWork);
    expect(screenWork.shell.sends).toEqual([]);
    expect(screen.queryByText("Состояние этикетки не прочитано")).toBeNull();
    expect(screen.getByText("Этикетка отправляется на принтер")).toBeTruthy();
    // Never sent: nothing to check, the next entry sends it.
    expect(screen.queryByRole("button", { name: "Проверить, вышла ли этикетка" })).toBeNull();
  });

  it("closes the box a stopped station left full once the label's check passes, and prints its label", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    await closeBoxWithLabel(at);
    at.db.prepare("UPDATE floor_print_jobs SET state = 'sent', attempts = 1").run();
    const filling = scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() });
    for (let index = 0; index < 12; index += 1) await processScan(filling, km(`Q${index}`));
    const screenWork = work(at);
    await screenWork.settled();
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 1 },
    ]);
    await screenWork.scan(formatSsccHri(FIRST_SSCC));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    expect(screenWork.shell.sends).toEqual([
      { target: ZEBRA.target, text: renderedText(ZEBRA, SECOND_SSCC) },
    ]);
    // Its own label asks for its own check.
    expect(screen.getByText("Проверьте этикетку")).toBeTruthy();
    expect(screen.getByText(`SSCC короба: ${formatSsccHri(SECOND_SSCC)}`)).toBeTruthy();
  });
});

/** A 58 × 40 label that is only a 4 × 2 mm logo box at (2, 2): its bytes are the logo's. */
const LOGO_LABEL: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      id: "logo",
      kind: "organization_logo",
      source: "organization",
      fallback: "markiro",
      xMm: 2,
      yMm: 2,
      widthMm: 4,
      heightMm: 2,
    },
  ],
};
const FROZEN_LOGO: MonoBitmap = {
  width: 8,
  height: 2,
  stride: 1,
  pixels: new Uint8Array([0xf0, 0x0f]),
};
/** What the ZEBRA (ZPL, 203 dpi) prints of `FROZEN_LOGO` in `LOGO_LABEL`. */
const LOGO_GRAPHIC = "^FO16,20^GFA,32,32,4," + "FFFF0000".repeat(4) + "0000FFFF".repeat(4) + "^FS";

describe("the label of a box, with the shift's logo (#703)", () => {
  /** The printing station whose shift froze this organization and prints `LOGO_LABEL` on a box. */
  async function logoStation(logo: MonoBitmap | null) {
    const at = await printStation();
    const shift = {
      ...at.shift,
      snapshot: {
        ...at.shift.snapshot,
        organization: { name: "ООО «Пример»", inn: null, logo },
        boxTemplate: { ...at.shift.snapshot.boxTemplate, spec: LOGO_LABEL },
      },
    };
    return { ...at, shift };
  }

  it("prints the organization logo the shift froze, and the work goes on", async () => {
    const at = await logoStation(FROZEN_LOGO);
    const screenWork = work(at, { ownRender: true });
    await fillBox(screenWork);
    expect(screenWork.shell.sends).toHaveLength(1);
    expect(screenWork.shell.sends[0]?.text).toContain(LOGO_GRAPHIC);
    expect(jobRows(at.db)).toEqual([expect.objectContaining({ state: "sent", sscc: FIRST_SSCC })]);
    await screenWork.scan(km("P12"));
    expect(scans(at)).toBe(13);
  });

  it("prints the same logo again on another printer, rendered for its language and resolution", async () => {
    const at = await logoStation(FROZEN_LOGO);
    const answers = [{ sent: false, code: "not_sent" } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const screenWork = work(at, { shell, ownRender: true });
    await fillBox(screenWork);
    await screenWork.press("Другой принтер");
    await screen.findByRole("button", { name: "TSC на COM4 · TSPL · 300 dpi" });
    await screenWork.press("TSC на COM4 · TSPL · 300 dpi");
    // TSPL at 300 dpi: the box 47 × 24 dots holds the logo as 47 × 12 at (24, 30).
    expect(shell.sends.at(-1)?.text).toContain("BITMAP 24,30,6,12,0,");
  });

  it("prints the label with the logo box empty and one diagnostic line when no logo can be had", async () => {
    // Nothing frozen, and this webview has no canvas for the bundled Markiro logo.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const at = await logoStation(null);
      const screenWork = work(at, { ownRender: true });
      await fillBox(screenWork);
      expect(screenWork.shell.sends).toHaveLength(1);
      expect(screenWork.shell.sends[0]?.text).toContain("^XA");
      expect(screenWork.shell.sends[0]?.text).not.toContain("^GFA");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("station: label logo unavailable, printing without it");
      expect(jobRows(at.db)).toEqual([expect.objectContaining({ state: "sent" })]);
      await screenWork.scan(km("P12"));
      expect(scans(at)).toBe(13);
    } finally {
      error.mockRestore();
    }
  });
});
