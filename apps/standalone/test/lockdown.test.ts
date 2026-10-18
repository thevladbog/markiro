import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createLockdownLifecycle,
  kioskDue,
  rolePermitsKiosk,
  type LockdownCommand,
  type OfficeSessionKind,
} from "../src/app/lockdown.js";

/** An `invoke` whose every call waits until the test resolves it. */
function heldInvoke() {
  const pending: Array<() => void> = [];
  const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    invoke,
    release: () => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no command is waiting");
      next();
    },
  };
}

describe("the kiosk-mode lifecycle", () => {
  it("publishes the pending and the confirmed mode around each command", async () => {
    const held = heldInvoke();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: held.invoke });
    const snapshots = [lifecycle.getSnapshot()];
    lifecycle.subscribe(() => snapshots.push(lifecycle.getSnapshot()));

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledWith("enter_lockdown"));
    expect(snapshots).toEqual([
      { mode: "windowed", pending: false, error: null },
      { mode: "windowed", pending: true, error: null },
    ]);

    held.release();
    await entering;
    expect(snapshots.at(-1)).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends one command for a mode asked for twice, as StrictMode's second effect does", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => undefined);
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });

    await Promise.all([lifecycle.enter(), lifecycle.enter()]);
    await lifecycle.exit();
    await lifecycle.exit();
    await lifecycle.enter();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
      "enter_lockdown",
    ]);
  });

  it("runs an exit asked for during an enter after it, never alongside", async () => {
    const held = heldInvoke();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: held.invoke });

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledTimes(1));
    const exiting = lifecycle.exit();
    await Promise.resolve();
    expect(held.invoke).toHaveBeenCalledTimes(1);

    held.release();
    await vi.waitFor(() => expect(held.invoke).toHaveBeenCalledTimes(2));
    held.release();
    await Promise.all([entering, exiting]);
    expect(held.invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
    ]);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("keeps the confirmed mode after a failure and names only its direction", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async (command) => {
      if (command === "exit_lockdown") throw "window_failed: secret-detail";
    });
    const logError = vi.fn<(message: string) => void>();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError });

    await lifecycle.enter();
    await lifecycle.exit();

    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: "exit" });
    expect(logError.mock.calls).toEqual([["standalone: exit_lockdown failed"]]);
    lifecycle.clearError();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends the same command again after it failed, and the other one after a half-done enter", async () => {
    let failEnter = true;
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async (command) => {
      if (command === "enter_lockdown" && failEnter) throw "window_failed";
    });
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError: vi.fn() });

    await lifecycle.enter();
    // The failed enter may have changed some properties: exit is sent.
    await lifecycle.exit();
    await lifecycle.enter();
    failEnter = false;
    await lifecycle.enter();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
      "enter_lockdown",
      "enter_lockdown",
    ]);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("sends nothing to leave a mode the window is already in", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => undefined);
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });

    await lifecycle.exit();

    expect(invoke).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("sends one command for a mode asked for twice at once, even when that command fails", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => {
      throw "window_failed";
    });
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError: vi.fn() });

    await Promise.all([lifecycle.enter(), lifecycle.enter()]);

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["enter_lockdown"]);
  });

  it("sends nothing in development", async () => {
    const invoke = vi.fn<(command: LockdownCommand) => Promise<void>>(async () => undefined);
    const lifecycle = createLockdownLifecycle({ dev: true, invoke });

    await lifecycle.enter();
    await lifecycle.exit();

    expect(lifecycle.enabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("stops telling a listener once it unsubscribed", async () => {
    const lifecycle = createLockdownLifecycle({ dev: false, invoke: async () => undefined });
    const listener = vi.fn();
    const unsubscribe = lifecycle.subscribe(listener);
    unsubscribe();
    await lifecycle.enter();
    expect(listener).not.toHaveBeenCalled();
  });
});

interface PolicyRow {
  role: "host" | "station" | "office" | null;
  kioskSetting: boolean;
  windowedLaunch: boolean;
  configured: boolean;
  office: OfficeSessionKind;
  permitted: boolean;
  kiosk: boolean;
}

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const moduleUrl = import.meta.url;
/** The table the shell's tests read too (`src-tauri/src/window_policy.rs`). */
const POLICY = (
  JSON.parse(
    readFileSync(new URL("../src-tauri/tests/fixtures/window-policy.json", moduleUrl), "utf8"),
  ) as { rows: PolicyRow[] }
).rows;

describe("the window-mode table (owner decision 2026-10-13)", () => {
  it("decides each row as the shell's table does", () => {
    expect(POLICY.length).toBeGreaterThanOrEqual(24);
    for (const row of POLICY) {
      expect(
        kioskDue({ permitted: row.permitted, configured: row.configured, office: row.office }),
        JSON.stringify(row),
      ).toBe(row.kiosk);
    }
  });

  it("lets the role alone permit kiosk mode as the shell does", () => {
    for (const row of POLICY.filter(
      (candidate) => candidate.kioskSetting && !candidate.windowedLaunch,
    )) {
      expect(rolePermitsKiosk(row.role), JSON.stringify(row)).toBe(row.permitted);
    }
  });

  it("never locks a host or office PC, and opens an administrator's office on a station", () => {
    expect(rolePermitsKiosk("host")).toBe(false);
    expect(rolePermitsKiosk("office")).toBe(false);
    expect(kioskDue({ permitted: true, configured: true, office: "administrator" })).toBe(false);
    expect(kioskDue({ permitted: true, configured: true, office: "other" })).toBe(true);
    expect(kioskDue({ permitted: true, configured: false, office: "none" })).toBe(false);
  });
});
