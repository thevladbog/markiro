import { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, replaceOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { hashSecret } from "../src/lib/crypto.js";
import { OperatorLogin } from "../src/pages/OperatorLogin.js";

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
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);

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
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);

    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "0000") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong PIN")).toBeDefined());
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
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);

    for (const digit of "1042") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    for (const digit of "4821") {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong PIN")).toBeDefined());
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
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);

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
});
