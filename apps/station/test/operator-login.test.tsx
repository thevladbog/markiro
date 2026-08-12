import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, replaceOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import * as crypto from "../src/lib/crypto.js";
import { hashSecret } from "../src/lib/crypto.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { createKeyboardWedgeSource } from "../src/lib/scan-source.js";
import { OperatorLogin } from "../src/pages/OperatorLogin.js";
import "../src/station.css";

const repositoryRoot = existsSync(resolve(process.cwd(), "apps/station/src/station.css"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const stationCss = readFileSync(resolve(repositoryRoot, "apps/station/src/station.css"), "utf8");
const uiTokensCss = readFileSync(resolve(repositoryRoot, "packages/ui/src/tokens.css"), "utf8");

const silentSource: ScanSource = { start: () => () => {} };

function manualSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
  };
  return {
    source,
    scan(raw: string) {
      listener?.(raw);
    },
    active() {
      return listener !== null;
    },
  };
}

function retainedSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      // Deliberately retain the callback after cleanup to model an async
      // native subscription whose final event was already in flight.
      return () => {};
    },
  };
  return {
    source,
    scanRetired(raw: string) {
      listener?.(raw);
    },
  };
}

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function openNumericFallback() {
  fireEvent.click(screen.getByRole("button", { name: "Use personnel number" }));
}

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "ms").exec(stationCss)?.[1] ?? "";
}

describe("OperatorLogin", () => {
  it("keeps Markiro Station framing and spaced bounded actions across sign-in stages", async () => {
    render(
      <OperatorLogin online={false} exec={makeExec()} source={silentSource} onAuthed={vi.fn()} />,
    );

    expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
    expect(document.querySelector(".operator-login__actions")).not.toBeNull();

    openNumericFallback();
    expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
    expect(document.querySelector(".operator-login__actions")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
    expect(document.querySelector(".operator-login__actions")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    await screen.findByRole("textbox", { name: "Operator name" });
    expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
    expect(document.querySelector(".operator-login__actions")).not.toBeNull();

    expect(stationCss).toMatch(/\.operator-login__actions\s*\{[^}]*gap:\s*var\(--sp-3\)/s);
    expect(stationCss).toMatch(
      /\.operator-login__actions\s*\{[^}]*grid-template-columns:\s*repeat\([^,]+,\s*minmax\(0,\s*[^)]+\)\)/s,
    );
  });

  it("starts in a badge-first state and opens the numeric fallback on a deliberate touch", () => {
    const { container } = render(
      <OperatorLogin online={false} exec={makeExec()} source={silentSource} onAuthed={vi.fn()} />,
    );

    expect(screen.getByText("Scan your badge to sign in")).toBeDefined();
    expect(screen.getByText("Hold the badge near the scanner")).toBeDefined();
    expect(
      screen.getByText(
        "The station recognizes the code automatically. If the operator was just added, the roster will refresh from the server.",
      ),
    ).toBeDefined();
    expect(screen.getByTestId("badge-scan-illustration")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Badge scan illustration" })).toBeNull();
    expect(container.textContent).not.toContain("▣");
    expect(stationCss).not.toMatch(/operator-login__badge-panel[^}]*dashed/s);
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();

    openNumericFallback();
    expect(screen.getByRole("button", { name: "1" })).toBeDefined();
  });

  it("pads a one-digit login only to the 3-digit storage minimum", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-short",
        name: "Short Login",
        login: "001",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    for (const digit of "4821") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(onAuthed.mock.calls[0]![0]).toMatchObject({ login: "001" });
  });

  it("selects a bounded name result but still requires the selected exact login's PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-name",
        name: "Alex Morgan",
        login: "000123",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = screen.getByRole("textbox", { name: "Operator name" });
    fireEvent.change(search, { target: { value: "  AL " } });
    fireEvent.click(await screen.findByRole("button", { name: "Alex Morgan" }));
    expect(screen.getByText("Enter PIN for Alex Morgan")).toBeDefined();

    for (const digit of "4821") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(onAuthed.mock.calls[0]![0]).toMatchObject({ login: "000123" });
  });

  it("returns from a selected name to the same bounded roster search", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-name",
        name: "Alex Morgan",
        login: "123",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = screen.getByRole("textbox", { name: "Operator name" });
    fireEvent.change(search, { target: { value: "al" } });
    fireEvent.click(await screen.findByRole("button", { name: "Alex Morgan" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect((screen.getByRole("textbox", { name: "Operator name" }) as HTMLInputElement).value).toBe(
      "al",
    );
    expect(screen.getByRole("button", { name: "Alex Morgan" })).toBeDefined();
  });

  it("discards manual name keydowns before the next keyboard-wedge badge scan", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-name",
        name: "Alex Morgan",
        login: "123",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("BADGE-1"),
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(
      <OperatorLogin
        online={false}
        exec={exec}
        source={createKeyboardWedgeSource()}
        onAuthed={onAuthed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = screen.getByRole("textbox", { name: "Operator name" });
    fireEvent.keyDown(search, { key: "a" });
    fireEvent.keyDown(search, { key: "l" });
    fireEvent.change(search, { target: { value: "al" } });
    fireEvent.click(await screen.findByRole("button", { name: "Alex Morgan" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    for (const key of "BADGE-1") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  it("does not prefix an immediate badge scan with an active name query", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-name",
        name: "Alex Morgan",
        login: "123",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("BADGE-1"),
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    const wedge = createKeyboardWedgeSource();
    const routing = vi.spyOn(wedge, "setManualTextEntryActive");
    render(<OperatorLogin online={false} exec={exec} source={wedge} onAuthed={onAuthed} />);

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = screen.getByRole("textbox", { name: "Operator name" });
    fireEvent.focus(search);
    expect(routing).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(search, { key: "a" });
    fireEvent.keyDown(search, { key: "l" });
    fireEvent.change(search, { target: { value: "al" } });
    await screen.findByRole("button", { name: "Alex Morgan" });

    for (const key of "BADGE-1") fireEvent.keyDown(search, { key });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onAuthed).not.toHaveBeenCalled();
    expect(screen.queryByText("Badge not recognized")).toBeNull();
    expect((search as HTMLInputElement).value).toBe("al");

    fireEvent.blur(search);
    expect(routing).toHaveBeenLastCalledWith(false);
    for (const key of "BADGE-1") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  it("keeps critical authentication errors at floor-readable text size", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const scanner = manualSource();
    render(<OperatorLogin online={false} exec={exec} source={scanner.source} onAuthed={vi.fn()} />);

    act(() => scanner.scan("unknown"));

    const message = await screen.findByText("Badge not recognized");
    expect(message.className).toContain("operator-login__auth-message");
    expect((message as HTMLElement).style.fontSize).toBe("18px");
    expect(message.closest('[role="alert"]')).not.toBeNull();
    const reservedSlot = message.closest(".operator-login__message");
    expect(reservedSlot).not.toBeNull();
    expect(getComputedStyle(reservedSlot as Element).minHeight).toBe("64px");
  });

  it("clamps long Cyrillic and Latin operator names to one result line", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const cyrillicName = `Ал${"ександровна".repeat(18)}`;
    const latinName = `Al${"exanderson".repeat(18)}`;
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-ru",
        name: cyrillicName,
        login: "123",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
      {
        operatorId: "op-en",
        name: latinName,
        login: "124",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = screen.getByRole("textbox", { name: "Operator name" });
    for (const [query, name] of [
      ["al", latinName],
      ["ал", cyrillicName],
    ] as const) {
      fireEvent.change(search, { target: { value: query } });
      const button = await screen.findByRole("button", { name });
      const label = button.querySelector(".operator-name-search__result-label") as HTMLElement;
      expect(label).not.toBeNull();
      expect(label.style.overflow).toBe("hidden");
      expect(label.style.textOverflow).toBe("ellipsis");
      expect(label.style.whiteSpace).toBe("nowrap");
    }
  });

  it("fits five full floor search targets in the 1024x768 degraded composition", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const pinHash = await hashSecret("4821");
    await replaceOperatorsMirror(
      exec,
      Array.from({ length: 5 }, (_, index) => ({
        operatorId: `op-al-${index}`,
        name: `Alex Operator ${index + 1}`,
        login: String(200 + index),
        role: "operator",
        pinHash,
        badgeHash: null,
        active: true,
      })),
    );
    render(
      <OperatorLogin
        online={false}
        exec={exec}
        source={silentSource}
        onAuthed={vi.fn()}
        notice={<div>Legacy identity unavailable</div>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Operator name" }), {
      target: { value: "al" },
    });
    await screen.findByRole("button", { name: "Alex Operator 5" });

    const root = document.querySelector(".operator-login--with-notice");
    const results = document.querySelector(".operator-name-search__results");
    expect(root).not.toBeNull();
    expect(results).not.toBeNull();
    const targets = within(results as HTMLElement).getAllByRole("button");
    expect(targets).toHaveLength(5);
    for (const target of targets) expect(target.className).toContain("mk-btn--floor");
    expect(uiTokensCss).toMatch(/--control-floor:\s*64px/);

    expect(cssRule(".operator-name-search")).toContain("gap: var(--sp-3)");
    expect(cssRule(".operator-login--with-notice .operator-name-search")).toContain(
      "gap: var(--sp-1)",
    );
    expect(cssRule(".operator-login")).toContain("overflow: hidden");
    expect(cssRule(".operator-name-search")).toContain("overflow: hidden");
    expect(cssRule(".operator-name-search__results")).toContain("overflow: hidden");

    const degradedBodyHeight = 452;
    const requiredHeight = 96 + 4 + 5 * 64 + 4 * 8;
    expect(requiredHeight).toBe(degradedBodyHeight);
  });

  it("signs in with a personnel number then a PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    // Stage 1: personnel number -> Next
    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Stage 2: PIN -> Sign in
    for (const digit of "4821") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(onAuthed.mock.calls[0]![0]).toMatchObject({ operatorId: "op-1", login: "1042" });
  });

  it("enables submission only for 4-6 digits and caps the floor PIN pad at six", () => {
    render(
      <OperatorLogin online={false} exec={makeExec()} source={silentSource} onAuthed={vi.fn()} />,
    );

    openNumericFallback();
    for (const digit of "1042") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const signIn = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    for (const digit of "123") fireEvent.click(screen.getByRole("button", { name: digit }));
    expect(signIn.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(signIn.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "6" }));
    expect(signIn.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    expect(screen.getByLabelText("pin").textContent).toBe("••••••");
  });

  it("disables PIN input and submission while a valid 6-digit verification is busy", async () => {
    let releaseQuery: (() => void) | undefined;
    const pending = new Promise<never[]>((resolve) => {
      releaseQuery = () => resolve([]);
    });
    const exec: SqlExecutor = { run: async () => {}, all: async () => pending };
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={vi.fn()} />);

    openNumericFallback();
    for (const digit of "1042") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    for (const digit of "123456") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect((screen.getByRole("button", { name: "1" }) as HTMLButtonElement).disabled).toBe(true);
    releaseQuery?.();
    await screen.findByText("Wrong personnel number or PIN");
  });

  it("shows a floor error on a wrong PIN and clears only the secret entry", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "0000") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong personnel number or PIN")).toBeDefined());
    expect(onAuthed).not.toHaveBeenCalled();
    expect(screen.getByText("Enter PIN")).toBeDefined();
    expect(screen.getByLabelText("pin").textContent).toBe("");
  });

  it("shows the wrong-credentials error (not an unhandled rejection) when the mirror query throws, e.g. after failed boot migrations (regression for M6)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exec: SqlExecutor = {
      run: () => Promise.reject(new Error("no such table: operators_mirror")),
      all: () => Promise.reject(new Error("no such table: operators_mirror")),
    };
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "4821") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong personnel number or PIN")).toBeDefined());
    expect(onAuthed).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("guards against a double-tap on the sign-in button: only one verification/onAuthed call", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "4821") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    const signInButton = screen.getByRole("button", { name: "Sign in" });
    // Two rapid taps, as a kiosk touchscreen double-tap would fire — the
    // `busy` guard must ensure only one verification actually runs.
    fireEvent.click(signInButton);
    fireEvent.click(signInButton);

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    // Give any spurious second call a chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAuthed).toHaveBeenCalledTimes(1);
  });

  it("disables Back while a verification is in flight, so it can't reset the stage out from under a pending sign-in (C5)", async () => {
    // An exec whose query never resolves on its own -- keeps `submit()`
    // suspended at `await verifyOperatorPin(...)` so the test can assert on
    // the UI mid-flight, then release it to observe recovery afterwards.
    let releaseQuery: (() => void) | undefined;
    const pending = new Promise<never[]>((resolve) => {
      releaseQuery = () => resolve([]);
    });
    const exec: SqlExecutor = {
      run: async () => {},
      all: async () => pending,
    };
    const onAuthed = vi.fn();
    render(<OperatorLogin online={false} exec={exec} source={silentSource} onAuthed={onAuthed} />);

    openNumericFallback();
    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "4821") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Still on the PIN stage, verification in flight: Back must be disabled --
    // otherwise clicking it now would reset to the login stage, and a later
    // successful verification would still fire `onAuthed` and jump straight to
    // the floor view even though the UI looked like it had gone back.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // The disabled click must be a no-op: still on the PIN stage.
    expect(screen.getByLabelText("pin")).toBeDefined();
    expect(screen.queryByLabelText("login")).toBeNull();

    releaseQuery?.();
    await waitFor(() => expect(onAuthed).not.toHaveBeenCalled());
    // readOperatorsMirror resolved to an empty roster, so the credentials
    // don't match: the UI keeps the identified login and re-enables correction.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("signs in immediately when a known badge is scanned", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("badge-1"),
        active: true,
      },
    ]);
    const scanner = manualSource();
    const onAuthed = vi.fn();
    render(
      <OperatorLogin online={false} exec={exec} source={scanner.source} onAuthed={onAuthed} />,
    );

    expect(screen.getByText("Scan your badge to sign in")).toBeDefined();
    act(() => scanner.scan("badge-1"));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(onAuthed.mock.calls[0]![0]).toMatchObject({ operatorId: "op-1", login: "1042" });
  });

  it("shows a badge-specific error, preserves PIN fallback input, and allows a retry", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("badge-1"),
        active: true,
      },
    ]);
    const scanner = manualSource();
    const onAuthed = vi.fn();
    render(
      <OperatorLogin online={false} exec={exec} source={scanner.source} onAuthed={onAuthed} />,
    );
    openNumericFallback();
    fireEvent.click(screen.getByRole("button", { name: "1" }));

    act(() => scanner.scan("unknown-badge"));
    await waitFor(() => expect(screen.getByText("Badge not recognized")).toBeDefined());
    expect(screen.getByLabelText("login").textContent).toBe("1");

    act(() => scanner.scan("badge-1"));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  it("unsubscribes a replaced scan source so only the current scanner can authenticate", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("badge-1"),
        active: true,
      },
    ]);
    const first = manualSource();
    const second = manualSource();
    const onAuthed = vi.fn();
    const view = render(
      <OperatorLogin online={false} exec={exec} source={first.source} onAuthed={onAuthed} />,
    );
    expect(first.active()).toBe(true);

    view.rerender(
      <OperatorLogin online={false} exec={exec} source={second.source} onAuthed={onAuthed} />,
    );
    expect(first.active()).toBe(false);
    expect(second.active()).toBe(true);
    act(() => first.scan("badge-1"));
    expect(onAuthed).not.toHaveBeenCalled();

    act(() => second.scan("badge-1"));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(second.active()).toBe(false);
  });

  it("ignores a late event from a retired source before it can block the replacement", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("badge-1"),
        active: true,
      },
    ]);
    const retired = retainedSource();
    const current = manualSource();
    const onAuthed = vi.fn();
    const view = render(
      <OperatorLogin online={false} exec={exec} source={retired.source} onAuthed={onAuthed} />,
    );
    view.rerender(
      <OperatorLogin online={false} exec={exec} source={current.source} onAuthed={onAuthed} />,
    );

    act(() => {
      retired.scanRetired("badge-1");
      current.scan("badge-1");
    });

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  it("refreshes once after a badge miss and retries only the local badge check", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const scanner = manualSource();
    const refreshRoster = vi.fn(async () => {
      await replaceOperatorsMirror(exec, [
        {
          operatorId: "op-new",
          name: "New Operator",
          login: "1002",
          role: "operator",
          pinHash: await hashSecret("4821"),
          badgeHash: await hashSecret("NEW-BADGE"),
          active: true,
        },
      ]);
      return "updated" as const;
    });
    const onAuthed = vi.fn();
    render(
      <OperatorLogin
        exec={exec}
        source={scanner.source}
        online
        refreshRoster={refreshRoster}
        onAuthed={onAuthed}
      />,
    );

    act(() => scanner.scan("NEW-BADGE"));

    expect(await screen.findByText("Refreshing operator list…")).toBeDefined();
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(onAuthed.mock.calls[0]![0]).toMatchObject({ operatorId: "op-new" });
    expect(refreshRoster).toHaveBeenCalledTimes(1);
  });

  it("keeps an offline badge miss local and does not refresh", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const scanner = manualSource();
    const refreshRoster = vi.fn(async () => "updated" as const);
    render(
      <OperatorLogin
        exec={exec}
        source={scanner.source}
        online={false}
        refreshRoster={refreshRoster}
        onAuthed={vi.fn()}
      />,
    );

    act(() => scanner.scan("UNKNOWN-BADGE"));

    expect(await screen.findByText("Badge not recognized")).toBeDefined();
    expect(refreshRoster).not.toHaveBeenCalled();
  });

  it("shows a safe recovery message when the roster refresh is unavailable", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const scanner = manualSource();
    const refreshRoster = vi.fn(async () => "unavailable" as const);
    render(
      <OperatorLogin
        exec={exec}
        source={scanner.source}
        online
        refreshRoster={refreshRoster}
        onAuthed={vi.fn()}
      />,
    );

    act(() => scanner.scan("UNKNOWN-BADGE"));

    expect(
      await screen.findByText("Could not refresh the operator list. Check the connection."),
    ).toBeDefined();
    expect(screen.queryByText("Badge not recognized")).toBeNull();
  });

  it("refreshes once after a PIN miss and retries only the local PIN check", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const refreshRoster = vi.fn(async () => {
      await replaceOperatorsMirror(exec, [
        {
          operatorId: "op-new",
          name: "New Operator",
          login: "1002",
          role: "operator",
          pinHash: await hashSecret("4821"),
          badgeHash: null,
          active: true,
        },
      ]);
      return "updated" as const;
    });
    const onAuthed = vi.fn();
    render(
      <OperatorLogin
        exec={exec}
        source={silentSource}
        online
        refreshRoster={refreshRoster}
        onAuthed={onAuthed}
      />,
    );

    openNumericFallback();
    for (const digit of "1002") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    for (const digit of "4821") fireEvent.click(screen.getByRole("button", { name: digit }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Refreshing operator list…")).toBeDefined();
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
    expect(refreshRoster).toHaveBeenCalledTimes(1);
  });

  it("shows cached name results while a background roster refresh is pending", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-cached",
        name: "Alex Cached",
        login: "1001",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: null,
        active: true,
      },
    ]);
    let resolveRefresh!: (result: "updated") => void;
    const refreshRoster = vi.fn(
      () =>
        new Promise<"updated">((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(
      <OperatorLogin
        exec={exec}
        source={silentSource}
        online
        refreshRoster={refreshRoster}
        onAuthed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = await screen.findByRole("textbox", { name: "Operator name" });
    fireEvent.change(search, { target: { value: "al" } });

    expect(await screen.findByRole("button", { name: "Alex Cached" })).toBeDefined();
    expect(refreshRoster).toHaveBeenCalledTimes(1);
    await act(async () => resolveRefresh("updated"));
  });

  it("replaces cached name results after a background roster refresh", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const pinHash = await hashSecret("4821");
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-old",
        name: "Alex Old",
        login: "1001",
        role: "operator",
        pinHash,
        badgeHash: null,
        active: true,
      },
    ]);
    let resolveRefresh!: (result: "updated") => void;
    const refreshRoster = vi.fn(
      () =>
        new Promise<"updated">((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(
      <OperatorLogin
        exec={exec}
        source={silentSource}
        online
        refreshRoster={refreshRoster}
        onAuthed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find by name" }));
    const search = await screen.findByRole("textbox", { name: "Operator name" });
    fireEvent.change(search, { target: { value: "al" } });
    expect(await screen.findByRole("button", { name: "Alex Old" })).toBeDefined();

    await act(async () => {
      await replaceOperatorsMirror(exec, [
        {
          operatorId: "op-new",
          name: "Alex New",
          login: "1002",
          role: "operator",
          pinHash,
          badgeHash: null,
          active: true,
        },
      ]);
      resolveRefresh("updated");
    });

    expect(await screen.findByRole("button", { name: "Alex New" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Alex Old" })).toBeNull();
  });

  it("does not authenticate from a retained badge callback after unmount during refresh", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const scanner = retainedSource();
    let resolveRefresh!: (result: "updated") => void;
    const refreshRoster = vi.fn(
      () =>
        new Promise<"updated">((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onAuthed = vi.fn();
    const view = render(
      <OperatorLogin
        exec={exec}
        source={scanner.source}
        online
        refreshRoster={refreshRoster}
        onAuthed={onAuthed}
      />,
    );

    act(() => scanner.scanRetired("NEW-BADGE"));
    await waitFor(() => expect(refreshRoster).toHaveBeenCalledTimes(1));
    view.unmount();
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-new",
        name: "New Operator",
        login: "1002",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("NEW-BADGE"),
        active: true,
      },
    ]);
    resolveRefresh("updated");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAuthed).not.toHaveBeenCalled();
  });

  it("does not admit a removed operator when the roster changes during badge verification", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-revoked",
        name: "Revoked Operator",
        login: "1001",
        role: "operator",
        pinHash: await hashSecret("4821"),
        badgeHash: await hashSecret("BADGE-OLD"),
        active: true,
      },
    ]);
    let announceVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      announceVerification = resolve;
    });
    let resumeVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      resumeVerification = resolve;
    });
    const realVerifyBadge = crypto.verifyBadge;
    const verifyBadgeSpy = vi.spyOn(crypto, "verifyBadge").mockImplementation(async (code, phc) => {
      announceVerification();
      await verificationGate;
      return realVerifyBadge(code, phc);
    });
    const scanner = manualSource();
    const onAuthed = vi.fn();
    try {
      render(
        <OperatorLogin exec={exec} source={scanner.source} online={false} onAuthed={onAuthed} />,
      );

      act(() => scanner.scan("BADGE-OLD"));
      await verificationStarted;
      await replaceOperatorsMirror(exec, []);
      resumeVerification();

      expect(await screen.findByText("Badge not recognized")).toBeDefined();
      expect(onAuthed).not.toHaveBeenCalled();
    } finally {
      resumeVerification();
      verifyBadgeSpy.mockRestore();
    }
  });

  it("does not admit a deactivated operator when the roster changes during PIN verification", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const operator = {
      operatorId: "op-deactivated",
      name: "Deactivated Operator",
      login: "1002",
      role: "operator",
      pinHash: await hashSecret("4821"),
      badgeHash: null,
      active: true,
    };
    await replaceOperatorsMirror(exec, [operator]);
    let announceVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      announceVerification = resolve;
    });
    let resumeVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      resumeVerification = resolve;
    });
    const realVerifyPin = crypto.verifyPin;
    const verifyPinSpy = vi.spyOn(crypto, "verifyPin").mockImplementation(async (pin, phc) => {
      announceVerification();
      await verificationGate;
      return realVerifyPin(pin, phc);
    });
    const onAuthed = vi.fn();
    try {
      render(
        <OperatorLogin exec={exec} source={silentSource} online={false} onAuthed={onAuthed} />,
      );
      openNumericFallback();
      for (const digit of "1002") fireEvent.click(screen.getByRole("button", { name: digit }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      for (const digit of "4821") fireEvent.click(screen.getByRole("button", { name: digit }));
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      await verificationStarted;
      await replaceOperatorsMirror(exec, [{ ...operator, active: false }]);
      resumeVerification();

      expect(await screen.findByText("Wrong personnel number or PIN")).toBeDefined();
      expect(onAuthed).not.toHaveBeenCalled();
    } finally {
      resumeVerification();
      verifyPinSpy.mockRestore();
    }
  });

  it("does not admit an old PIN when its verifier rotates during authentication", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const operator = {
      operatorId: "op-rotated",
      name: "Rotated Operator",
      login: "1003",
      role: "operator",
      pinHash: await hashSecret("4821"),
      badgeHash: null,
      active: true,
    };
    await replaceOperatorsMirror(exec, [operator]);
    let announceVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      announceVerification = resolve;
    });
    let resumeVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      resumeVerification = resolve;
    });
    const realVerifyPin = crypto.verifyPin;
    const verifyPinSpy = vi.spyOn(crypto, "verifyPin").mockImplementation(async (pin, phc) => {
      announceVerification();
      await verificationGate;
      return realVerifyPin(pin, phc);
    });
    const onAuthed = vi.fn();
    try {
      render(
        <OperatorLogin exec={exec} source={silentSource} online={false} onAuthed={onAuthed} />,
      );
      openNumericFallback();
      for (const digit of "1003") fireEvent.click(screen.getByRole("button", { name: digit }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      for (const digit of "4821") fireEvent.click(screen.getByRole("button", { name: digit }));
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      await verificationStarted;
      await replaceOperatorsMirror(exec, [{ ...operator, pinHash: await hashSecret("8642") }]);
      resumeVerification();

      expect(await screen.findByText("Wrong personnel number or PIN")).toBeDefined();
      expect(onAuthed).not.toHaveBeenCalled();
    } finally {
      resumeVerification();
      verifyPinSpy.mockRestore();
    }
  });
});
