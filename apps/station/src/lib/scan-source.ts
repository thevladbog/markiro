export type ScanListener = (raw: string) => void;

/**
 * A source of raw scan payloads. The work screen consumes this seam and does
 * not care whether the bytes came from a HID keyboard wedge or a serial port.
 */
export interface ScanSource {
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
}

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Most USB barcode scanners are HID keyboards by default: they "type" the
 * payload and finish with Enter. This source accumulates single-character
 * keys and flushes on Enter, ignoring modifiers and navigation keys (whose
 * `key` values are multi-character names like "Shift" or "ArrowLeft").
 */
export function createKeyboardWedgeSource(target: KeyTarget = window): ScanSource {
  return {
    start(listener: ScanListener) {
      let payload = "";
      const onKeyDown = (event: Event) => {
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          if (payload.length > 0) listener(payload);
          payload = "";
          return;
        }
        if (key.length === 1) payload += key;
      };
      target.addEventListener("keydown", onKeyDown);
      return () => target.removeEventListener("keydown", onKeyDown);
    },
  };
}
