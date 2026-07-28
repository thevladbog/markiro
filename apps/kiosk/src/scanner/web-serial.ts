import { isWebSerialSupported } from "./keyboard.js";
import type { ScanListener, ScanSource } from "./source.js";

// Re-exported so a consumer that only imports "./web-serial.js" (the file
// whose whole subject is Web Serial) doesn't have to know the availability
// check happens to live in keyboard.ts.
export { isWebSerialSupported };

/**
 * The Web Serial surface this source needs. There is no widely adopted
 * `@types` package for it and the DOM lib ships none, so this is a
 * deliberately minimal ambient shape rather than the full spec surface —
 * just enough to open a port and read its bytes.
 */
export interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
}

/** `navigator.serial`, narrowed to the one call that hands out grants. */
interface SerialApi {
  requestPort(): Promise<SerialPort>;
}

/**
 * Show the browser's port picker and return what the installer granted.
 *
 * This is the ONLY way a `SerialPort` can come into existence. `getPorts()`
 * lists grants that already happened, so an app that never calls this has no
 * serial transport at all, whatever transport its store says it is on — the
 * list stays empty forever.
 *
 * The browser requires TRANSIENT USER ACTIVATION here, which is why the call
 * belongs to a gesture handler (the scanner-setup radio) and not to the app
 * shell: the shell mounts on boot, with no gesture, and can only ever recover
 * an existing grant via `getPorts()`.
 *
 * Rejects when the picker is dismissed. That is a refusal, not a fault — the
 * caller is expected to stay on its previous transport and say so.
 */
export async function requestSerialPort(): Promise<SerialPort> {
  const serial = (navigator as Navigator & { serial?: SerialApi }).serial;
  if (!serial) throw new Error("kiosk: this device has no Web Serial");
  return serial.requestPort();
}

const DEFAULT_BAUD_RATE = 9600;

/**
 * Upper bound on how much unterminated data to keep waiting on a line
 * terminator. A marking-code/badge payload is at most a couple hundred
 * bytes, so this is two orders of magnitude above any real scan — mirrors
 * the station's Rust reader (`apps/station/src-tauri/src/scanner.rs`,
 * `MAX_BUFFER_BYTES`/`absorb_chunk`) exactly: complete lines are extracted
 * first, and only the still-unterminated *tail* is measured against the
 * cap. Past it, the tail is garbage — most often a wrong baud rate
 * producing framing noise — and is discarded outright, never
 * truncated-and-emitted as if it were a real scan.
 */
const MAX_BUFFER = 4096;

const LINE_TERMINATOR = /[\r\n]/;

/**
 * Web Serial is the preferred transport where it exists: it delivers raw
 * bytes, so the GS separator (0x1D) inside a Chestny ZNAK marking code
 * survives — a keyboard wedge frequently drops it, which is exactly what the
 * domain guard's `incomplete` verdict exists to catch. Desktop-Chromium
 * only; `isAvailable()` reflects that honestly.
 *
 * `port.open()` and reading `port.readable` are both async, while
 * `ScanSource.start()` is synchronous, so — mirroring the station's
 * `createHardwareScanSource` — a `stopped` flag is checked after every
 * await. Without it a `start()` immediately followed by `stop()` could leave
 * a reader subscribed after the caller believes the source is stopped.
 */
export function createWebSerialSource(port: SerialPort): ScanSource {
  return {
    isAvailable: () => isWebSerialSupported(),
    start(listener: ScanListener) {
      let stopped = false;
      let reader: ReadableStreamDefaultReader<string> | null = null;
      let buffer = "";

      void (async () => {
        try {
          await port.open({ baudRate: DEFAULT_BAUD_RATE });
          if (stopped) return;

          const readable = port.readable;
          if (!readable) return;

          // `TextDecoderStream.writable` is typed as `WritableStream<BufferSource>`,
          // which lib.dom.d.ts's `pipeThrough` doesn't consider assignable to the
          // narrower `WritableStream<Uint8Array<ArrayBufferLike>>` it infers from
          // `readable` — a known typings mismatch (a `Uint8Array` is always a
          // valid `BufferSource`), not a real incompatibility. `as` (rather than
          // a plain annotation) is needed because the two `ArrayBufferLike`
          // shapes don't overlap enough for a direct assignment either.
          const bytes = readable as unknown as ReadableStream<BufferSource>;
          reader = bytes.pipeThrough(new TextDecoderStream()).getReader();
          if (stopped) {
            await reader.cancel().catch(() => {});
            reader = null;
            return;
          }

          while (!stopped) {
            const { value, done } = await reader.read();
            if (stopped || done) break;

            buffer += value;
            let idx = buffer.search(LINE_TERMINATOR);
            while (idx !== -1) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              if (line.length > 0) listener(line);
              idx = buffer.search(LINE_TERMINATOR);
            }
            if (buffer.length > MAX_BUFFER) {
              console.error(
                `kiosk: discarding ${buffer.length} chars without a line terminator ` +
                  "(wrong baud rate or non-scanner device?)",
              );
              buffer = "";
            }
          }
        } catch (err) {
          // Covers a failed `port.open()` (wrong permissions, port already
          // in use, device unplugged between selection and open — all
          // routine, per the station's own `open_scanner` retry loop) as
          // well as a failed read, so this must not become an unhandled
          // rejection either way.
          if (!stopped) console.error("kiosk: web serial scan source failed", err);
        } finally {
          reader = null;
        }
      })();

      return () => {
        stopped = true;
        void reader?.cancel().catch(() => {});
      };
    },
  };
}
