import { readFileSync } from "node:fs";

import { buildSscc } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import type { ClosingBox, CloseStep } from "../src/floor/work/box-close.js";
import {
  CUE_MS,
  scanTime,
  SIGNAL_MS,
  WorkScreen,
  type WorkScreenProps,
} from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import { HostError } from "../src/host/client.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor, type LocalStatement } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  GTIN,
  holdingWrites,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, setUpPrinting } from "./support/printing.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const BLOCK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

/** A scanner the test reads codes into, as the floor's source hands them over. */
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
    /** The screen listens: only then may the test scan. */
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    /** Hands a scan over, as the scanner does, and returns at once. */
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

/** A block of 2 000 serials from `fromSerial`, of the prefix and extension asked for. */
function blockFor(request: SsccBlockRequest, fromSerial = 3500): SsccBlock {
  return {
    id: BLOCK_ID,
    issuerPrefix: request.issuerPrefix,
    extension: request.extension,
    fromSerial,
    toSerial: fromSerial + 1999,
  };
}

interface Station {
  db: ReturnType<typeof openLocalDb>["db"];
  local: LocalExecutor;
  shift: WorkShift;
}

/** A station with the shift entered and the Zebra set up for boxes (plan 2a7). */
async function station(shift = ENTERED): Promise<Station> {
  const { db, executor } = openLocalDb();
  await setUpPrinting(executor);
  return { db, local: executor, shift: await enteredShift(executor, shift) };
}

function work(at: Station, overrides: Partial<WorkScreenProps> = {}) {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const props: WorkScreenProps = {
    shift: at.shift,
    operator: SESSION,
    pairing: PAIRING,
    local: at.local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: vi.fn(),
    leaving: false,
    source: scanner.source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => blockFor(request)),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    awake: createSystemAwake(vi.fn(async () => undefined)),
    render: fakeRender,
    ...overrides,
  };
  // What the screen was given last: a rerender keeps what an earlier one changed.
  let current = props;
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
    rerender: (next: Partial<WorkScreenProps>) => {
      current = { ...current, ...next };
      view.rerender(
        <ThemeProvider>
          <WorkScreen {...current} />
        </ThemeProvider>,
      );
    },
    /** Every piece of work the screen handed to the gate has settled. */
    settled: () =>
      act(async () => {
        await gate.drain();
      }),
    /** Scans `raw` and waits for its work, all inside one `act`. */
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
        await gate.drain();
      }),
    /** Presses the button `name` and waits for the work it started. */
    press: (name: string) =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
        await gate.drain();
      }),
  };
}

/** The value the screen shows under `label`. */
function shown(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
}

function lastLine(): string | null {
  return document.querySelector(".work-screen__last")?.textContent ?? null;
}

const CLOSE_FAILED = "Короб не закрыт";
const NO_SERIALS = "Нет номеров SSCC: короб не закрыт";

/** The transaction of a box's close: its first statement spends the block's serial. */
function isClose(statements: readonly LocalStatement[]): boolean {
  return statements[0]?.sql.startsWith("UPDATE floor_sscc_blocks SET next_serial") === true;
}

/** A local database whose transactions go through `hook`, as a failing disk's would. */
function around(
  local: LocalExecutor,
  hook: (statements: readonly LocalStatement[], run: () => Promise<number[]>) => Promise<number[]>,
): LocalExecutor {
  return {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: (statements) => hook(statements, () => local.transaction(statements)),
  };
}

/** The box with the most codes the shift has ever had. */
function fullestBox(db: Station["db"]): unknown {
  return rows(db, "SELECT max(item_count) AS n FROM floor_boxes")[0]?.["n"];
}

/** The polite region the alerts of the screen sit in, there from the first paint. */
function alertsRegion(): Element {
  const region = document.querySelector(".work-screen__alerts");
  if (region === null) throw new Error("the alerts' region is not on the screen");
  return region;
}

/** The text is in the polite region that was on the screen before it, and is no alert of its own. */
function heardOnce(text: string | RegExp): void {
  const heard = screen.getByText(text);
  expect(alertsRegion().contains(heard)).toBe(true);
  expect(heard.closest('[role="alert"]')).toBeNull();
}

/** Fills the box to the brim by scans of one screen, then leaves a stopped station's state. */
async function fullBoxLeftByAStoppedStation(at: Station, prefix: string): Promise<void> {
  const filling = work(at);
  await filling.scanner.listening();
  for (let index = 0; index < 11; index += 1) await filling.scan(km(`${prefix}${index}`));
  filling.view.unmount();
  // The twelfth code, as a station that stopped right after the scan left it.
  at.db.prepare("UPDATE floor_boxes SET item_count = 12 WHERE closed_at IS NULL").run();
  at.db
    .prepare(
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
        "SELECT host_id, device_id, ?, shift_id, id, 'n11', '2026-10-08T06:20:00.000Z' FROM floor_boxes WHERE closed_at IS NULL",
    )
    .run("ab".repeat(32));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the work screen of a shift", () => {
  it("takes the scans into the open box, with their numbers, a tone and a touch each", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(shown("Открытый короб")).toBe("Короб откроется с первым кодом");
    await screenWork.scan(km("A1"));
    await screenWork.scan(km("A2"));
    expect(shown("Открытый короб")).toBe("2 из 12");
    expect(shown("Принято в смене")).toBe("2");
    expect(shown("План")).toBe("1\u00a0200");
    expect(lastLine()).toBe("Принято: в коробе 2 из 12.");
    expect(screenWork.props.signal).toHaveBeenCalledTimes(2);
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(screenWork.props.touch).toHaveBeenCalledTimes(2);
    expect(screenWork.props.onRecorded).toHaveBeenCalledTimes(2);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'scan'")).toEqual([{ n: 2 }]);
  });

  it("hands a scan on its way to the floor's gate, so a leave waits for it", async () => {
    const at = await station();
    const held = holdingWrites(at.local);
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.settled();
    held.holdNext();
    await screenWork.scanner.read(km("B1"));
    await held.reached();
    expect(screenWork.gate.pending()).toBe(1);
    held.release();
    await screenWork.settled();
    expect(screenWork.gate.pending()).toBe(0);
    expect(shown("Принято в смене")).toBe("1");
  });

  it("closes a full box by itself with the next SSCC, and begins the next box", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const onClosed = vi.fn<(box: ClosingBox) => void>();
    const screenWork = work(at, { onClosed });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`C${index}`));
    expect(shown("Последний короб")).toBe(`(00)${buildSscc(0, PREFIX, 1500)}`);
    expect(shown("Коробов закрыто")).toBe("1");
    expect(shown("Открытый короб")).toBe("Короб откроется с первым кодом");
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 1 },
    ]);
    // The extension point of the label's plan: told once, with the box as it was written.
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed.mock.calls[0]?.[0]).toMatchObject({
      sscc: buildSscc(0, PREFIX, 1500),
      blockId: BLOCK_ID,
      serial: 1500,
      itemCount: 12,
      operatorId: OPERATOR_ID,
    });
    expect(onClosed.mock.calls[0]?.[0].codeHashes).toHaveLength(12);
    await screenWork.scan(km("C12"));
    expect(shown("Открытый короб")).toBe("1 из 12");
  });

  it("hands the steps of a later plan to every close of a box", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const step = vi.fn<CloseStep>(async () => ({ statements: [] }));
    const screenWork = work(at, { closeSteps: [step] });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`S${index}`));
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]?.[0]).toMatchObject({ sscc: buildSscc(0, PREFIX, 1500) });
    await screenWork.scan(km("S12"));
    await screenWork.press("Закрыть короб");
    await screenWork.press("Закрыть короб");
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("says in words and by tone what each refused scan was", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("D1"));
    const [first] = rows(at.db, "SELECT scanned_at FROM floor_codes");
    await screenWork.scan(km("D1", { aim: false }));
    expect(lastLine()).toBe(
      `Дубль: этот код уже принят в ${scanTime(String(first?.["scanned_at"]))}.`,
    );
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("duplicate");
    await screenWork.scan(km("D2", { gtin: OTHER_GTIN }));
    expect(lastLine()).toBe(`Чужой товар: GTIN ${OTHER_GTIN}.`);
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    await screenWork.scan(GTIN);
    expect(lastLine()).toBe("Это GTIN товара, а не код маркировки.");
    await screenWork.scan(`]C100${buildSscc(0, PREFIX, 1500)}`);
    expect(lastLine()).toBe("Это код короба, а не код маркировки.");
    await screenWork.scan("MRK-000742");
    expect(lastLine()).toBe("Это не код маркировки.");
    expect(shown("Принято в смене")).toBe("1");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 6 }]);
  });

  it("lights the last-scan line for an accepted scan, with no overlay, and puts the light out", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    // The light goes by a timer: a clock the test moves by hand, no margin to lose under load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await screenWork.scan(km("F1"));
    // The tone and the line say it; nothing covers the counts or the buttons.
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("ok");
    expect(document.querySelector("[data-tone]")).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    const lit = () =>
      document.querySelector(".work-screen__last")?.classList.contains("work-screen__last--cue");
    expect(lit()).toBe(true);
    expect(shown("Открытый короб")).toBe("1 из 12");
    act(() => {
      vi.advanceTimersByTime(CUE_MS - 1);
    });
    expect(lit()).toBe(true);
    // A scan in the meantime lights it for a whole time again.
    await screenWork.scan(km("F2"));
    act(() => {
      vi.advanceTimersByTime(CUE_MS - 1);
    });
    expect(lit()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(lit()).toBe(false);
  });

  it("flashes a refusal with its words over the screen, never in the way of a tap, and takes the flash away", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await screenWork.scan(km("F1"));
    await screenWork.scan(km("F1"));
    const overlay = () => document.querySelector("[data-tone]");
    expect(overlay()?.getAttribute("data-tone")).toBe("duplicate");
    expect(overlay()?.textContent).toContain("ДУБЛЬ");
    // The words of the line are said by the flash too, for whoever hears it as an alert.
    expect(overlay()?.textContent).toContain(lastLine() ?? "");
    // The buttons under the flash work: it takes no tap.
    expect(overlay()?.closest(".work-screen__flash")?.getAttribute("style")).toContain(
      "pointer-events: none",
    );
    await screenWork.scan(km("F2", { gtin: OTHER_GTIN }));
    expect(overlay()?.getAttribute("data-tone")).toBe("error");
    expect(overlay()?.textContent).toContain("ЧУЖОЙ ТОВАР");
    await screenWork.scan("MRK-000742");
    expect(overlay()?.textContent).toContain("НЕВЕРНЫЙ КОД");
    act(() => {
      vi.advanceTimersByTime(SIGNAL_MS - 1);
    });
    expect(overlay()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(overlay()).toBeNull();
  });

  it("styles the light and the flash so that a tap goes through and motion is off on request", () => {
    const css = readFileSync(new URL("../src/app/shell.css", testModuleUrl), "utf8");
    expect(css).toMatch(/\.work-screen__flash\s*\{[^}]*pointer-events:\s*none/);
    // The line's fade is motion: only for whoever did not ask for less.
    const withoutMotion = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
      "",
    );
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\)\s*\{\s*\.work-screen__last\s*\{[^}]*transition/,
    );
    expect(withoutMotion).not.toMatch(/\.work-screen[^{]*\{[^}]*(transition|animation)/);
  });

  it("asks the host while online and names the shift that took the code first", async () => {
    const at = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const screenWork = work(at, { online: true, checkCode });
    await screenWork.scanner.listening();
    await screenWork.scan(km("E1"));
    expect(lastLine()).toBe(
      `Дубль: код принят в смене OCT26-003 в ${scanTime(TAKEN.owner.scannedAt)}.`,
    );
    expect(checkCode).toHaveBeenCalledTimes(1);
  });

  it("hands a refused key of the code check to the shell, and takes the scan", async () => {
    const at = await station();
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const screenWork = work(at, {
      online: true,
      checkCode: async () => {
        throw refused;
      },
    });
    await screenWork.scanner.listening();
    await screenWork.scan(km("F1"));
    expect(screenWork.props.onHostError).toHaveBeenCalledWith(refused);
    expect(shown("Принято в смене")).toBe("1");
  });

  it("closes an incomplete box only once the operator confirms, and takes no scan meanwhile", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(screen.getByRole("button", { name: "Закрыть короб" }).hasAttribute("disabled")).toBe(
      true,
    );
    await screenWork.scan(km("G1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    expect(screen.getByText("Закрыть неполный короб? В коробе 1 из 12.")).toBeTruthy();
    // The safe answer has the focus, so that a stray key cannot close the box.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Продолжить сборку" }));
    await screenWork.scan(km("G2"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить сборку" }));
    expect(screen.queryByText("Закрыть неполный короб? В коробе 1 из 12.")).toBeNull();
    expect(rows(at.db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    await screenWork.press("Закрыть короб");
    expect(shown("Коробов закрыто")).toBe("1");
    expect(rows(at.db, "SELECT sscc FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
  });

  it("stops without serials, says why, and closes the box once the link brings a block", async () => {
    const at = await station();
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => blockFor(request));
    const screenWork = work(at, { requestBlock });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`H${index}`));
    heardOnce(NO_SERIALS);
    expect(
      screen.getByText(
        "Номера выдаёт хост, а связи с ним нет. Короб закроется, как только номера придут.",
      ),
    ).toBeTruthy();
    // Nothing is closed by hand while the line is stopped.
    expect(screen.getByRole("button", { name: "Закрыть короб" }).hasAttribute("disabled")).toBe(
      true,
    );
    // A full box takes no code: it is not even read.
    await screenWork.scan(km("H12"));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 12 }]);
    expect(fullestBox(at.db)).toBe(12);
    expect(requestBlock).not.toHaveBeenCalled();
    screenWork.rerender({ online: true });
    await waitFor(() => expect(screen.queryByText(NO_SERIALS)).toBeNull());
    await screenWork.settled();
    // The close ran from the effect of the link coming back, outside a
    // scan's `act`: its numbers render in a later turn.
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
    await screenWork.scan(km("H12"));
    expect(shown("Открытый короб")).toBe("1 из 12");
  });

  it("says when the host has no serials left, and tries again on «Повторить»", async () => {
    const at = await station();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "none" }),
      )
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "none" }),
      )
      .mockImplementation(async (request) => blockFor(request));
    const screenWork = work(at, { online: true, requestBlock });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`J${index}`));
    expect(
      screen.getByText(
        "Номера SSCC префикса организации закончились. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
    await screenWork.press("Повторить");
    expect(screen.queryByText(NO_SERIALS)).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("stops the line on a failed write until the operator closes the message", async () => {
    const at = await station();
    let broken = false;
    const local = around(at.local, (statements, run) =>
      broken ? Promise.reject(new LocalDbError("statement_failed", "disk full")) : run(),
    );
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    broken = true;
    await screenWork.scan(km("K1"));
    heardOnce("Скан не записан");
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    broken = false;
    await screenWork.scan(km("K2"));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    await screenWork.press("Понятно");
    await screenWork.scan(km("K1"));
    expect(shown("Принято в смене")).toBe("1");
  });

  it("says once that the plan is reached", async () => {
    const at = await station({ ...ENTERED, plannedQty: 2 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("L1"));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await screenWork.scan(km("L2"));
    heardOnce("План выполнен: принято 2 из 2.");
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screenWork.scan(km("L3"));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
  });

  it("takes no scan while the operator leaves, and lets nobody press leave twice", async () => {
    const at = await station();
    const screenWork = work(at, { leaving: true });
    await screenWork.scanner.listening();
    await screenWork.scan(km("M1"));
    expect(lastLine()).toBe("Скан не принят: идёт выход из смены.");
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    // The button stays on the keyboard (`aria-disabled`, not `disabled`), and does nothing.
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.getAttribute("aria-disabled")).toBe("true");
    expect(leave.hasAttribute("disabled")).toBe(false);
    leave.focus();
    fireEvent.click(leave);
    expect(screenWork.props.onLeave).not.toHaveBeenCalled();
    screenWork.rerender({ leaving: false });
    const again = screen.getByRole("button", { name: "Выйти из смены" });
    expect(again).toBe(leave);
    expect(again.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(again);
    expect(screenWork.props.onLeave).toHaveBeenCalledTimes(1);
  });

  it("keeps a polite region for the wait of the leave on the screen from the start", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    const region = document.querySelector(".work-screen__leaving");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
    screenWork.rerender({ leaving: true });
    expect(document.querySelector(".work-screen__leaving")).toBe(region);
    expect(region?.textContent).toBe("Дожидаемся окончания начатой работы…");
  });

  it("closes first a box a stopped station left full, then asks for serials while online", async () => {
    const at = await station();
    // One serial: the close takes it, and the half rule then asks for more.
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 1500 });
    await fullBoxLeftByAStoppedStation(at, "N");
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => blockFor(request));
    const reopened = work(at, { online: true, requestBlock });
    await reopened.scanner.listening();
    await reopened.settled();
    // The entry's close ran from an effect, outside a scan's `act`: its
    // numbers render in a later turn.
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
    expect(requestBlock).toHaveBeenCalledTimes(1);
    expect(requestBlock).toHaveBeenCalledWith({
      requestId: expect.any(String),
      issuerPrefix: PREFIX,
      extension: 0,
    });
  });
});

describe("the work screen never lets a full box take another code", () => {
  it("stops the line when the close of a full box fails to write, and closes it on «Повторить»", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let failing = true;
    const local = around(at.local, (statements, run) =>
      failing && isClose(statements)
        ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
        : run(),
    );
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`P${index}`));
    heardOnce(CLOSE_FAILED);
    expect(
      screen.getByText("Закрытие короба не записалось. Ничего не потеряно: повторите закрытие."),
    ).toBeTruthy();
    // The box is full and not closed: no code goes into it.
    await screenWork.scan(km("P12"));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 12 }]);
    expect(fullestBox(at.db)).toBe(12);
    failing = false;
    await screenWork.press("Повторить");
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
    expect(rows(at.db, "SELECT sscc FROM floor_boxes WHERE closed_at IS NOT NULL")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
  });

  it("closes a full box that nothing holds before it reads the next code", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    await fullBoxLeftByAStoppedStation(at, "Q");
    // The entry's first read fails: its message stops the line, and once the
    // operator closes the message nothing holds the full box any more.
    let reads = 0;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        (reads += 1) === 1
          ? Promise.reject(new LocalDbError("statement_failed", "disk busy"))
          : at.local.query(sql, params, row),
      transaction: (statements) => at.local.transaction(statements),
    };
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    // The failed read of the entry stops the line in a render of its own, after the act.
    // Nothing was scanned: the title says the shift could not be read, not that a scan was lost.
    expect(await screen.findByText("Смена не прочитана")).toBeTruthy();
    expect(screen.queryByText("Скан не записан")).toBeNull();
    await screenWork.press("Понятно");
    expect(rows(at.db, "SELECT item_count FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { item_count: 12 },
    ]);
    await screenWork.scan(km("Q-NEW"));
    expect(fullestBox(at.db)).toBe(12);
    expect(rows(at.db, "SELECT sscc FROM floor_boxes WHERE closed_at IS NOT NULL")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
    expect(rows(at.db, "SELECT item_count FROM floor_boxes WHERE closed_at IS NULL")).toEqual([
      { item_count: 1 },
    ]);
  });

  it("makes a scan that arrives during a close wait, and takes it into the next box", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const held = holdingWrites(at.local);
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.scan(km("R1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    held.holdNext();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    });
    await held.reached();
    // The close is held in the middle of its write; the scan comes.
    await screenWork.scanner.read(km("R2"));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    held.release();
    await screenWork.settled();
    expect(
      rows(
        at.db,
        "SELECT item_count, closed_at IS NOT NULL AS closed FROM floor_boxes ORDER BY closed_at IS NULL",
      ),
    ).toEqual([
      { item_count: 1, closed: 1 },
      { item_count: 1, closed: 0 },
    ]);
    expect(shown("Открытый короб")).toBe("1 из 12");
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("does not read the code in front of a full box whose close fails once the line was released", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    await fullBoxLeftByAStoppedStation(at, "Q2");
    let reads = 0;
    let failing = true;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        (reads += 1) === 1
          ? Promise.reject(new LocalDbError("statement_failed", "disk busy"))
          : at.local.query(sql, params, row),
      transaction: (statements) =>
        failing && isClose(statements)
          ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
          : at.local.transaction(statements),
    };
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    await screen.findByText("Смена не прочитана");
    await screenWork.press("Понятно");
    const scans = rows(at.db, "SELECT count(*) AS n FROM floor_scans");
    // The close in front of the code fails: the code is not taken, and the line is stopped again.
    await screenWork.scan(km("Q2-NEW"));
    expect(screen.getByText(CLOSE_FAILED)).toBeTruthy();
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual(scans);
    expect(fullestBox(at.db)).toBe(12);
    failing = false;
    await screenWork.press("Повторить");
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("starts a close the operator asked for only after the scan in front of it", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const held = holdingWrites(at.local);
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.scan(km("W1"));
    held.holdNext();
    await screenWork.scanner.read(km("W2"));
    await held.reached();
    // The second code's write is held; the operator asks to close the box.
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    });
    expect(rows(at.db, "SELECT closed_at FROM floor_boxes")).toEqual([{ closed_at: null }]);
    held.release();
    await screenWork.settled();
    expect(
      rows(at.db, "SELECT item_count, closed_at IS NOT NULL AS closed FROM floor_boxes"),
    ).toEqual([{ item_count: 2, closed: 1 }]);
    expect(screen.queryByText("Скан не записан")).toBeNull();
  });

  it("closes the box and goes on when the plan of the label fails in its own hands", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const onClosed = vi.fn<(box: ClosingBox) => void>(() => {
      throw new Error("the printer is gone");
    });
    const screenWork = work(at, { onClosed });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`Y${index}`));
    expect(onClosed).toHaveBeenCalledTimes(1);
    // The box is closed and counted, and nothing stops the line for the label's failure.
    expect(shown("Коробов закрыто")).toBe("1");
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    await screenWork.scan(km("Y12"));
    expect(shown("Открытый короб")).toBe("1 из 12");
  });

  it("lets nothing close a box by hand while the operator leaves", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("Z1"));
    const close = screen.getByRole("button", { name: "Закрыть короб" });
    expect(close.hasAttribute("disabled")).toBe(false);
    screenWork.rerender({ leaving: true });
    expect(close.hasAttribute("disabled")).toBe(true);
  });

  it("stops the line when a close finds no box that was just read, so a full box never goes unheld", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let hiding = true;
    let justRead = false;
    const local: LocalExecutor = {
      query: async (sql, params, row) => {
        const open = sql.startsWith("SELECT id, opened_at, item_count FROM floor_boxes");
        // The read of the open box that follows another at once is the close's own: it
        // finds nothing, as if a writer outside the queue had taken the box in between.
        const hide = hiding && open && justRead;
        // The read of the shift's waiting label (plan 2a7) sits between the two reads.
        if (!sql.includes("floor_print_jobs")) justRead = open;
        return hide ? [] : at.local.query(sql, params, row);
      },
      transaction: (statements) => {
        justRead = false;
        return at.local.transaction(statements);
      },
    };
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`EM${index}`));
    heardOnce(CLOSE_FAILED);
    await screenWork.scan(km("EM12"));
    expect(fullestBox(at.db)).toBe(12);
    hiding = false;
    await screenWork.press("Повторить");
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("goes on when the totals cannot be read after a close, and says nothing of it", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let closed = false;
    const local: LocalExecutor = {
      // The totals' reads fail once the box is closed; the label's state (plan 2a7) is read.
      query: (sql, params, row) =>
        closed && !sql.includes("floor_print_jobs")
          ? Promise.reject(new LocalDbError("statement_failed", "disk busy"))
          : at.local.query(sql, params, row),
      transaction: async (statements) => {
        const done = await at.local.transaction(statements);
        if (isClose(statements)) closed = true;
        return done;
      },
    };
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.scan(km("TT1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    await screenWork.press("Закрыть короб");
    expect(rows(at.db, "SELECT sscc FROM floor_boxes WHERE closed_at IS NOT NULL")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
    // The box is closed: a read that fails afterwards stops nothing.
    expect(screen.queryByText("Скан не записан")).toBeNull();
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
  });

  it("ends the three tries of a close that finds the box changed in «Повторить»", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let stale = true;
    let closes = 0;
    const local = around(at.local, (statements, run) => {
      if (!isClose(statements)) return run();
      closes += 1;
      return stale
        ? Promise.reject(new LocalDbError("changes_mismatch", "the cursor moved"))
        : run();
    });
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`T${index}`));
    expect(closes).toBe(3);
    expect(screen.getByText(CLOSE_FAILED)).toBeTruthy();
    await screenWork.scan(km("T12"));
    expect(fullestBox(at.db)).toBe(12);
    stale = false;
    await screenWork.press("Повторить");
    expect(closes).toBe(4);
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("says of a serial that does not fit that it is out of range or already held, and takes the next", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    // A box of a former pairing holds the SSCC of the block's first serial.
    at.db
      .prepare(
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
          "block_id, serial, item_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
        "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f",
        "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
        "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        "2026-10-08T06:10:00.000Z",
        "2026-10-08T06:11:00.000Z",
        buildSscc(0, PREFIX, 1500),
        "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f",
        1500,
        5,
      );
    const screenWork = work(at);
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`U${index}`));
    expect(screen.getByText(CLOSE_FAILED)).toBeTruthy();
    // Both causes, whichever it was: past what the prefix numbers, or held by a box.
    expect(
      screen.getByText(
        "Номер SSCC из блока станции не подошёл: он вне диапазона префикса или уже занят другим коробом. Номер пропущен — повторите закрытие.",
      ),
    ).toBeTruthy();
    await screenWork.press("Повторить");
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    expect(
      rows(
        at.db,
        "SELECT sscc FROM floor_boxes WHERE device_id = ? AND closed_at IS NOT NULL",
        PAIRING.deviceId,
      ),
    ).toEqual([{ sscc: buildSscc(0, PREFIX, 1501) }]);
  });

  it("finds the box closed when the answer of its close was lost, and goes on as after a close", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let losing = true;
    const local = around(at.local, async (statements, run) => {
      const done = await run();
      if (losing && isClose(statements)) {
        throw new LocalDbError("statement_failed", "the answer was lost");
      }
      return done;
    });
    const onClosed = vi.fn<(box: ClosingBox) => void>();
    const screenWork = work({ ...at, local }, { onClosed });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`V${index}`));
    // The write is in the database, the answer never came: the screen says the close failed.
    expect(screen.getByText(CLOSE_FAILED)).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
    expect(rows(at.db, "SELECT sscc FROM floor_boxes WHERE closed_at IS NOT NULL")).toEqual([
      { sscc: buildSscc(0, PREFIX, 1500) },
    ]);
    const recorded = vi.mocked(screenWork.props.onRecorded).mock.calls.length;
    losing = false;
    await screenWork.press("Повторить");
    // The retry finds no open box: the box is read back from the database as it was closed.
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed.mock.calls[0]?.[0]).toMatchObject({
      sscc: buildSscc(0, PREFIX, 1500),
      blockId: BLOCK_ID,
      serial: 1500,
      itemCount: 12,
      operatorId: OPERATOR_ID,
      shiftId: ENTERED.id,
    });
    expect(onClosed.mock.calls[0]?.[0].codeHashes).toHaveLength(12);
    expect(onClosed.mock.calls[0]?.[0].closedAt).toBe(
      String(
        rows(at.db, "SELECT closed_at FROM floor_boxes WHERE closed_at IS NOT NULL")[0]?.[
          "closed_at"
        ],
      ),
    );
    expect(vi.mocked(screenWork.props.onRecorded).mock.calls.length).toBeGreaterThan(recorded);
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
    // One serial, one box: nothing was closed or spent twice.
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 1501 },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 1 },
    ]);
    // And it is told once: the next close of another box is another box.
    await screenWork.scan(km("V12"));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("does not take a box for closed when the write of its close never happened", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let failing = true;
    const local = around(at.local, (statements, run) =>
      failing && isClose(statements)
        ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
        : run(),
    );
    const onClosed = vi.fn<(box: ClosingBox) => void>();
    const screenWork = work({ ...at, local }, { onClosed });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`W${index}`));
    failing = false;
    await screenWork.press("Повторить");
    // Closed by the retry itself, once, and told once.
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")).toEqual([
      { n: 1 },
    ]);
    expect(rows(at.db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
      { next_serial: 1501 },
    ]);
  });
});

describe("the work screen's supply of serials", () => {
  it("has one supply for its life, so a new request function does not start a second request", async () => {
    const at = await station();
    let answer: (block: SsccBlock) => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<SsccBlock>((resolve) => {
          answer = resolve;
        }),
    );
    const second = vi.fn(async (request: SsccBlockRequest) => blockFor(request));
    const screenWork = work(at, { online: true, requestBlock: first });
    await screenWork.scanner.listening();
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    // The floor gives the screen another function, and the link blinks: the
    // top-up that runs is the one top-up there is.
    screenWork.rerender({ requestBlock: second });
    screenWork.rerender({ online: false });
    screenWork.rerender({ online: true });
    await screenWork.scanner.listening();
    await act(async () => {
      answer(blockFor({ requestId: "x", issuerPrefix: PREFIX, extension: 0 }));
    });
    await screenWork.settled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(screen.queryByText("Скан не записан")).toBeNull();
    expect(rows(at.db, "SELECT block_id FROM floor_sscc_blocks")).toEqual([{ block_id: BLOCK_ID }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 0 }]);
  });

  it("tells the shell of a block it keeps when it comes on entry", async () => {
    const at = await station();
    const onRecorded = vi.fn();
    const screenWork = work(at, { online: true, onRecorded });
    await screenWork.scanner.listening();
    await screenWork.settled();
    // The station had no block: one came and was kept, and the status bar reads the serials again.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // The blink of the link finds the block enough: nothing is asked and nothing is told.
    screenWork.rerender({ online: false });
    screenWork.rerender({ online: true });
    await screenWork.settled();
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it("tells the shell of the block that came while a close waited for it", async () => {
    const at = await station();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
      )
      .mockImplementation(async (request) => blockFor(request));
    const onRecorded = vi.fn();
    const screenWork = work(at, { online: true, requestBlock, onRecorded });
    await screenWork.scanner.listening();
    await screenWork.settled();
    // The request on entry went unanswered: no block, and the request stays.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 1 }]);
    for (let index = 0; index < 11; index += 1) await screenWork.scan(km(`BL${index}`));
    const before = onRecorded.mock.calls.length;
    await screenWork.scan(km("BL11"));
    // The twelfth code's record, the block the close asked for, and the closed box.
    expect(onRecorded.mock.calls.length - before).toBe(3);
    expect(shown("Коробов закрыто")).toBe("1");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 0 }]);
  });

  it("hands the top-up of the link's return to the gate before it reads or writes anything", async () => {
    const at = await station();
    let pendingNow: () => number = () => -1;
    const seen: number[] = [];
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        if (sql.includes("floor_block_requests") || sql.includes("floor_sscc_blocks")) {
          seen.push(pendingNow());
        }
        return at.local.query(sql, params, row);
      },
      transaction: (statements) => at.local.transaction(statements),
    };
    const screenWork = work({ ...at, local });
    pendingNow = screenWork.gate.pending;
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(seen).toEqual([]);
    screenWork.rerender({ online: true });
    await screenWork.settled();
    // The top-up read the requests and the blocks only after the gate knew it.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((pending) => pending >= 1)).toBe(true);
  });

  it("does not stop the line for a failed write of the request for serials", async () => {
    const at = await station();
    const local = around(at.local, (statements, run) =>
      statements.some((statement) => statement.sql.includes("floor_block_requests"))
        ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
        : run(),
    );
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    screenWork.rerender({ online: true });
    await screenWork.settled();
    expect(screen.queryByText("Скан не записан")).toBeNull();
    await screenWork.scan(km("NQ1"));
    expect(shown("Принято в смене")).toBe("1");
  });

  it("hands the top-up of the link's return to the gate before it writes", async () => {
    const at = await station();
    const held = holdingWrites(at.local);
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 1500 });
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.settled();
    expect(screenWork.gate.pending()).toBe(0);
    // The link comes back and the half rule asks for a block: the request is
    // written, and the leave already waits for it.
    at.db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1501").run();
    held.holdNext();
    screenWork.rerender({ online: true });
    await held.reached();
    expect(screenWork.gate.pending()).toBe(1);
    held.release();
    await screenWork.settled();
    expect(screenWork.gate.pending()).toBe(0);
  });

  it("hands the top-up after a close to the gate, and tells the shell of its block", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 1500, to: 1500 });
    let answer: (block: SsccBlock) => void = () => undefined;
    const requestBlock = vi.fn(
      () =>
        new Promise<SsccBlock>((resolve) => {
          answer = resolve;
        }),
    );
    const onRecorded = vi.fn();
    const screenWork = work(at, { online: true, requestBlock, onRecorded });
    await screenWork.scanner.listening();
    await screenWork.settled();
    for (let index = 0; index < 11; index += 1) await screenWork.scan(km(`X${index}`));
    await screenWork.scanner.read(km("X11"));
    // The last serial went with the box: a block is asked for, and the gate waits for the answer.
    await waitFor(() => expect(requestBlock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
    await waitFor(() => expect(screenWork.gate.pending()).toBe(1));
    const before = onRecorded.mock.calls.length;
    await act(async () => {
      answer(blockFor({ requestId: "x", issuerPrefix: PREFIX, extension: 0 }));
      await screenWork.gate.drain();
    });
    expect(onRecorded.mock.calls.length).toBe(before + 1);
    expect(screenWork.gate.pending()).toBe(0);
  });
});

describe("the work screen's obligations to the floor", () => {
  it("hands the write of an incomplete close to the gate before it starts", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const held = holdingWrites(at.local);
    const screenWork = work({ ...at, local: held.executor });
    await screenWork.scanner.listening();
    await screenWork.scan(km("Y1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    held.holdNext();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    });
    await held.reached();
    expect(screenWork.gate.pending()).toBe(1);
    held.release();
    await screenWork.settled();
    expect(shown("Коробов закрыто")).toBe("1");
  });

  it("hands the close of a box left full to the gate on entry, before it writes", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    await fullBoxLeftByAStoppedStation(at, "Z");
    const held = holdingWrites(at.local);
    held.holdNext();
    const screenWork = work({ ...at, local: held.executor });
    // The entry runs from an effect: its updates are the act's to wait for.
    await act(async () => {
      await held.reached();
    });
    expect(screenWork.gate.pending()).toBe(1);
    await act(async () => {
      held.release();
      await screenWork.gate.drain();
    });
    await waitFor(() => expect(shown("Коробов закрыто")).toBe("1"));
  });

  it("puts the stop of the line into a polite region that was on the screen before, without a second alert", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    const region = alertsRegion();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`G${index}`));
    const title = screen.getByText(NO_SERIALS);
    expect(alertsRegion()).toBe(region);
    expect(region.contains(title)).toBe(true);
    // Heard once, from the region: the component's own `alert` role is off.
    expect(title.closest('[role="alert"]')).toBeNull();
    expect(title.closest('[role="presentation"]')).not.toBeNull();
  });

  it("gives every button of the screen the floor's size", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("B1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
    // «Продолжить заполнять», «Закрыть короб», «Исключения», «Закрыть смену» (plan 2a8), «Выйти из
    // смены», and the open box's own «Снять последний код» and «Очистить короб» (the cloud's box
    // instrument, owner's decision of 2026-10-13).
    expect(screen.getAllByRole("button")).toHaveLength(7);
  });

  it("writes nothing to the console, whatever the scan was", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const at = await station();
      const screenWork = work(at);
      await screenWork.scanner.listening();
      await screenWork.scan(km("LOG1"));
      await screenWork.scan("MRK-000742");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

/**
 * An online screen whose entry's request for serials waits at the host, and
 * whose box twelve codes fill: the close of the twelfth finds no serial and
 * has to ask. `release` lets the host answer every request it was asked.
 */
async function boxFilledWhileTheEntryRequestWaits(prefix: string) {
  const at = await station();
  let blockReads = 0;
  const counting: LocalExecutor = {
    query: (sql, params, row) => {
      if (sql.startsWith("SELECT block_id, next_serial FROM floor_sscc_blocks")) blockReads += 1;
      return at.local.query(sql, params, row);
    },
    transaction: (statements) => at.local.transaction(statements),
  };
  const answers: Array<() => void> = [];
  const requestBlock = vi.fn(
    (request: SsccBlockRequest) =>
      new Promise<SsccBlock>((resolve) => {
        answers.push(() => resolve(blockFor(request)));
      }),
  );
  const screenWork = work({ ...at, local: counting }, { online: true, requestBlock });
  await screenWork.scanner.listening();
  await waitFor(() => expect(requestBlock).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 12; index += 1)
    await screenWork.scanner.read(km(`${prefix}${index}`));
  // The twelfth fills the box, and its close looks for a serial.
  await waitFor(() => expect(blockReads).toBeGreaterThan(0));
  // Every hop of the close has run, in promises only: it has asked, or joined the request.
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
  return {
    at,
    screenWork,
    requestBlock,
    release: () =>
      act(async () => {
        for (const answer of answers) answer();
        await screenWork.gate.drain();
      }),
  };
}

describe("the work screen: one supply on every path, and a close that waits", () => {
  it("closes a box on the screen's one supply, so a close joins the request the entry made", async () => {
    const held = await boxFilledWhileTheEntryRequestWaits("U");
    // The entry's request is the only one: the close of the twelfth code waits for it.
    expect(held.requestBlock).toHaveBeenCalledTimes(1);
    await held.release();
    expect(held.requestBlock).toHaveBeenCalledTimes(1);
    expect(rows(held.at.db, "SELECT block_id FROM floor_sscc_blocks")).toEqual([
      { block_id: BLOCK_ID },
    ]);
    expect(rows(held.at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 0 }]);
    expect(shown("Коробов закрыто")).toBe("1");
    expect(screen.queryByText(CLOSE_FAILED)).toBeNull();
    expect(screen.queryByText(NO_SERIALS)).toBeNull();
  });

  it("says that a close waits for the host's serials while it does, and stops saying it after", async () => {
    const held = await boxFilledWhileTheEntryRequestWaits("W");
    const waiting = screen.getByText("Закрываем короб: ждём номера SSCC от хоста…");
    expect(alertsRegion().contains(waiting)).toBe(true);
    await held.release();
    expect(screen.queryByText("Закрываем короб: ждём номера SSCC от хоста…")).toBeNull();
    expect(shown("Коробов закрыто")).toBe("1");
  });
});

describe("the work screen: a leave that a render has not shown yet, and the buttons while it waits", () => {
  it("refuses a scan once the floor knows it is leaving, before a render says so", async () => {
    const at = await station();
    let leavingNow = false;
    const screenWork = work(at, { isLeaving: () => leavingNow });
    await screenWork.scanner.listening();
    await screenWork.settled();
    leavingNow = true;
    await screenWork.scan(km("N1"));
    expect(lastLine()).toBe("Скан не принят: идёт выход из смены.");
    expect(screenWork.props.signal).toHaveBeenLastCalledWith("error");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
  });

  it("starts no close from «Повторить» while the operator leaves", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`R${index}`));
    expect(screen.getByText(NO_SERIALS)).toBeTruthy();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    screenWork.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Повторить" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await screenWork.press("Повторить");
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NOT NULL"),
    ).toEqual([{ n: 0 }]);
    // The leave over (the floor stays), the same press closes the box.
    screenWork.rerender({ leaving: false });
    await screenWork.press("Повторить");
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NOT NULL"),
    ).toEqual([{ n: 1 }]);
  });

  it("starts no close from «Повторить» of a close that failed while the operator leaves", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let closes = 0;
    const local = around(at.local, (statements, run) => {
      if (!isClose(statements)) return run();
      closes += 1;
      return Promise.reject(new LocalDbError("statement_failed", "disk full"));
    });
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`J${index}`));
    expect(screen.getByText(CLOSE_FAILED)).toBeTruthy();
    const tried = closes;
    screenWork.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Повторить" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await screenWork.press("Повторить");
    expect(closes).toBe(tried);
  });

  it("starts no close from the confirmation while the floor is leaving, and says it is not available", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    let leavingNow = false;
    const screenWork = work(at, { isLeaving: () => leavingNow });
    await screenWork.scanner.listening();
    await screenWork.scan(km("T1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    // The leave comes from a timer: the render has not shown it.
    leavingNow = true;
    await screenWork.press("Закрыть короб");
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NOT NULL"),
    ).toEqual([{ n: 0 }]);
    screenWork.rerender({ leaving: true });
    expect(
      screen.getByRole("button", { name: "Закрыть короб" }).getAttribute("aria-disabled"),
    ).toBe("true");
    // The safe answer is still there.
    expect(screen.getByRole("button", { name: "Продолжить сборку" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("the work screen: words that match the situation", () => {
  it("does not promise serials to a screen whose link is held for the rest of the shift", async () => {
    const at = await station();
    const screenWork = work(at, { linkHeld: true });
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`H${index}`));
    expect(screen.getByText(/Связь с хостом остановлена до выхода из смены/)).toBeTruthy();
    expect(screen.queryByText(/Короб закроется, как только номера придут/)).toBeNull();
    // Without the hold the link may come back, and the text says the box will close.
    screenWork.rerender({ linkHeld: false });
    expect(screen.getByText(/Короб закроется, как только номера придут/)).toBeTruthy();
    expect(screen.queryByText(/Связь с хостом остановлена до выхода из смены/)).toBeNull();
  });
});

describe("the work screen: the focus after a message is answered", () => {
  it("returns the focus to «Закрыть короб» when «Продолжить сборку» takes its own button away", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("V1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    const keep = screen.getByRole("button", { name: "Продолжить сборку" });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Закрыть короб" }));
  });

  it("returns the focus to the last-scan line after a close the operator asked for has emptied the box", async () => {
    const at = await station();
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("X1"));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));
    await screenWork.press("Закрыть короб");
    expect(shown("Коробов закрыто")).toBe("1");
    // The confirmation and the box it closed are gone: the line is the place, not a disabled button.
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
  });

  it("returns the focus to the last-scan line after «Повторить» closes the box", async () => {
    const at = await station();
    const screenWork = work(at);
    await screenWork.scanner.listening();
    for (let index = 0; index < 12; index += 1) await screenWork.scan(km(`Y${index}`));
    seedBlock(at.db, { blockId: BLOCK_ID, from: 1500, to: 3499 });
    const retry = screen.getByRole("button", { name: "Повторить" });
    retry.focus();
    await screenWork.press("Повторить");
    expect(shown("Коробов закрыто")).toBe("1");
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
  });

  it("returns the focus to «Закрыть короб» after the notice of the plan", async () => {
    const at = await station({ ...ENTERED, plannedQty: 2 });
    const screenWork = work(at);
    await screenWork.scanner.listening();
    await screenWork.scan(km("P1"));
    await screenWork.scan(km("P2"));
    const next = screen.getByRole("button", { name: "Продолжить" });
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Закрыть короб" }));
  });

  it("returns the focus to the last-scan line when the box is empty and there is nothing to close", async () => {
    const at = await station();
    let broken = false;
    const local = around(at.local, (statements, run) =>
      broken ? Promise.reject(new LocalDbError("statement_failed", "disk full")) : run(),
    );
    const screenWork = work({ ...at, local });
    await screenWork.scanner.listening();
    await screenWork.settled();
    broken = true;
    await screenWork.scan(km("E1"));
    broken = false;
    const dismiss = screen.getByRole("button", { name: "Понятно" });
    dismiss.focus();
    fireEvent.click(dismiss);
    // Not on a button that could leave or close by a stray key.
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
    // The dismissal reads the shift's label again (plan 2a7), as work of the line.
    await screenWork.settled();
  });
});
