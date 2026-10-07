/** A raw scan, as the scanner typed it, before anything trims or reads it. */
export type ScanListener = (raw: string) => void;

/**
 * Where scans come from (stage 1 spec §5.6): a keyboard-wedge scanner today,
 * the COM scanners of plan 2a later. The sign-in screen does not care which.
 */
export interface ScanSource {
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
  /** Drops the keys typed since the last Enter. */
  clearPendingInput(): void;
}

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * A HID scanner is a keyboard: it types the code and presses Enter. This
 * source gathers single-character keys and hands them over on Enter,
 * skipping modifiers and navigation keys (their `key` is a name such as
 * «Shift» or «ArrowLeft»). Ported from the cloud station's
 * `createKeyboardWedgeSource` (`apps/station/src/lib/scan-source.ts`).
 */
export function createKeyboardWedgeSource(target: KeyTarget = window): ScanSource {
  const buffers = new Set<() => void>();
  return {
    start(listener) {
      let payload = "";
      const clear = () => {
        payload = "";
      };
      buffers.add(clear);
      const onKeyDown = (event: Event) => {
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          // The scan's closing Enter lands on whatever holds the focus, and a
          // focused button would also take it as a click. `preventDefault`
          // stops that; filtering by the event's target instead would drop
          // the scan itself, which is worse.
          event.preventDefault();
          if (payload.length > 0) listener(payload);
          payload = "";
          return;
        }
        if (key.length === 1) payload += key;
      };
      target.addEventListener("keydown", onKeyDown);
      return () => {
        clear();
        buffers.delete(clear);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
    clearPendingInput() {
      for (const clear of buffers) clear();
    },
  };
}
