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

        try {
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
          if (!stopped) console.error("kiosk: web serial read failed", err);
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
