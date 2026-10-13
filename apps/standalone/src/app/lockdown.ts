import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** The shell's kiosk-mode commands (`src-tauri/src/lockdown.rs`). */
export type LockdownCommand = "enter_lockdown" | "exit_lockdown";

/**
 * The window as the lifecycle last confirmed it: `locked` (kiosk mode) or
 * `windowed`; `pending` while a command runs; `error` names the direction of
 * the last command that failed, never its text.
 */
export interface LockdownSnapshot {
  mode: "locked" | "windowed";
  pending: boolean;
  error: "enter" | "exit" | null;
}

/**
 * Kiosk mode as the webview drives it. Every member is a function-typed
 * property, so it may be passed around unbound
 * (`@typescript-eslint/unbound-method`), as `useSyncExternalStore` takes them.
 */
export interface LockdownLifecycle {
  /** `false` in development (`import.meta.env.DEV`): no command is ever sent. */
  enabled: boolean;
  /** Turns kiosk mode on; resolves once every command asked for so far has settled. */
  enter: () => Promise<void>;
  /** Turns kiosk mode off (the office administrator's «Оконный режим»). */
  exit: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LockdownSnapshot;
  /** Forgets the last failure without changing the confirmed mode. */
  clearError: () => void;
}

export interface LockdownOptions {
  dev: boolean;
  invoke?: (command: LockdownCommand) => Promise<unknown>;
  /** Where a failure is reported: the command's name only, never what it threw. */
  logError?: (message: string) => void;
}

/**
 * Ported from the cloud station's `createLockdownLifecycle`
 * (`apps/station/src/lib/lockdown.ts`). Commands run one after another, and
 * a request for the mode already asked for adds nothing, so a re-render or
 * React StrictMode's second effect sends no second command. After a failed
 * command the window may hold only some of its properties, so the next
 * request is sent whatever the confirmed mode says. A command whose IPC never
 * answers holds the later ones: the commands are synchronous in the shell, so
 * the window itself is hung then, and a timeout that let the next command
 * overlap it could leave the window locked while the snapshot says windowed.
 */
export function createLockdownLifecycle({
  dev,
  invoke = tauriInvoke,
  logError = (message) => console.error(message),
}: LockdownOptions): LockdownLifecycle {
  const enabled = !dev;
  // `null`: a failed command may have changed only some window properties.
  let applied: boolean | null = false;
  let requested: boolean | null = null;
  let settled: Promise<void> = Promise.resolve();
  let snapshot: LockdownSnapshot = { mode: "windowed", pending: false, error: null };
  const listeners = new Set<() => void>();

  const publish = (next: LockdownSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const request = (next: boolean): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (requested === next) return settled;
    requested = next;
    const command: LockdownCommand = next ? "enter_lockdown" : "exit_lockdown";
    settled = settled.then(async () => {
      if (applied === next) return;
      publish({ mode: snapshot.mode, pending: true, error: null });
      try {
        await invoke(command);
        applied = next;
        publish({ mode: next ? "locked" : "windowed", pending: false, error: null });
      } catch {
        applied = null;
        // A later request supersedes this one; only the matching one is
        // forgotten, so the same command can be asked for again.
        if (requested === next) requested = null;
        publish({ mode: snapshot.mode, pending: false, error: next ? "enter" : "exit" });
        logError(`standalone: ${command} failed`);
      }
    });
    return settled;
  };

  return {
    enabled,
    enter: () => request(true),
    exit: () => request(false),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    clearError: () => {
      if (snapshot.error === null) return;
      publish({ mode: snapshot.mode, pending: snapshot.pending, error: null });
    },
  };
}

/**
 * Whether an office session opens the window ordinary by itself (owner
 * feedback of the first beta: the office is not a touch app and must not fill
 * the screen). Only where the build locks the window at all, and only for an
 * administrator, the one role that may leave kiosk mode. An office PC is never
 * locked, so there is nothing to leave.
 */
export function shouldOpenOfficeWindowed(options: {
  enabled: boolean;
  officePc: boolean;
  officeAdmin: boolean;
}): boolean {
  return options.enabled && !options.officePc && options.officeAdmin;
}
