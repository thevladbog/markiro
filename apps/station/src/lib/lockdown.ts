import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface LockdownEnvironment {
  dev: boolean;
}

export function shouldEnterLockdown({ dev }: LockdownEnvironment): boolean {
  return !dev;
}

type LockdownCommand = "enter_lockdown" | "exit_lockdown";

interface LockdownLifecycleOptions extends LockdownEnvironment {
  invoke?: (command: LockdownCommand) => Promise<unknown>;
  logError?: (message: string) => void;
}

export interface LockdownLifecycle {
  /** Starts the production floor lifecycle. Safe under React StrictMode. */
  start(): () => void;
  /** Enters the protected floor window state. */
  enter(): Promise<void>;
  /** Leaves lockdown for the explicit service workflow. */
  exit(): Promise<void>;
  /** Resolves after all commands requested so far have settled. */
  whenSettled(): Promise<void>;
}

/**
 * Serializes the Tauri window commands and de-duplicates repeated requests.
 *
 * React StrictMode deliberately mounts an effect twice in development. The
 * cleanup returned by `start` therefore only releases that effect attachment;
 * it must never unlock the OS window. Unlocking is an explicit service action.
 */
export function createLockdownLifecycle({
  dev,
  invoke = tauriInvoke,
  logError = (message) => console.error(message),
}: LockdownLifecycleOptions): LockdownLifecycle {
  const enabled = shouldEnterLockdown({ dev });
  // `null` means a failed command may have changed only some window
  // properties. The next explicit request must then invoke Rust rather than
  // assuming the window is already safely locked or unlocked.
  let applied: boolean | null = false;
  let requested: boolean | null = null;
  let settled = Promise.resolve();

  function request(next: boolean): Promise<void> {
    if (!enabled) return Promise.resolve();
    if (requested === next) return settled;

    requested = next;
    const command: LockdownCommand = next ? "enter_lockdown" : "exit_lockdown";
    settled = settled.then(async () => {
      if (applied === next) return;
      try {
        await invoke(command);
        applied = next;
      } catch {
        applied = null;
        // A later service/floor request supersedes this one. Only clear the
        // matching request so the same command can be retried after failure.
        if (requested === next) requested = null;
        // IPC errors may contain device configuration. Keep the diagnostic
        // actionable while deliberately omitting the thrown value.
        logError(`station: ${command} failed`);
      }
    });
    return settled;
  }

  return {
    start() {
      void request(true);
      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
      };
    },
    enter: () => request(true),
    exit: () => request(false),
    whenSettled: () => settled,
  };
}
