import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
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
const REVISION = "11111111-1111-4111-8111-111111111111";

describe("Idle", () => {
  it("renders tenant identity with a bundled Markiro fallback and the approved login grid", () => {
    const { container } = render(
      <Idle
        branding={{
          organizationName: "Северная вода",
          logoBlob: null,
          revision: null,
          owner: null,
        }}
        onEmployee={vi.fn()}
        resolveBadge={vi.fn()}
        onScan={vi.fn()}
      />,
    );

    expect(screen.getByText("Северная вода")).toBeDefined();
    expect(screen.getAllByLabelText("Маркиро").length).toBeGreaterThan(0);
    expect(container.querySelector(".kiosk-login__visual")).toBeDefined();
    expect(container.querySelector(".kiosk-login__copy")).toBeDefined();
    expect(screen.queryByText(/Зона сканирования|Scan zone/i)).toBeNull();
  });

  it("offers a visible equipment-settings action after pairing", () => {
    const onOpenSettings = vi.fn();
    render(
      <Idle
        onEmployee={vi.fn()}
        resolveBadge={vi.fn()}
        onScan={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Настройки оборудования" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("uses equal landscape columns, left-aligned copy and reduced-motion fallback", () => {
    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");

    expect(css).toMatch(
      /\.kiosk-login__center[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(css).toMatch(/\.kiosk-login__copy[\s\S]*text-align:\s*left/);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.badge-scan-animation/,
    );
  });

  it("revokes and durably invalidates a cached logo that the browser cannot render", () => {
    const logo = new Blob(["platform-broken"], { type: "image/webp" });
    const onLogoError = vi.fn();
    const displayed = {
      organizationName: "Северная вода",
      logoBlob: logo,
      revision: REVISION,
      owner: {
        serverUrl: "https://kiosk.example",
        kioskId: "kiosk-1",
        credentialGeneration: "33333333-3333-4333-8333-333333333333",
      },
    };
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:company");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <Idle
        branding={displayed}
        onBrandingError={onLogoError}
        onEmployee={vi.fn()}
        resolveBadge={vi.fn()}
        onScan={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Северная вода" }));

    expect(revoke).toHaveBeenCalledWith("blob:company");
    expect(onLogoError).toHaveBeenCalledWith({
      owner: displayed.owner,
      revision: REVISION,
    });
    expect(screen.getAllByLabelText("Маркиро").length).toBeGreaterThan(0);
    create.mockRestore();
    revoke.mockRestore();
  });

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
    // Pinned as a whole sentence, not a prefix: the second clause is the half
    // that tells the worker the bottles are not lost, only early, and a regex
    // on the opening words would not notice it rotting.
    expect(
      await screen.findByText(
        "Сначала отсканируйте бейдж — бутылки можно будет отсканировать сразу после этого.",
      ),
    ).toBeDefined();
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

  // The in-flight guard has to be released on EVERY exit, not just the happy
  // one: a screen that swallows the one badge check it failed at is a kiosk
  // that is dead until someone reboots it, which is the worst thing this
  // screen can do. Both non-admitting outcomes are covered because they leave
  // the guard through different paths — `catch` and an early `return`.
  it.each([
    ["the check itself failed", () => Promise.reject(new Error("crypto is unavailable"))],
    ["the badge was not recognised", async () => null],
  ])("still takes the next badge after %s", async (_what, firstAttempt) => {
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const onEmployee = vi.fn();
      const resolveBadge = vi
        .fn<(raw: string) => Promise<string | null>>()
        .mockImplementationOnce(firstAttempt)
        .mockImplementation(async () => "e2");
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

      await act(async () => {
        emit("BADGE-1");
      });
      expect(await screen.findByText(/Бейдж не распознан/)).toBeDefined();
      expect(onEmployee).not.toHaveBeenCalled();

      await act(async () => {
        emit("BADGE-2");
      });
      await vi.waitFor(() => expect(onEmployee).toHaveBeenCalledTimes(1));
      expect(onEmployee).toHaveBeenCalledWith("e2");
    } finally {
      failure.mockRestore();
    }
  });

  // The check outlives the screen: a derivation started here can still be
  // running when the shell swaps the kiosk to another view, and landing then
  // would sign in a worker who has already walked away — behind whatever screen
  // replaced this one, where nobody can see it happened.
  it("admits nobody when the badge resolves after the screen is gone", async () => {
    const onEmployee = vi.fn();
    let release!: (employeeId: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    let emit!: ScanListener;
    const { unmount } = render(
      <Idle
        onEmployee={onEmployee}
        resolveBadge={() => pending}
        onScan={(cb) => {
          emit = cb;
        }}
      />,
    );

    act(() => {
      emit("BADGE-1");
    });
    unmount();

    await act(async () => {
      release("e1");
      await pending;
    });
    expect(onEmployee).not.toHaveBeenCalled();
  });

  // Admitted is admitted. A bottle waved at the scanner in the moment between
  // the badge landing and the shell routing away must not answer the worker
  // with «scan your badge first» — they just did, and it worked.
  it("says nothing more once someone has been admitted", async () => {
    const onEmployee = vi.fn();
    let emit!: ScanListener;
    render(
      <Idle
        onEmployee={onEmployee}
        resolveBadge={async () => "e1"}
        onScan={(cb) => {
          emit = cb;
        }}
      />,
    );

    await act(async () => {
      emit("BADGE-1");
    });
    await vi.waitFor(() => expect(onEmployee).toHaveBeenCalledTimes(1));

    await act(async () => {
      emit(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);
    });
    expect(screen.queryByText(/Сначала отсканируйте бейдж/)).toBeNull();
    expect(onEmployee).toHaveBeenCalledTimes(1);
  });
});
