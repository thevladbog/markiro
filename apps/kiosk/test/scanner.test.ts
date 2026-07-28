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

  it("reports availability from isWebSerialSupported, not just from having a port instance", () => {
    vi.stubGlobal("navigator", {});
    const { port } = fakePort([]);
    expect(createWebSerialSource(port).isAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });
});
