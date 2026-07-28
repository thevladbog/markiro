import type { KeyTarget, ScanListener, ScanSource } from "./source.js";

const DEFAULT_SILENCE_MS = 60;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Most USB/Bluetooth barcode scanners present as HID keyboards: they "type"
 * the payload and usually finish with Enter. Two departures from the
 * station's version, both required here:
 *
 *  - a silence timeout, because a scanner configured without a suffix would
 *    otherwise hold its payload forever;
 *  - `isAvailable()`, so the setup screen can present transports honestly.
 */
export function createKeyboardWedgeSource(
  opts: { target?: KeyTarget; silenceMs?: number } = {},
): ScanSource {
  const target = opts.target ?? window;
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;

  return {
    isAvailable: () => true,
    start(listener: ScanListener) {
      let payload = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (payload.length > 0) listener(payload);
        payload = "";
      };

      const onKeyDown = (event: Event) => {
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          flush();
          return;
        }
        if (key.length !== 1) return; // modifier / navigation key
        payload += key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, silenceMs);
      };

      target.addEventListener("keydown", onKeyDown);
      return () => {
        if (timer) clearTimeout(timer);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
  };
}
