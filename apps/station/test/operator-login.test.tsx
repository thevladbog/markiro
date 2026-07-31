import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, replaceOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { hashSecret } from "../src/lib/crypto.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { OperatorLogin } from "../src/pages/OperatorLogin.js";

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

describe("OperatorLogin", () => {
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
    render(<OperatorLogin exec={exec} source={silentSource} onAuthed={onAuthed} />);

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

  it("shows a floor error on a wrong PIN and returns to the personnel-number stage", async () => {
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
    render(<OperatorLogin exec={exec} source={silentSource} onAuthed={onAuthed} />);

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
    // Back at stage 1: the personnel-number prompt is shown again, cleared.
    expect(screen.getByText("Enter your personnel number")).toBeDefined();
    expect(screen.getByLabelText("login").textContent).toBe("");
  });

  it("shows the wrong-credentials error (not an unhandled rejection) when the mirror query throws, e.g. after failed boot migrations (regression for M6)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exec: SqlExecutor = {
      run: () => Promise.reject(new Error("no such table: operators_mirror")),
      all: () => Promise.reject(new Error("no such table: operators_mirror")),
    };
    const onAuthed = vi.fn();
    render(<OperatorLogin exec={exec} source={silentSource} onAuthed={onAuthed} />);

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
    render(<OperatorLogin exec={exec} source={silentSource} onAuthed={onAuthed} />);

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
    render(<OperatorLogin exec={exec} source={silentSource} onAuthed={onAuthed} />);

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
    // don't match: the UI settles back on the login stage with Back re-enabled.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(
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
    render(<OperatorLogin exec={exec} source={scanner.source} onAuthed={onAuthed} />);

    expect(screen.getByText("Or scan your badge")).toBeDefined();
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
    render(<OperatorLogin exec={exec} source={scanner.source} onAuthed={onAuthed} />);
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
    const view = render(<OperatorLogin exec={exec} source={first.source} onAuthed={onAuthed} />);
    expect(first.active()).toBe(true);

    view.rerender(<OperatorLogin exec={exec} source={second.source} onAuthed={onAuthed} />);
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
    const view = render(<OperatorLogin exec={exec} source={retired.source} onAuthed={onAuthed} />);
    view.rerender(<OperatorLogin exec={exec} source={current.source} onAuthed={onAuthed} />);

    act(() => {
      retired.scanRetired("badge-1");
      current.scan("badge-1");
    });

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });
});
