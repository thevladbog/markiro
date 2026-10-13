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

/** An office session as the window-mode table reads it. */
export type OfficeSessionKind = "none" | "administrator" | "other";

/**
 * Whether the role permits kiosk mode, before the shell's own answer
 * (`kiosk_permitted_now`) is combined with it: a host PC and an office PC are
 * ordinary PCs and never lock (owner decision 2026-10-13); a station, and a PC
 * whose role the shell could not give (the floor's safe side), may.
 */
export function rolePermitsKiosk(role: "host" | "station" | "office" | null): boolean {
  return role === "station" || role === null;
}

/**
 * The window-mode table (owner decision 2026-10-13), the webview's half of
 * `src-tauri/src/window_policy.rs` `kiosk_due`; both sides' tests read
 * `src-tauri/tests/fixtures/window-policy.json`. `permitted` is what the
 * shell and the role permit; `configured` is a station paired as a station
 * with a line. A station locks once configured, except while an
 * administrator's office session is open (the office is a mouse-and-keyboard
 * app); a technologist's session stays locked.
 */
export function kioskDue(options: {
  permitted: boolean;
  configured: boolean;
  office: OfficeSessionKind;
}): boolean {
  return options.permitted && options.configured && options.office !== "administrator";
}
