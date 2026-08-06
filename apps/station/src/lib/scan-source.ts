export type ScanListener = (raw: string) => void;

/**
 * A source of raw scan payloads. The work screen consumes this seam and does
 * not care whether the bytes came from a HID keyboard wedge or a serial port.
 */
export interface ScanSource {
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
  /** Discards non-scan text accumulated by a keyboard-wedge implementation. */
  clearPendingInput?(): void;
  /** Routes focused free-text entry away from keyboard-wedge authentication. */
  setManualTextEntryActive?(active: boolean): void;
}

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Most USB barcode scanners are HID keyboards by default: they "type" the
 * payload and finish with Enter. This source accumulates single-character
 * keys and flushes on Enter, ignoring modifiers and navigation keys (whose
 * `key` values are multi-character names like "Shift" or "ArrowLeft").
 */
export function createKeyboardWedgeSource(target: KeyTarget = window): ScanSource {
  const activeBuffers = new Set<() => void>();
  let manualTextEntryActive = false;
  return {
    start(listener: ScanListener) {
      let payload = "";
      const clear = () => {
        payload = "";
      };
      activeBuffers.add(clear);
      const onKeyDown = (event: Event) => {
        if (manualTextEntryActive) return;
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          // A wedge scanner "types" into whatever element happens to hold DOM
          // focus, and native <button>s activate on Enter when focused. Left
          // alone, the terminating Enter of a scan would ALSO fire a click on
          // a focused button. preventDefault() here suppresses that default
          // action. Do NOT instead filter on `event.target` -- the scan IS
          // legitimately delivered to whatever is focused, so ignoring those
          // events would silently DROP the scan, which is worse than a
          // spurious click. Leave this comment so nobody "improves" it into
          // target-filtering later.
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
        activeBuffers.delete(clear);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
    clearPendingInput() {
      for (const clear of activeBuffers) clear();
    },
    setManualTextEntryActive(active) {
      for (const clear of activeBuffers) clear();
      manualTextEntryActive = active;
    },
  };
}
