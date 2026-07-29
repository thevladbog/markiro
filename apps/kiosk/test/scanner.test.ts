import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyboardWedgeSource, isWebSerialSupported } from "../src/scanner/keyboard.js";
import { createWebSerialSource, type SerialPort } from "../src/scanner/web-serial.js";

class FakeTarget {
  private handlers: ((e: Event) => void)[] = [];
  addEventListener(_: string, h: EventListenerOrEventListenerObject) {
    this.handlers.push(h as (e: Event) => void);
  }
  removeEventListener(_: string, h: EventListenerOrEventListenerObject) {
    this.handlers = this.handlers.filter((x) => x !== h);
  }
  type(text: string) {
    for (const ch of text) this.handlers.forEach((h) => h({ key: ch } as unknown as Event));
  }
  press(key: string) {
    this.handlers.forEach((h) => h({ key } as unknown as Event));
  }
  get listenerCount() {
    return this.handlers.length;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("keyboard wedge", () => {
  it("flushes the payload on Enter", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.type("0104600682000013");
    target.press("Enter");
    expect(seen).toEqual(["0104600682000013"]);
  });

  it("flushes on a silence timeout too — a scanner configured without a suffix would otherwise never deliver", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target, silenceMs: 60 }).start((raw) => seen.push(raw));
    target.type("01046006820000132");
    vi.advanceTimersByTime(60);
    expect(seen).toEqual(["01046006820000132"]);
  });

  it("ignores modifier and navigation keys, whose names are multi-character", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.press("Shift");
    target.type("AB");
    target.press("ArrowLeft");
    target.press("Enter");
    expect(seen).toEqual(["AB"]);
  });

  it("never emits an empty payload", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.press("Enter");
    expect(seen).toEqual([]);
  });

  it("stops listening when the returned function is called", () => {
    const target = new FakeTarget();
    const stop = createKeyboardWedgeSource({ target }).start(() => {});
    expect(target.listenerCount).toBe(1);
    stop();
    expect(target.listenerCount).toBe(0);
  });
});

describe("web serial availability", () => {
  it("reports unsupported when the browser has no serial API — a tablet must not be offered it", () => {
    vi.stubGlobal("navigator", {});
    expect(isWebSerialSupported()).toBe(false);
    vi.unstubAllGlobals();
  });
});

// jsdom cannot produce a real `navigator.serial` port, but the reader loop
// itself — chunking on CR/LF, preserving the GS separator, capping the
// buffer, and the stop-before-subscribe race — is plain stream-consuming
// logic. A fake port with a real, hand-fed `ReadableStream<Uint8Array>`
// exercises all of that cheaply, so it isn't only exercised by hand.
const GS = String.fromCharCode(0x1d);

function fakePort(chunks: Uint8Array[]): { port: SerialPort } {
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
    },
  });
  return {
    port: {
      open: async () => {},
      close: async () => {},
      get readable() {
        return readable;
      },
    },
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A fake port with the lifecycle a REAL one has, which the fixture above
 * deliberately does not model because the tests it serves never restart:
 *
 *  - `open()` on a port whose state is not "closed" rejects with an
 *    `InvalidStateError` — that is the one and only thing Web Serial's
 *    `open()` raises that error for;
 *  - `readable` is null while the port is closed;
 *  - a cancelled `readable` is dropped, so the NEXT access to the getter
 *    vends a fresh stream. That last part is what makes reading a port twice
 *    possible at all — a cancelled stream can never be read again.
 */
function restartablePort(): {
  port: SerialPort;
  scan: (raw: string) => void;
  opens: () => number;
} {
  let isOpen = false;
  let opens = 0;
  let stream: ReadableStream<Uint8Array> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const port: SerialPort = {
    open: async () => {
      if (isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
      isOpen = true;
      opens++;
    },
    close: async () => {
      isOpen = false;
      stream = null;
      controller = null;
    },
    get readable() {
      if (stream) return stream;
      if (!isOpen) return null;
      stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          stream = null;
          controller = null;
        },
      });
      return stream;
    },
  };

  return {
    port,
    scan: (raw) => {
      // Touching the getter vends the stream if nothing has yet, exactly as a
      // real port does — so a scan can be queued the moment the port is open,
      // without the test having to guess when the reader attached.
      void port.readable;
      controller?.enqueue(bytes(`${raw}\r\n`));
    },
    opens: () => opens,
  };
}

/**
 * A port that can be UNPLUGGED, which `restartablePort` deliberately cannot:
 * everything above restarts the source by hand, and the whole subject here is
 * a device that goes away without anyone asking it to.
 *
 * Both halves of the disappearance are modelled, because both are what the
 * source has to survive:
 *
 *  - the live stream ERRORS, exactly as a real port's does when the device is
 *    pulled — that is what ends the read loop mid-flight;
 *  - `open()` then rejects with a `NetworkError` while the device is absent,
 *    which is the name Web Serial uses for a vanished device and is precisely
 *    what makes `openUnlessAlreadyOpen`'s `InvalidStateError` tolerance safe:
 *    the two failures are never confused for one another.
 */
function unpluggablePort(): {
  port: SerialPort;
  scan: (raw: string) => void;
  unplug: () => void;
  replug: () => void;
  opens: () => number;
  attemptsAt: () => number[];
} {
  let present = true;
  let isOpen = false;
  let opens = 0;
  const attemptsAt: number[] = [];
  let stream: ReadableStream<Uint8Array> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const port: SerialPort = {
    open: async () => {
      attemptsAt.push(Date.now());
      if (isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
      if (!present) throw new DOMException("The device has been lost.", "NetworkError");
      isOpen = true;
      opens++;
    },
    close: async () => {
      isOpen = false;
      stream = null;
      controller = null;
    },
    get readable() {
      if (stream) return stream;
      if (!isOpen) return null;
      stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          stream = null;
          controller = null;
        },
      });
      return stream;
    },
  };

  return {
    port,
    scan: (raw) => {
      void port.readable;
      controller?.enqueue(bytes(`${raw}\r\n`));
    },
    unplug: () => {
      present = false;
      isOpen = false;
      controller?.error(new DOMException("The device has been lost.", "NetworkError"));
      stream = null;
      controller = null;
    },
    replug: () => {
      present = true;
    },
    opens: () => opens,
    attemptsAt: () => [...attemptsAt],
  };
}

/**
 * AUTO-RECONNECT, which the design promises in as many words («авто-reconnect
 * при обрыве», design 2026-07-24 §6) and which nothing enforced.
 *
 * Without it a scanner that is unplugged, power-cycled or knocked loose ends
 * the read loop after one `console.error` and the kiosk goes on looking
 * entirely normal with a dead input — recoverable only by an installer
 * re-picking the port through a settings gate that, on a serial kiosk, may
 * itself want the scanner.
 *
 * Every test here drives the clock with fake timers, never a wall-clock wait:
 * a backoff proven by sleeping is a slow test that pins nothing.
 */
describe("web serial reconnect", () => {
  it("comes back after the scanner is unplugged mid-stream, and delivers scans again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, scan, unplug, replug, opens } = unpluggablePort();
    const seen: string[] = [];
    const stop = createWebSerialSource(port).start((raw) => seen.push(raw));
    await vi.advanceTimersByTimeAsync(10);
    scan("MARKIRO-BADGE-1");
    await vi.waitFor(() => expect(seen).toEqual(["MARKIRO-BADGE-1"]));

    // Pulled from the USB socket: the pending read rejects and the loop ends.
    unplug();
    await vi.advanceTimersByTimeAsync(1_000);
    // …and plugged back in, which nothing on the device is told about.
    replug();
    await vi.advanceTimersByTimeAsync(10_000);

    // Re-opened by the source itself, with nobody asked to re-pick a port.
    expect(opens()).toBe(2);
    scan("MARKIRO-BADGE-2");
    await vi.waitFor(() => expect(seen).toEqual(["MARKIRO-BADGE-1", "MARKIRO-BADGE-2"]));

    stop();
    consoleError.mockRestore();
  });

  it("backs off between attempts while the scanner stays away, and never retries faster than the cap", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, unplug, attemptsAt } = unpluggablePort();
    // Absent before the source ever starts, so every attempt below is a retry
    // and the first delay is measured from the first failure.
    unplug();

    const stop = createWebSerialSource(port).start(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    const attempts = attemptsAt();
    let previous = attempts[0] ?? 0;
    const gaps = attempts.slice(1).map((at) => {
      const gap = at - previous;
      previous = at;
      return gap;
    });
    // 250 ms doubling to a five-second ceiling: fast enough that a scanner
    // power-cycled between two workers is back before the second one reaches
    // the kiosk, and bounded so a device left unplugged overnight costs one
    // attempt every five seconds rather than a spin.
    expect(gaps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    consoleError.mockRestore();
  });

  it("cancels a pending retry on stop(), leaving neither a timer nor a reopened port behind", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port, unplug, replug, opens } = unpluggablePort();
    const stop = createWebSerialSource(port).start(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(opens()).toBe(1);

    unplug();
    await vi.advanceTimersByTimeAsync(10);
    // The read has failed and a reconnect is scheduled — the state a transport
    // swap or an unmount actually lands in.
    expect(vi.getTimerCount()).toBe(1);

    stop();

    // Nothing pending, and nothing that could open the device behind the
    // caller's back once it comes back.
    expect(vi.getTimerCount()).toBe(0);
    replug();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opens()).toBe(1);
    consoleError.mockRestore();
  });

  it("never reconnects after an explicit stop(), whatever the port does afterwards", async () => {
    const { port, scan, unplug, replug, opens } = unpluggablePort();
    const seen: string[] = [];
    const stop = createWebSerialSource(port).start((raw) => seen.push(raw));
    await vi.advanceTimersByTimeAsync(10);
    expect(opens()).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(10);
    // The device goes away and comes back while nobody is subscribed. A
    // reconnect here would re-take a port the owner deliberately let go of —
    // and on a transport swap, would read the device out from under the
    // source that replaced this one.
    unplug();
    replug();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(opens()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    scan("MARKIRO-BADGE-1");
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
  });
});

describe("web serial source", () => {
  it("delivers a line terminated by CR/LF, GS separator intact", async () => {
    const { port } = fakePort([bytes(`01046006820000132${GS}93Abcd\r\n`)]);
    const seen: string[] = [];
    createWebSerialSource(port).start((raw) => seen.push(raw));
    await vi.waitFor(() => expect(seen).toEqual([`01046006820000132${GS}93Abcd`]));
  });

  it("splits multiple lines arriving in one chunk", async () => {
    const { port } = fakePort([bytes("MARKIRO-BADGE-1\r\nMARKIRO-BADGE-2\r\n")]);
    const seen: string[] = [];
    createWebSerialSource(port).start((raw) => seen.push(raw));
    await vi.waitFor(() => expect(seen).toEqual(["MARKIRO-BADGE-1", "MARKIRO-BADGE-2"]));
  });

  it("discards unterminated line noise past the cap instead of growing forever or corrupting the next real scan", async () => {
    // Mirrors the station's Rust reader exactly: a chunk with no terminator
    // that pushes the buffer past 4096 chars is garbage (wrong baud rate or
    // a non-scanner device) and is dropped outright — never truncated and
    // emitted as if it were a real scan. A well-formed line that arrives
    // afterwards must be unaffected by the noise that preceded it.
    const noise = "x".repeat(5000); // no CR/LF anywhere in this chunk
    const { port } = fakePort([bytes(noise), bytes("MARKIRO-BADGE-1\r\n")]);
    const seen: string[] = [];
    createWebSerialSource(port).start((raw) => seen.push(raw));
    await vi.waitFor(() => expect(seen).toEqual(["MARKIRO-BADGE-1"]));
  });

  it("never emits an empty payload for a bare terminator", async () => {
    const { port } = fakePort([bytes("\r\n")]);
    const seen: string[] = [];
    createWebSerialSource(port).start((raw) => seen.push(raw));
    // Give the microtask queue a turn; nothing should ever arrive. Fake
    // timers are active for this file, so advance them (there's nothing
    // pending here — this just pumps the async open()/read() chain).
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
  });

  it("does not leak a reader on a start()/stop() race — stop before open() resolves", async () => {
    let resolveOpen!: () => void;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    let readableAccessCount = 0;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes("MARKIRO-BADGE-1\r\n"));
      },
    });
    const port: SerialPort = {
      open: async () => {
        await opened;
      },
      close: async () => {},
      get readable() {
        readableAccessCount++;
        return readable;
      },
    };

    const seen: string[] = [];
    const stop = createWebSerialSource(port).start((raw) => seen.push(raw));
    stop(); // stop lands before open() resolves
    resolveOpen();
    await vi.advanceTimersByTimeAsync(10);

    // The source checks `stopped` immediately after `open()` resolves and
    // before ever touching `port.readable` — so if the getter was never
    // accessed, no reader could have been created, let alone left dangling.
    expect(readableAccessCount).toBe(0);
    expect(seen).toEqual([]);
  });

  it("logs and swallows a failed port.open() instead of leaking an unhandled rejection", async () => {
    // Opening a serial port fails routinely (wrong permissions, port already
    // in use, device unplugged between selection and open — the station's
    // Rust `open_scanner` has a ten-attempt retry loop for exactly this).
    // `start()` must stay synchronous-safe and the rejection must be caught,
    // not left to escape the fire-and-forget async IIFE.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let readableAccessed = false;
    const port: SerialPort = {
      open: async () => {
        throw new Error("port already in use");
      },
      close: async () => {},
      get readable() {
        readableAccessed = true;
        return null;
      },
    };

    const seen: string[] = [];
    let stop!: () => void;
    expect(() => {
      stop = createWebSerialSource(port).start((raw) => seen.push(raw));
    }).not.toThrow();

    // Pump the microtask queue so the rejected open() settles. If it were
    // unhandled, this is where a real runtime would report it; here the
    // proof is that console.error was reached instead.
    await vi.advanceTimersByTimeAsync(10);

    expect(consoleError).toHaveBeenCalledWith(
      "kiosk: web serial scan source failed",
      expect.any(Error),
    );
    expect(readableAccessed).toBe(false);
    expect(seen).toEqual([]);

    // The stop function must still be safe to call after a failed open.
    expect(() => stop()).not.toThrow();

    consoleError.mockRestore();
  });

  it("delivers again after stop() and a second start() on the same port", async () => {
    // The app shell — the single owner of the transport — rebuilds this source
    // whenever the transport changes, so an installer who toggles Serial →
    // Keyboard → Serial within one visit to scanner setup starts the SAME
    // granted port a second time. Without this the second start dies in
    // `open()` (the port is still open from the first) and the screen whose
    // entire purpose is verifying the scanner silently verifies nothing until
    // the kiosk is reloaded.
    const { port, scan, opens } = restartablePort();
    const source = createWebSerialSource(port);

    const first: string[] = [];
    const stop = source.start((raw) => first.push(raw));
    await vi.advanceTimersByTimeAsync(10);
    scan("MARKIRO-BADGE-1");
    await vi.waitFor(() => expect(first).toEqual(["MARKIRO-BADGE-1"]));

    stop();
    await vi.advanceTimersByTimeAsync(10);

    const second: string[] = [];
    source.start((raw) => second.push(raw));
    await vi.advanceTimersByTimeAsync(10);
    scan("MARKIRO-BADGE-2");
    await vi.waitFor(() => expect(second).toEqual(["MARKIRO-BADGE-2"]));

    // ...and the first listener stayed torn down: a restart re-attaches a
    // reader, it does not accumulate them.
    expect(first).toEqual(["MARKIRO-BADGE-1"]);
    // The port is opened once and kept: `stop()` releases the READER, never
    // the device (see the source's stop function for why).
    expect(opens()).toBe(1);
  });

  it("reports availability from isWebSerialSupported, not just from having a port instance", () => {
    vi.stubGlobal("navigator", {});
    const { port } = fakePort([]);
    expect(createWebSerialSource(port).isAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });
});
