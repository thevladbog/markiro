import type { LockdownSnapshot } from "./lockdown.js";

/**
 * The plain full-screen mode of the window, for a PC that is never locked (a host PC:
 * owner decision 2026-10-13, `rolePermitsKiosk`). It is the webview's own Fullscreen API
 * (`requestFullscreen`, which WebView2 turns into a full-screen window), not the shell's
 * kiosk mode: the frame, the taskbar and the close button are not taken away by a command
 * of ours, so nothing locks the PC. Esc (and the control in the floor's rail) leaves it
 * with no proof of identity, and the snapshot follows a leave the page did not ask for.
 * The snapshot has the kiosk lifecycle's shape (`locked` here reads «in full screen») so
 * the floor's one control drives either.
 */
export interface FullscreenController {
  /** `false` where the webview has no Fullscreen API: no control is offered. */
  enabled: boolean;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LockdownSnapshot;
  clearError: () => void;
}

export function createFullscreenController(doc: Document = document): FullscreenController {
  let snapshot: LockdownSnapshot = {
    mode: doc.fullscreenElement === null ? "windowed" : "locked",
    pending: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: LockdownSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const onChange = (): void => {
    const mode = doc.fullscreenElement === null ? "windowed" : "locked";
    if (mode !== snapshot.mode) publish({ ...snapshot, mode });
  };

  const run = async (direction: "enter" | "exit"): Promise<void> => {
    if (snapshot.pending) return;
    // Nothing to leave: no snapshot change, no re-render.
    if (direction === "exit" && doc.fullscreenElement === null) return;
    publish({ ...snapshot, pending: true, error: null });
    try {
      if (direction === "enter") await doc.documentElement.requestFullscreen();
      else await doc.exitFullscreen();
    } catch {
      publish({ ...snapshot, pending: false, error: direction });
      return;
    }
    publish({
      mode: doc.fullscreenElement === null ? "windowed" : "locked",
      pending: false,
      error: null,
    });
  };

  return {
    enabled: doc.fullscreenEnabled === true,
    enter: () => run("enter"),
    exit: () => run("exit"),
    subscribe: (listener) => {
      if (listeners.size === 0) doc.addEventListener("fullscreenchange", onChange);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) doc.removeEventListener("fullscreenchange", onChange);
      };
    },
    getSnapshot: () => snapshot,
    clearError: () => {
      if (snapshot.error !== null) publish({ ...snapshot, error: null });
    },
  };
}
