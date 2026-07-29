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
  /**
   * Kept in the shape although nothing here calls it: releasing the device is
   * the port OWNER's business (the shell that holds the grant), never a
   * subscriber's — see the stop function in `createWebSerialSource`.
   */
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
}

/** `navigator.serial`, narrowed to the call that hands out grants and the one
 * that lists the grants already given. */
interface SerialApi {
  requestPort(): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
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

/**
 * The ports this origin has ALREADY been granted, which is the only serial
 * transport a boot can recover: `requestPort()` needs transient user
 * activation and the app shell mounts without a gesture, so a kiosk that has
 * been power-cycled overnight has nothing to hand `createWebSerialSource` but
 * whatever survives here.
 *
 * Returns an EMPTY LIST rather than throwing where Web Serial is absent (a
 * tablet) or where the browser refuses the query. This is called on the boot
 * path, and the caller's answer to "no grant" is the keyboard wedge either
 * way — a rejection would only make the shell reimplement that fallback in a
 * catch block.
 */
export async function listGrantedPorts(): Promise<SerialPort[]> {
  const serial = (navigator as Navigator & { serial?: SerialApi }).serial;
  if (!serial) return [];
  return serial.getPorts();
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
 * Opens the port unless it is already open, in which case there is nothing to
 * do and reading can begin.
 *
 * A port is started more than once per session: the app shell — the single
 * owner of the transport — rebuilds its source whenever the transport changes,
 * so an installer toggling Serial → Keyboard → Serial through scanner setup
 * starts the same granted port twice. `stop()` deliberately leaves the port
 * open (see below), so that second `start()` meets an already-open port.
 *
 * Web Serial rejects `open()` with an `InvalidStateError` for exactly one
 * reason — the port's state is not "closed" — while a device that has gone
 * away, or a grant that no longer holds, surfaces as a `NetworkError`. So
 * swallowing this ONE error name is precisely the tolerance needed and hides
 * nothing else: every other failure still reaches the caller's error log.
 *
 * The name is compared rather than `instanceof DOMException` because the
 * rejection crosses a realm boundary in some embeddings, where `instanceof`
 * quietly answers false and the restart would silently break again.
 */
async function openUnlessAlreadyOpen(port: SerialPort): Promise<void> {
  try {
    await port.open({ baudRate: DEFAULT_BAUD_RATE });
  } catch (err) {
    if ((err as { name?: string } | null)?.name !== "InvalidStateError") throw err;
  }
}

/**
 * The reconnect schedule: 250 ms, doubling, capped at five seconds.
 *
 * The floor is short because the common failure is a scanner power-cycled or
 * knocked loose between two workers, and it should be back before the next one
 * reaches the kiosk. The CAP is what keeps a device that is genuinely gone —
 * unplugged overnight, or on a machine whose USB stack has given up — from
 * spinning: one attempt every five seconds, indefinitely.
 *
 * INDEFINITELY, and that is deliberate. Giving up after N attempts would leave
 * exactly the state this whole mechanism exists to avoid — a kiosk that looks
 * normal with a dead input — and would put the recovery back where it was, on
 * an installer re-picking the port through a settings gate that on a serial
 * kiosk may itself want the scanner.
 */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 5_000;

/** `attempt` is 0 for the first retry after a healthy read. */
function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

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
 *
 * A source is START/STOP/START-able on the same port, because a transport can
 * be picked more than once in a visit. The port is opened once and then kept:
 * `stop()` releases the READER, not the device. That is the same split the
 * station draws — there, `open_scanner`/`close_scanner` are commands the setup
 * screen issues, while its `ScanSource` only subscribes and unsubscribes, and
 * the port's lifetime is nobody's business but the owner's. Closing here
 * instead would be worse than asymmetric: `stop()` is synchronous while
 * `close()` is not, so a restart landing before the close settled would hit
 * the very `InvalidStateError` this shape exists to avoid (the station needed
 * a ten-attempt retry loop to make its close-before-open safe), and a port
 * closed under one subscriber would kill any other reader of the same grant.
 */
export function createWebSerialSource(port: SerialPort): ScanSource {
  return {
    isAvailable: () => isWebSerialSupported(),
    start(listener: ScanListener) {
      let stopped = false;
      let reader: ReadableStreamDefaultReader<string> | null = null;
      /** The pending reconnect, held so `stop()` can cancel it. */
      let retry: ReturnType<typeof setTimeout> | null = null;
      /**
       * Consecutive failed attempts, and therefore where the backoff stands.
       * Reset by a delivered chunk and by nothing else: a port that opens,
       * reads nothing and drops again is still failing, and must keep backing
       * off rather than restart at 250 ms forever.
       */
      let attempt = 0;

      const scheduleReconnect = (): void => {
        if (stopped) return;
        retry = setTimeout(() => {
          retry = null;
          // Re-checked inside the callback as well: `stop()` clears the timer,
          // but a timer that has already fired cannot be taken back.
          if (stopped) return;
          attempt += 1;
          void session();
        }, reconnectDelayMs(attempt));
      };

      /**
       * One attempt at the port: open it, read it until it ends. The buffer is
       * per attempt on purpose — a half-received line from before a disconnect
       * is not the head of the first line after it, and gluing the two together
       * would deliver one scan that never happened in place of two that did.
       */
      const session = async (): Promise<void> => {
        let buffer = "";
        try {
          await openUnlessAlreadyOpen(port);
          if (stopped) return;

          const readable = port.readable;
          // THROWN, not returned. An opened port with no `readable` is one more
          // way the session cannot start, and it has to leave by the same door
          // as the others: the `catch` below is what logs an outage, once, and
          // an early return here would retry every five seconds forever with
          // nothing in the console — the invisible failure this whole file is
          // written to avoid. The `finally` still schedules the reconnect, so a
          // port that vends a stream on the next attempt is picked straight up.
          if (!readable) throw new Error("kiosk: the serial port exposed no readable stream");

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
            // Bytes arrived, so the link is healthy: the next drop starts its
            // backoff from the floor rather than from wherever this one ended.
            attempt = 0;

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
          //
          // Logged once per outage rather than once per attempt: the retries
          // below repeat every five seconds for as long as the scanner is
          // away, and a log that fills overnight with the same line is one
          // nobody reads the next morning.
          if (!stopped && attempt === 0) console.error("kiosk: web serial scan source failed", err);
        } finally {
          reader = null;
          // Every way out of the loop that is not a `stop()` is the device
          // ending the session on us — a stream that errored (unplugged), one
          // that closed (`done`), a port that would not open, or one with no
          // `readable` to take. All of them are recoverable by re-opening, and
          // none of them is visible to the worker standing in front of a kiosk
          // that otherwise looks perfectly normal.
          if (!stopped) scheduleReconnect();
        }
      };

      void session();

      return () => {
        stopped = true;
        // The pending reconnect dies with the subscription: a retry that
        // outlived its `stop()` would re-open a port the owner deliberately
        // let go of — and on a transport swap would take the device out from
        // under the source that replaced this one.
        if (retry !== null) {
          clearTimeout(retry);
          retry = null;
        }
        // Cancelling is also what frees `port.readable` for the next start:
        // the stream is dropped on cancel, so the following access to the
        // getter vends a fresh one. The port itself stays open on purpose.
        void reader?.cancel().catch(() => {});
      };
    },
  };
}
