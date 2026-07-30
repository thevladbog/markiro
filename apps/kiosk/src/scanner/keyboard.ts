import type { KeyTarget, ScanListener, ScanSource } from "./source.js";

/**
 * The silence window — and, deliberately, THE SPEED FILTER design 2026-07-24
 * §6 asks for («отсеивает "человеческий" ввод по скорости»).
 *
 * It reads as a flush timer and does more than flush: because every keystroke
 * restarts it, it caps EVERY inter-key interval in a payload at 60 ms.
 * Assembling one therefore demands better than 16 keystrokes a second sustained
 * across the whole code, where a fast typist runs at 8 and 100 wpm is roughly
 * 120 ms a keystroke. Typed at human pace, this source emits one-character
 * payloads that the domain layer classifies as «не распознано» — visibly, on
 * screen — and the code never forms. `test/scanner.test.ts` pins both halves.
 *
 * A SECOND, TIGHTER THRESHOLD WAS CONSIDERED AND REJECTED, and the reason is
 * worth keeping so it is not "fixed" later. Any such filter has to sit between
 * the slowest scanner this device tolerates and the fastest human, and that gap
 * is empty: the window already admits scanners configured with inter-character
 * delays up to 60 ms — a routine setting, used to placate slow hosts — while
 * record-pace typists reach 50-60 ms. A threshold tight enough to catch the
 * human rejects the scanner, and the cost of that is the worst failure mode
 * here: a real scan dropped, at an unattended machine, with the worker shown
 * nothing at all. What actually authorises anything is the credential layer
 * behind this one — a badge verified by PBKDF2 against the cached roster, a
 * marking code put through the group-aware guard and the kiosk's catalogue
 * allowlist — none of which a typed payload gets past without already being
 * valid.
 *
 * So: if this number is ever raised to accommodate a slow scanner, it stops
 * being a speed filter. Prefer Web Serial for such a scanner instead.
 */
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
