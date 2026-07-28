import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { ScanListener } from "../src/scanner/source.js";
import { Idle } from "../src/screens/Idle.js";

afterEach(cleanup);

// The i18next instance is a module singleton and the sibling screen tests
// switch it to English. Today Vitest's per-file module isolation keeps that out
// of this file, but the assertions below read RU copy and must not depend on
// an isolation setting to stay true — so pin the language here explicitly.
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

const GS = String.fromCharCode(0x1d);
const GTIN = "04600682000013";

describe("Idle", () => {
  it("hands the recognised employee to its caller", async () => {
    const onEmployee = vi.fn();
    const resolveBadge = vi.fn(async () => "e1");
    render(
      <Idle onEmployee={onEmployee} resolveBadge={resolveBadge} onScan={(cb) => cb("BADGE-1")} />,
    );
    // The plan wrote this as `expect(await vi.waitFor(() => onEmployee.mock.calls.length)).toBe(1)`,
    // which cannot pass: `vi.waitFor` calls its callback once, synchronously,
    // and resolves with the first value that neither throws nor is a thenable.
    // `render` is synchronous and `resolveBadge` is not, so that first value is
    // always 0 and no retry ever happens. Asserting INSIDE the callback keeps
    // the intent — wait until exactly one employee has been handed over — and
    // gives `waitFor` the throw it needs to keep waiting.
    await vi.waitFor(() => expect(onEmployee).toHaveBeenCalledTimes(1));
    expect(onEmployee).toHaveBeenCalledWith("e1");
  });

  it("tells the worker when the badge is not recognised, and lets no one in", async () => {
    const onEmployee = vi.fn();
    render(
      <Idle onEmployee={onEmployee} resolveBadge={async () => null} onScan={(cb) => cb("NOPE")} />,
    );
    expect(await screen.findByText(/Бейдж не распознан/)).toBeDefined();
    expect(onEmployee).not.toHaveBeenCalled();
  });

  it("ignores a marking code scanned at the idle screen instead of treating it as a badge", async () => {
    const resolveBadge = vi.fn();
    render(
      <Idle
        onEmployee={vi.fn()}
        resolveBadge={resolveBadge}
        onScan={(cb) => cb(`01${GTIN}21KYC9X7MQ${GS}93Abcd`)}
      />,
    );
    expect(resolveBadge).not.toHaveBeenCalled();
  });

  // A scan the idle screen cannot use is still a scan the worker made, and
  // dropping it in silence is indistinguishable from a dead scanner — the same
  // rule Task 8 settled for the cart's `not-a-code`. Every non-badge verdict of
  // `classifyKioskScan` earns the same hint, because at this screen the fix is
  // the same one regardless of what was actually read.
  it.each([
    ["a marking code", `01${GTIN}21KYC9X7MQ${GS}93Abcd`],
    ["a marking code whose GS was dropped", `01${GTIN}21KYC9X7MQ93Abcd`],
    ["a bare product barcode", GTIN],
  ])("asks for a badge when the scan was %s, without trying to resolve it", async (_what, raw) => {
    const resolveBadge = vi.fn();
    const onEmployee = vi.fn();
    render(<Idle onEmployee={onEmployee} resolveBadge={resolveBadge} onScan={(cb) => cb(raw)} />);
    expect(await screen.findByText(/Сначала отсканируйте бейдж/)).toBeDefined();
    expect(resolveBadge).not.toHaveBeenCalled();
    expect(onEmployee).not.toHaveBeenCalled();
  });

  it("never renders the scanned payload, which at this screen is a credential", async () => {
    render(
      <Idle onEmployee={vi.fn()} resolveBadge={async () => null} onScan={(cb) => cb("BADGE-1")} />,
    );
    expect(await screen.findByText(/Бейдж не распознан/)).toBeDefined();
    expect(document.body.textContent).not.toContain("BADGE-1");
  });

  it("lets go of the scanner when it leaves the screen", () => {
    const stop = vi.fn();
    const { unmount } = render(
      <Idle onEmployee={vi.fn()} resolveBadge={vi.fn()} onScan={() => stop} />,
    );
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // The badge check is a PBKDF2 derivation, so it is slow enough for a second
  // scan to land inside it — a worker double-tapping the badge, or the person
  // behind them. Admitting twice would open a second session over the first.
  // Driven by a deferred promise rather than a timer so the window is held open
  // for exactly as long as the test wants, with no wall-clock guesswork.
  it("admits exactly one person when a second badge lands inside a slow check", async () => {
    const onEmployee = vi.fn();
    let release!: (employeeId: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const resolveBadge = vi.fn(() => pending);
    let emit!: ScanListener;
    render(
      <Idle
        onEmployee={onEmployee}
        resolveBadge={resolveBadge}
        onScan={(cb) => {
          emit = cb;
        }}
      />,
    );

    act(() => {
      emit("BADGE-1");
      emit("BADGE-1");
    });
    expect(resolveBadge).toHaveBeenCalledTimes(1);

    await act(async () => {
      release("e1");
      await pending;
    });
    expect(onEmployee).toHaveBeenCalledTimes(1);
    expect(onEmployee).toHaveBeenCalledWith("e1");
  });

  it("says the badge was not recognised when the check itself fails, and admits nobody", async () => {
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const onEmployee = vi.fn();
      render(
        <Idle
          onEmployee={onEmployee}
          resolveBadge={() => Promise.reject(new Error("crypto is unavailable"))}
          onScan={(cb) => cb("BADGE-1")}
        />,
      );
      expect(await screen.findByText(/Бейдж не распознан/)).toBeDefined();
      expect(onEmployee).not.toHaveBeenCalled();
    } finally {
      failure.mockRestore();
    }
  });
});
