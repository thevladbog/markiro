import { describe, expect, it, vi } from "vitest";
import { createLockdownLifecycle, shouldEnterLockdown } from "../src/lib/lockdown.js";

describe("station lockdown lifecycle", () => {
  it("publishes immutable pending and confirmed snapshots around each command", async () => {
    let resolveEnter!: () => void;
    const invoke = vi.fn<(command: string) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          resolveEnter = resolve;
        }),
    );
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });
    const snapshots = [lifecycle.getSnapshot()];
    const unsubscribe = lifecycle.subscribe(() => snapshots.push(lifecycle.getSnapshot()));

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("enter_lockdown"));

    expect(snapshots).toEqual([
      { mode: "windowed", pending: false, error: null },
      { mode: "windowed", pending: true, error: null },
    ]);

    resolveEnter();
    await entering;
    expect(snapshots).toEqual([
      { mode: "windowed", pending: false, error: null },
      { mode: "windowed", pending: true, error: null },
      { mode: "locked", pending: false, error: null },
    ]);

    unsubscribe();
  });

  it("keeps the confirmed mode and publishes a safe direction when a command fails", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async (command) => {
      if (command === "exit_lockdown") throw new Error("secret-device-key");
    });
    const logError = vi.fn<(message: string) => void>();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError });
    const snapshots = [lifecycle.getSnapshot()];
    lifecycle.subscribe(() => snapshots.push(lifecycle.getSnapshot()));

    await lifecycle.enter();
    await lifecycle.exit();

    expect(snapshots.at(-1)).toEqual({ mode: "locked", pending: false, error: "exit" });
    expect(JSON.stringify(snapshots)).not.toContain("secret-device-key");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("secret-device-key");

    lifecycle.clearError();
    expect(lifecycle.getSnapshot()).toEqual({ mode: "locked", pending: false, error: null });
  });

  it("serializes an exit requested while enter is still in flight", async () => {
    let resolveEnter!: () => void;
    const invoke = vi.fn<(command: string) => Promise<void>>((command) => {
      if (command === "enter_lockdown") {
        return new Promise<void>((resolve) => {
          resolveEnter = resolve;
        });
      }
      return Promise.resolve();
    });
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });
    const snapshots = [lifecycle.getSnapshot()];
    lifecycle.subscribe(() => snapshots.push(lifecycle.getSnapshot()));

    const entering = lifecycle.enter();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("enter_lockdown"));
    const exiting = lifecycle.exit();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: true, error: null });

    resolveEnter();
    await Promise.all([entering, exiting]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
    ]);
    expect(snapshots).toEqual([
      { mode: "windowed", pending: false, error: null },
      { mode: "windowed", pending: true, error: null },
      { mode: "locked", pending: false, error: null },
      { mode: "locked", pending: true, error: null },
      { mode: "windowed", pending: false, error: null },
    ]);
    expect(lifecycle.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
  });

  it("keeps development windowed and enables production lockdown", () => {
    expect(shouldEnterLockdown({ dev: true })).toBe(false);
    expect(shouldEnterLockdown({ dev: false })).toBe(true);
  });

  it("enters once for an active production lifecycle and has idempotent cleanup", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async () => {});
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });

    const cleanup = lifecycle.start();
    lifecycle.start();
    await lifecycle.whenSettled();

    cleanup();
    cleanup();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("enter_lockdown");
  });

  it("exits for service mode and re-enters when returning to the floor", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async () => {});
    const lifecycle = createLockdownLifecycle({ dev: false, invoke });

    await lifecycle.enter();
    await lifecycle.exit();
    await lifecycle.exit();
    await lifecycle.enter();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
      "enter_lockdown",
    ]);
  });

  it("does not invoke lockdown commands in development", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async () => {});
    const lifecycle = createLockdownLifecycle({ dev: true, invoke });

    lifecycle.start();
    await lifecycle.exit();
    await lifecycle.enter();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("logs an actionable command failure without exposing the thrown detail", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async () => {
      throw new Error("secret-device-key");
    });
    const logError = vi.fn<(message: string) => void>();
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError });

    await lifecycle.enter();

    expect(logError).toHaveBeenCalledWith("station: enter_lockdown failed");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("secret-device-key");
  });

  it("still invokes exit after a failed enter may have partially changed the window", async () => {
    const invoke = vi.fn<(command: string) => Promise<void>>(async (command) => {
      if (command === "enter_lockdown") throw new Error("window property failed");
    });
    const lifecycle = createLockdownLifecycle({ dev: false, invoke, logError: vi.fn() });

    await lifecycle.enter();
    await lifecycle.exit();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "enter_lockdown",
      "exit_lockdown",
    ]);
  });
});
