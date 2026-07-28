import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { App } from "../src/App.js";
import type { CreateOrderDto, KioskBootstrapDto } from "../src/api/types.js";
import i18n from "../src/i18n/index.js";
import type * as KeyboardModule from "../src/scanner/keyboard.js";
import type { ScanSource } from "../src/scanner/source.js";
import type * as WebSerialModule from "../src/scanner/web-serial.js";
import type { SerialPort } from "../src/scanner/web-serial.js";
import { SETTINGS_HOLD_MS } from "../src/screens/Idle.js";
import { replaceSnapshot } from "../src/store/cache.js";
// The namespace as well as the names, so one write can be made to fail under
// the shell without stubbing the whole store — the shape `sync.test.ts` already
// uses for `appendJournal`.
import * as configStore from "../src/store/config.js";
import {
  readConfig,
  writeConfig,
  writeScannerSettings,
  type KioskConfig,
} from "../src/store/config.js";
import { enqueueOrder, listQueue } from "../src/store/queue.js";
import { REFRESH_INTERVAL_MS, STALE_BLOCK_MS } from "../src/sync/worker.js";

afterEach(cleanup);

/**
 * Every transport the device ever STARTS, in order, and every one it STOPS.
 *
 * The shell is the only thing that builds a `ScanSource` — these two factories
 * are the only way one comes into existence — so wrapping them counts the
 * subscriptions the device actually holds. That is the property a transport
 * swap breaks silently: a fan-out re-pointed at a new source without stopping
 * the old one leaves two live subscriptions, and on Web Serial the abandoned
 * one goes on holding the port's reader, so the port cannot be read again.
 * A screen that starts a source of its own shows up here as an extra start
 * against a transport nobody swapped to.
 *
 * The wrappers call straight through, so no other test in this file behaves
 * differently for their presence.
 */
const transports = vi.hoisted(() => {
  const starts: string[] = [];
  const stops: string[] = [];
  return {
    starts,
    stops,
    /** Subscriptions standing right now. One transport, one reader — always. */
    live: () => starts.length - stops.length,
    reset: () => {
      starts.length = 0;
      stops.length = 0;
    },
    count: (kind: string, source: ScanSource): ScanSource => ({
      isAvailable: () => source.isAvailable(),
      start(listener) {
        starts.push(kind);
        const stop = source.start(listener);
        let counted = false;
        return () => {
          // Counted ONCE however often the teardown is called: a double count
          // would cancel a genuine leak out on paper.
          if (!counted) {
            counted = true;
            stops.push(kind);
          }
          stop();
        };
      },
    }),
  };
});

vi.mock("../src/scanner/keyboard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KeyboardModule>();
  return {
    ...actual,
    createKeyboardWedgeSource: (opts?: Parameters<typeof actual.createKeyboardWedgeSource>[0]) =>
      transports.count("keyboard", actual.createKeyboardWedgeSource(opts)),
  };
});

vi.mock("../src/scanner/web-serial.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WebSerialModule>();
  return {
    ...actual,
    createWebSerialSource: (port: SerialPort) =>
      transports.count("serial", actual.createWebSerialSource(port)),
  };
});

// The i18next instance is a module singleton and the sibling screen tests
// switch it to English. Today Vitest's per-file module isolation keeps that out
// of this file, but the assertions below read RU copy and must not depend on
// an isolation setting to stay true — so pin the language here explicitly.
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

const SALT = "fwGrIt01vwgBxxDlhqLVRQ==";
const BADGE = "BADGE-1";
/** An OPERATOR's badge — the settings gate's credential, and deliberately not
 * an employee's: the two rosters are separate and only this one opens setup. */
const OPERATOR_BADGE = "OP-BADGE-1";
const OPERATOR_LOGIN = "1001";
const OPERATOR_PIN = "4821";
const GS = String.fromCharCode(0x1d);
/** Check-digit valid, and in the snapshot's product list. */
const GTIN_MILK = "04600682000013";
const MILK = "Молоко 3,2%";
const KM = `01${GTIN_MILK}21KYC9X7MQ${GS}93Abcd`;
const EMPLOYEE = { id: "e1", fullName: "Смирнов Алексей" };

const IDLE_TITLE = "Возьмите продукцию для себя";
const CART_TITLE = "Вы берёте";
const SUBMIT = "Готово — передать администратору";
const QUEUED_TITLE = "Заявка передана, номер появится после синхронизации";
const OFFLINE = "Нет связи — киоск работает офлайн";
const GATE_TITLE = "Вход в настройки";
const SETUP_TITLE = "Настройка сканера";
const SETUP_DONE = "Готово";
const KEYBOARD_TRANSPORT = "Как клавиатура (HID)";
const SERIAL_TRANSPORT = "Web Serial (COM-порт)";
const PAIRING_TITLE = "Подключение киоска";
/** The setup screen's test-scan verdicts, as an installer reads them. */
const VERDICT_KM = "Код маркировки";
const VERDICT_BADGE = "Бейдж";
const VERDICT_UNKNOWN = "Не распознано";

/** The kiosk's own clock, frozen so staleness is arithmetic rather than luck. */
const NOW = new Date("2026-07-28T12:00:00.000Z");

/**
 * A real PHC verifier for `BADGE`, derived once: the shell resolves the badge
 * through the real `credentials/badge.ts`, so a hand-written hash would simply
 * never match and every session test would fail for the wrong reason.
 */
let badgeHash = "";
let operatorBadgeHash = "";
let operatorPinHash = "";
beforeAll(async () => {
  const phc = async (raw: string) =>
    formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(raw, SALT, PHC_ITERATIONS));
  badgeHash = await phc(BADGE);
  operatorBadgeHash = await phc(OPERATOR_BADGE);
  operatorPinHash = await phc(OPERATOR_PIN);
});

function bootstrapAt(generatedAt: string): KioskBootstrapDto {
  return {
    generatedAt,
    config: { dayLimitPerEmployee: 5, showPrices: true },
    badgeSalt: SALT,
    reasons: [{ id: "r-defect", name: "Брак" }],
    products: [
      { id: "p-milk", gtin14: GTIN_MILK, name: MILK, unitPrice: "89.90", egaisCode: null },
    ],
    employees: [{ id: EMPLOYEE.id, fullName: EMPLOYEE.fullName, role: null, badgeHash }],
    // One operator, so the post-pairing settings gate has somebody who can
    // actually open it — by badge or by personnel number and PIN, since the
    // tests below need both entrances.
    operators: [
      {
        employeeId: "op-1",
        name: "Петрова Ольга",
        login: OPERATOR_LOGIN,
        role: "operator",
        pinHash: operatorPinHash,
        badgeHash: operatorBadgeHash,
        active: true,
      },
    ],
  };
}

/** The API, as far as the device can tell: reachable or not, and what it has
 * been asked to do. `reachable: false` is what "offline" means end to end — a
 * `fetch` that rejects, exactly as a dead network does. */
interface FakeServer {
  reachable: boolean;
  generatedAt: string;
  bootstraps: number;
  orders: CreateOrderDto[];
}
let server: FakeServer;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // `setImmediate` is deliberately NOT faked: `fake-indexeddb` schedules every
  // transaction step through it, so faking it would freeze the whole store and
  // no test here could read or write anything. Everything the shell actually
  // drives with time — the refresh interval, the wedge's silence timeout, the
  // confirmation's auto-reset and `Date` itself — is faked.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(NOW);
  transports.reset();
  server = { reachable: true, generatedAt: NOW.toISOString(), bootstraps: 0, orders: [] };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!server.reachable) throw new TypeError("Failed to fetch");
    if (url.endsWith("/kiosk/bootstrap")) {
      server.bootstraps += 1;
      return jsonResponse(bootstrapAt(server.generatedAt));
    }
    if (url.endsWith("/kiosk/orders")) {
      const body = JSON.parse(String(init?.body)) as CreateOrderDto;
      server.orders.push(body);
      return jsonResponse({
        orderNo: `ORD-26-${String(body.deviceSeq).padStart(4, "0")}`,
        status: "pending",
        itemCount: body.items.length,
        conflicts: [],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  setOnLine(true);
  setWebSerial(null);
  vi.restoreAllMocks();
});

/** jsdom's `navigator.onLine` is a prototype getter; an own property shadows
 * it for the length of a test, which is how the boot-time reading is driven. */
function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

const config = (over: Partial<KioskConfig> = {}): KioskConfig => ({
  serverUrl: "/api",
  token: "tok-abc",
  kioskName: "Склад №1",
  place: "Проходная",
  nextDeviceSeq: 5,
  ...over,
});

/** Puts the device in the state a completed pairing leaves it in. */
async function pair(generatedAt = NOW.toISOString(), over: Partial<KioskConfig> = {}) {
  await replaceSnapshot(bootstrapAt(generatedAt), NOW);
  await writeConfig(config(over));
}

const queuedOrder = (deviceSeq: number): CreateOrderDto => ({
  deviceSeq,
  badgeCode: BADGE,
  reason: "buy",
  items: [{ rawKm: KM }],
  createdAt: NOW.toISOString(),
});

/**
 * Waits for the shell to settle on an assertion.
 *
 * `vi.waitFor` and NOT the Testing Library one: this one SCHEDULES its polls on
 * real timers (`getSafeTimers()`, captured before the fakes are installed),
 * while the Testing Library version polls with the faked `setInterval` and
 * would simply hang here.
 *
 * It does not leave the kiosk's clock alone, though. Vitest 4.1.10 calls
 * `vi.advanceTimersByTime(interval)` — 50 ms — before every poll while fake
 * timers are active, so a `settle()` that runs its full budget advances the
 * device's clock by up to the 2 s below. Nothing here depends on it today; the
 * shortest thing this shell schedules is the wedge's 60 ms silence timeout and
 * the assertions that care about it advance the clock themselves. Worth knowing
 * before adding a test whose subject is shorter than a settle.
 *
 * And deliberately NOT inside `act()`, which is the natural thing to reach for
 * and is exactly wrong: an async `act` scope diverts every update React
 * schedules while it is open into the act queue and flushes that queue only
 * when the scope EXITS. Everything this shell does — reading the config,
 * resolving a badge, filing an order — reaches the DOM through a promise
 * continuation, so an assertion polling inside such a scope waits for a render
 * that cannot happen until it stops waiting, and every test here would time
 * out. Outside it, the continuations commit normally and the poll sees them.
 *
 * ONE act flush afterwards, though, and it is load-bearing. A poll can be
 * satisfied by a COMMIT whose passive effects React has not run yet — and the
 * subscription every screen here makes to the scanner lives in exactly such an
 * effect. Without this flush, a `scan()` issued the moment a screen's title
 * appears is delivered to a listener set that screen has not joined, and is
 * simply lost; the next assertion then waits two seconds for something that
 * already happened to nobody. It shows up as a rare failure on a loaded
 * machine, which is the worst way for it to show up.
 */
async function settle(assert: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(assert, { timeout: 2_000 });
  await act(async () => {});
}

/**
 * A scan, delivered the way the device really delivers one: as keystrokes on
 * `window`, through the keyboard wedge the shell built. Nothing is injected —
 * if the shell's `ScanSource` is not wired to the screen, nothing happens.
 */
function scan(raw: string): void {
  act(() => {
    for (const char of raw) window.dispatchEvent(new KeyboardEvent("keydown", { key: char }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  });
}

const said = () => document.body.textContent ?? "";

/** The kiosk's on-screen pad — the gate's other entrance, for an operator whose
 * scanner is exactly what they came to fix. */
function typeDigits(digits: string): void {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

/**
 * The gate's OTHER entrance: personnel number, then PIN.
 *
 * The one an operator uses when their badge is not to hand — or when the
 * scanner is the very thing they came to fix — and therefore the entrance every
 * test whose subject is the SETTINGS rather than the gate signs in through.
 */
async function signInWithPin(): Promise<void> {
  typeDigits(OPERATOR_LOGIN);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  });
  typeDigits(OPERATOR_PIN);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
  });
}

/** The setup screen's single live region — its test-scan verdict. The status
 * strip is not mounted on that view, so there is exactly one. */
const verdict = () => screen.getByRole("status").textContent;

const transportRadio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

async function pickTransport(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(transportRadio(name));
  });
  await settle(() => expect(transportRadio(name).checked).toBe(true));
}

/**
 * A press on the idle header, held for `ms` of the kiosk's clock and released.
 *
 * The element is captured BEFORE the press because a successful hold routes
 * the screen away mid-gesture; the release then lands on a detached node,
 * which is exactly what a real finger's `pointerup` does after the UI moved.
 */
async function holdIdleHeader(ms: number): Promise<void> {
  const header = screen.getByText(IDLE_TITLE);
  await act(async () => {
    fireEvent.pointerDown(header);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    fireEvent.pointerUp(header);
  });
}

/**
 * A `SerialPort` whose readable stream this test drives, so a scan can be
 * pushed through the REAL `createWebSerialSource`. Models the port's actual
 * lifecycle — `open()` on a port that is not closed rejects, `readable` is null
 * while closed, a cancelled stream is dropped so the next access vends a fresh
 * one — mirroring `fakePort` in `test/scanner-setup.test.tsx`.
 */
function fakeSerialPort(): {
  port: SerialPort;
  scan: (raw: string) => void;
  released: () => boolean;
} {
  let isOpen = false;
  let stream: ReadableStream<Uint8Array> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const port: SerialPort = {
    open: async () => {
      if (isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
      isOpen = true;
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
        start: (c) => {
          controller = c;
        },
        cancel: () => {
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
      controller?.enqueue(new TextEncoder().encode(`${raw}\r\n`));
    },
    // Nobody is reading this port. A cancelled reader propagates upstream
    // through the decoder pipe and drops the stream, exactly as a real port
    // does — which makes "the old transport was torn down" observable without
    // racing a PBKDF2 derivation to prove a negative in the DOM.
    released: () => stream === null,
  };
}

/** `isWebSerialSupported()` reads `"serial" in navigator`, so the capability is
 * driven through its real input rather than by stubbing the module. */
function setWebSerial(port: SerialPort | null): void {
  if (port === null) {
    delete (navigator as { serial?: unknown }).serial;
    return;
  }
  Object.defineProperty(navigator, "serial", {
    value: { requestPort: async () => port, getPorts: async () => [port] },
    configurable: true,
    writable: true,
  });
}

/** Badge in, one bottle scanned, submit pressed — the whole worker's flow. */
async function takeOneBottle(): Promise<void> {
  scan(BADGE);
  await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
  scan(KM);
  await settle(() => expect(screen.getByText(MILK)).toBeDefined());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
  });
}

describe("KioskShell", () => {
  it("asks an unpaired device for a pairing code, and calls no API without a token", async () => {
    render(<App />);

    await settle(() => expect(screen.getByText("Подключение киоска")).toBeDefined());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("waits for a badge on a paired device whose snapshot is fresh", async () => {
    await pair();

    render(<App />);

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    // The strip is mounted, and it is the shell that mounts it — no screen does.
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();
  });

  // A blocked kiosk is not a lost kiosk: the orders it already took are still
  // owed to the server, and the count is what an administrator reconciles
  // against the panel. It has to be the CURRENT count, read from the store,
  // not a zero the shell never refreshed.
  it("stops handing product out past the block threshold, and still counts the queue", async () => {
    await pair(new Date(NOW.getTime() - STALE_BLOCK_MS - 1_000).toISOString());
    await enqueueOrder(queuedOrder(3));
    await enqueueOrder(queuedOrder(4));
    server.reachable = false;

    render(<App />);

    await settle(() =>
      expect(screen.getByText("Киоск временно не выдаёт продукцию")).toBeDefined(),
    );
    expect(said()).toContain("в очереди: 2");
  });

  it("opens the cart for the badge it recognises, and closes it again on «Не я»", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    expect(screen.getByText(EMPLOYEE.fullName)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Не я" }));
    });

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
  });

  it("submits online and shows the number the server gave back", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await takeOneBottle();

    await settle(() => expect(screen.getByText("Заявка № ORD-26-0005 передана")).toBeDefined());
    expect(server.orders).toHaveLength(1);
    expect(server.orders[0]).toMatchObject({
      deviceSeq: 5,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: KM }],
    });
    // Acknowledged, so it has left the queue — and the counter moved on, or the
    // next order would collide with this one's idempotency key.
    expect(await listQueue()).toEqual([]);
    expect((await readConfig())?.nextDeviceSeq).toBe(6);
  });

  it("confirms an offline handover without a number and keeps the order queued", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    server.reachable = false;
    setOnLine(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    await takeOneBottle();

    await settle(() => expect(screen.getByText(QUEUED_TITLE)).toBeDefined());
    // No number, and nothing in a number's shape: the server has not seen this
    // order, so any «№ …» here would send the worker to an administrator with
    // something that matches no order at all.
    expect(said()).not.toContain("ORD-");
    expect((await listQueue()).map((entry) => entry.deviceSeq)).toEqual([5]);
    expect(screen.getByText(OFFLINE)).toBeDefined();
  });

  // `Cart` has no busy prop, so both halves of a double tap reach the shell
  // before anything can re-render. A second order would be filed under the next
  // device sequence — one worker's bottles, two orders.
  it("files exactly one order when the submit is double-tapped", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    server.reachable = false;
    scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    scan(KM);
    await settle(() => expect(screen.getByText(MILK)).toBeDefined());

    await act(async () => {
      const button = screen.getByRole("button", { name: SUBMIT });
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await settle(() => expect(screen.getByText(QUEUED_TITLE)).toBeDefined());
    expect(await listQueue()).toHaveLength(1);
    expect((await readConfig())?.nextDeviceSeq).toBe(6);
  });

  /**
   * The gap the synchronous double tap above cannot reach — and the one the
   * shell's guard actually exists for.
   *
   * Both halves of that tap read the SAME `nextDeviceSeq`, because the counter
   * only advances after the order is durable, so the second one re-files the
   * first order under its own idempotency key and nothing is lost. Here the
   * first submit has already advanced the counter and is parked on a slow POST
   * with `Cart` — and its live button — still on screen. A second tap now would
   * file a genuine second order for one worker's bottles.
   */
  it("ignores a second tap that lands while the first order is still in flight", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    let deliver = () => {};
    const held = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const respond = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/kiosk/orders")) await held;
      return respond(input, init);
    }) as unknown as typeof fetch;

    await takeOneBottle();
    await settle(async () => expect((await readConfig())?.nextDeviceSeq).toBe(6));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    });
    deliver();

    await settle(() => expect(screen.getByText("Заявка № ORD-26-0005 передана")).toBeDefined());
    expect(server.orders.map((order) => order.deviceSeq)).toEqual([5]);
    expect((await readConfig())?.nextDeviceSeq).toBe(6);
  });

  /**
   * The one failure a reused `deviceSeq` produces, and it is silent.
   *
   * `(tenantId, kioskId, deviceSeq)` is the server's idempotency key: filing a
   * second order under a sequence the server has already seen does not create
   * an order, it RETURNS the first one. So a counter that stayed behind after a
   * durable order does not cost a duplicate — it costs the NEXT worker their
   * whole cart, confirmed to them under somebody else's order number.
   *
   * A skipped sequence, by contrast, costs nothing at all: the server needs the
   * numbers to be monotonic, not dense. That asymmetry is the entire reason the
   * counter is written before the order, and it is what this test pins.
   */
  it("never files two orders under one device sequence when the counter write fails", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // The first worker submits into a config store that refuses exactly one
    // write; every later write is the real one again.
    const refused = vi
      .spyOn(configStore, "writeConfig")
      .mockRejectedValueOnce(new Error("the config store refused the write"));
    await takeOneBottle();
    await settle(() => expect(refused).toHaveBeenCalled());
    await act(async () => {});
    // Nothing was promised: no number, no confirmation, still their own cart.
    expect(screen.getByText(CART_TITLE)).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Не я" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // Whatever DID become durable leaves on the ordinary interval, unattended.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    // And now the next worker takes their own bottle.
    await takeOneBottle();
    await settle(() => expect(said()).toContain("ORD-"));

    const seqs = server.orders.map((order) => order.deviceSeq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("drains the queue when the device comes back online", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3));
    server.reachable = false;
    setOnLine(false);
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    expect(await listQueue()).toHaveLength(1);

    server.reachable = true;
    setOnLine(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await settle(async () => expect(await listQueue()).toEqual([]));
    expect(server.orders.map((order) => order.deviceSeq)).toEqual([3]);
  });

  it("pulls a fresh bootstrap on every refresh interval", async () => {
    await pair();
    render(<App />);

    // At boot, not only after the first interval: a kiosk switched on in the
    // morning must not spend five minutes deciding from yesterday's roster.
    await settle(() => expect(server.bootstraps).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    await settle(() => expect(server.bootstraps).toBe(2));
  });

  // `refreshSnapshot` rejects on purpose — that rejection is the one signal
  // that tells the strip the device is offline. Uncaught, it would take the
  // whole kiosk down five minutes after the network blinked.
  it("survives a refresh that fails, keeps working, and says the kiosk is offline", async () => {
    await pair();
    server.reachable = false;

    render(<App />);

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText(OFFLINE)).toBeDefined());
    // Still usable: the cached snapshot is fresh, only the network is gone.
    scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
  });

  // The `ScanSource` must be ONE object for the life of a transport. `Idle`
  // subscribes at mount and never again, and the wedge accumulates its payload
  // in the closure a teardown discards — so a source rebuilt on a re-render
  // silently truncates whatever is being scanned at that moment.
  it("keeps a single scanner subscription across re-renders, mid-scan included", async () => {
    await pair();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    const keydownAdds = () => added.mock.calls.filter(([type]) => type === "keydown").length;
    const keydownRemovals = () => removed.mock.calls.filter(([type]) => type === "keydown").length;
    expect(keydownAdds()).toBe(1);

    // Half a badge…
    act(() => {
      for (const char of "BADGE") window.dispatchEvent(new KeyboardEvent("keydown", { key: char }));
    });
    // …a shell re-render in the middle of it (no time passes, so the wedge's
    // silence timeout cannot be what carries the payload)…
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    // …and the rest.
    scan("-1");

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    expect(keydownAdds()).toBe(1);
    expect(keydownRemovals()).toBe(0);
  });

  it("gives the next worker an empty cart", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await takeOneBottle();
    await settle(() => expect(screen.getByText("Заявка № ORD-26-0005 передана")).toBeDefined());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    expect(screen.getByText("Пока пусто")).toBeDefined();
    expect(screen.queryByText(MILK)).toBeNull();
  });

  /**
   * The way back into scanner setup once the kiosk is running.
   *
   * Before this existed, `scannerSetupRequested` could only be raised by the
   * PAIRING screen — which is on screen only while the device is unpaired — so
   * the whole post-pairing operator gate was unreachable, and a kiosk whose
   * scanner died after commissioning could be recovered only by unbinding it
   * from the cabinet. Design brief 07 §5 asks for a settings affordance on the
   * running kiosk, and a deliberate long press rather than a visible control:
   * this screen stands in a public room.
   */
  it("leaves the settings gate shut when the idle header is merely tapped", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await holdIdleHeader(200);
    // And the clock runs on well past the hold: a press that was released must
    // not open the gate late, behind whoever tapped it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.queryByText(GATE_TITLE)).toBeNull();
    expect(screen.queryByText(SETUP_TITLE)).toBeNull();
    expect(screen.getByText(IDLE_TITLE)).toBeDefined();
  });

  it("opens the operator sign-in gate on a deliberate long press of the idle header", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await holdIdleHeader(SETTINGS_HOLD_MS);

    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    // The GATE, not the settings: this kiosk is paired, so the second access
    // tier applies and the transport radios are not in the document at all.
    expect(screen.queryByText(SETUP_TITLE)).toBeNull();
  });

  // The gate is worth nothing if it only shuts once. An unattended kiosk that
  // stayed unlocked behind the idle screen is the whole reason it exists.
  it("re-locks the settings gate when the kiosk returns to idle", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());

    scan(OPERATOR_BADGE);
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SETUP_DONE }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await holdIdleHeader(SETTINGS_HOLD_MS);

    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    expect(screen.queryByText(SETUP_TITLE)).toBeNull();
  });

  /**
   * The badge tier of the settings gate, on the transport this product is
   * actually built around.
   *
   * Web Serial is the RECOMMENDED configuration — it is the whole reason the
   * transport exists, because a DataMatrix marking code reads poorly through a
   * keyboard wedge — so a badge sign-in that only works on the wedge is one
   * that does not work where it matters. PIN sign-in kept anyone from being
   * locked out, which is exactly why this could stay silently dead.
   *
   * `createWebSerialSource` is SINGLE-SUBSCRIBER: the shell has held this
   * port's reader since boot, so a listener the setup screen starts on its own
   * copy of that source reads nothing at all. The gate has to read the shell's
   * fan-out — the same subscription `Idle` and `Cart` take.
   */
  it("signs an operator in at the settings gate on a badge read over Web Serial", async () => {
    const scanner = fakeSerialPort();
    setWebSerial(scanner.port);
    await writeScannerSettings({ transport: "serial" });
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // Proving the port is genuinely the SHELL's before the gate is ever
    // opened: this scan is answered by the shell's own reader, which is the
    // reader that then goes on holding the port under the setup screen.
    scanner.scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Не я" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());

    scanner.scan(OPERATOR_BADGE);

    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());
  });

  /**
   * PAIRING, on a serial kiosk — and the commissioning order the brief actually
   * prescribes (design brief 07 §5): configure the scanner FIRST, precisely so
   * the pairing code can be scanned off the admin panel rather than typed.
   *
   * An installer who follows it lands here: Web Serial configured, the grant
   * surviving into the next boot, and a pairing screen that has to read the
   * code off that port. The shell has held the port's only reader since boot,
   * so a pairing screen starting a reader of its own on the same transport
   * reads nothing at all — and the one flow the transport was configured for
   * is the one flow it cannot serve.
   */
  it("takes the pairing code off the serial scanner the installer configured first", async () => {
    const scanner = fakeSerialPort();
    setWebSerial(scanner.port);
    // What scanner setup leaves behind on an as-yet unpaired device, which is
    // exactly the state the prescribed order puts this device in.
    await writeScannerSettings({ transport: "serial" });

    render(<App />);

    await settle(() => expect(screen.getByText(PAIRING_TITLE)).toBeDefined());
    // The recovered grant, not the wedge: this screen is being read over the
    // port before a single byte is pushed through it.
    await settle(() => expect(transports.starts).toContain("serial"));

    scanner.scan("12345678");

    await settle(() => expect(screen.getByRole("status").textContent).toBe("12345678"));
    expect((screen.getByRole("button", { name: "Подключить" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * The TEST SCAN on a serial kiosk, reached the way an operator actually
   * reaches it: a long press and a PIN, with no transport re-picked.
   *
   * Nothing about that visit changes the transport — the kiosk is already on
   * the port it was commissioned with — so the screen whose entire purpose is
   * proving the scanner works has to read the transport the shell is running.
   * Reading a source of its own over the same port reads nothing, and the
   * installer is left on «Ждём сканирование…» in front of a scanner that is
   * working perfectly.
   */
  it("verifies the scanner after a PIN sign-in on a serial kiosk, with nothing re-picked", async () => {
    const scanner = fakeSerialPort();
    setWebSerial(scanner.port);
    await writeScannerSettings({ transport: "serial" });
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    await signInWithPin();
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());

    scanner.scan(KM);

    await settle(() => expect(verdict()).toBe(VERDICT_KM));
  });

  /**
   * THE GREEN LIGHT MUST BELONG TO THE TRANSPORT THE INSTALLER PICKED.
   *
   * Task 11's review caught the opposite: a test scan certifying whatever the
   * kiosk happened to be running, so an installer picks Web Serial, the wedge
   * answers, and the verdict says nothing about the port. GS handling is the
   * one thing the two transports disagree about and is exactly what the verdict
   * reports, so a green light against the wrong transport is worse than none.
   *
   * The property is kept here by OWNERSHIP rather than by a second, competing
   * subscription: the pick swaps the shell's transport, so reading the device's
   * scanner IS reading what was picked. Both halves are pinned — the old
   * transport goes quiet, and the new one is what answers.
   */
  it("moves the test scan onto the transport just picked, and off the one before it", async () => {
    const scanner = fakeSerialPort();
    // Web Serial exists and the picker will hand this port over — but nothing
    // is stored, so this kiosk boots on the wedge.
    setWebSerial(scanner.port);
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    await signInWithPin();
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());

    // On the wedge, the wedge certifies.
    scan(BADGE);
    await settle(() => expect(verdict()).toBe(VERDICT_BADGE));

    await pickTransport(SERIAL_TRANSPORT);

    // The wedge is not this kiosk's transport any more, so it certifies
    // nothing: this payload would read «Не распознано» if it still arrived.
    scan(GTIN_MILK);
    await act(async () => {});
    expect(verdict()).not.toBe(VERDICT_UNKNOWN);
    expect(verdict()).toBe(VERDICT_BADGE);

    // ...and the verdict now comes from the port that was picked.
    scanner.scan(KM);
    await settle(() => expect(verdict()).toBe(VERDICT_KM));
  });

  /**
   * ONE TRANSPORT, ONE SUBSCRIPTION — across every swap in a visit.
   *
   * A swap that starts the new transport without stopping the old leaves two
   * readers running. On Web Serial that is not merely untidy: the abandoned
   * reader keeps `port.readable` locked, so the NEXT start of that same port
   * reads nothing and the kiosk needs a reload to scan again. Counting starts
   * and stops is what makes the leak visible before the symptom does — a screen
   * that quietly opens a transport of its own appears here as a start nobody
   * swapped to.
   *
   * It ends on a real scan through the twice-picked port, so "one subscription"
   * means a working scanner and not just a tidy ledger.
   */
  it("holds exactly one transport subscription across a swap, and lets go of the one it left", async () => {
    const scanner = fakeSerialPort();
    setWebSerial(scanner.port);
    await writeScannerSettings({ transport: "serial" });
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // Boot: the wedge stands until the recovered grant replaces it — and is
    // stopped when it does, not merely forgotten.
    await settle(() => expect(transports.starts).toEqual(["keyboard", "serial"]));
    expect(transports.stops).toEqual(["keyboard"]);
    expect(transports.live()).toBe(1);

    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    await signInWithPin();
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());
    // Opening the settings subscribes a SCREEN, never a transport.
    expect(transports.starts).toEqual(["keyboard", "serial"]);

    await pickTransport(KEYBOARD_TRANSPORT);
    await settle(() => expect(transports.stops).toEqual(["keyboard", "serial"]));
    expect(transports.starts).toEqual(["keyboard", "serial", "keyboard"]);
    expect(transports.live()).toBe(1);
    // The device itself is let go of, not only our reader's bookkeeping.
    await settle(() => expect(scanner.released()).toBe(true));

    await pickTransport(SERIAL_TRANSPORT);
    await settle(() =>
      expect(transports.starts).toEqual(["keyboard", "serial", "keyboard", "serial"]),
    );
    expect(transports.stops).toEqual(["keyboard", "serial", "keyboard"]);
    expect(transports.live()).toBe(1);

    // And the port picked for the second time still delivers.
    scanner.scan(KM);
    await settle(() => expect(verdict()).toBe(VERDICT_KM));
  });

  /**
   * The transport swap, end to end and through the real `navigator.serial`.
   *
   * This kiosk boots on the port a previous visit granted (`getPorts()` is the
   * only thing a boot can recover — `requestPort()` needs a gesture the shell
   * never has), an operator moves it back to the keyboard wedge, and the screen
   * the worker is standing at has to follow. Nothing before this exercised a
   * `SerialPort`, a transport change, or the setup screen from the shell.
   */
  it("moves the idle screen onto the transport the setup screen settles on", async () => {
    const scanner = fakeSerialPort();
    setWebSerial(scanner.port);
    await writeScannerSettings({ transport: "serial" });
    await pair();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    /** Wedge listeners still standing — the shell's, plus any screen's. */
    const wedges = () =>
      added.mock.calls.filter(([type]) => type === "keydown").length -
      removed.mock.calls.filter(([type]) => type === "keydown").length;
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // The recovered grant takes over from the wedge the shell boots on, and a
    // badge read off the port opens a session.
    await settle(() => expect(wedges()).toBe(0));
    scanner.scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Не я" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // An operator moves the kiosk back to the wedge, signing in on the pad —
    // the gate's OTHER entrance, and the one for an operator whose badge is
    // not to hand (or whose scanner is the very thing they came to fix). The
    // badge over this same held-open port is the test above.
    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    typeDigits(OPERATOR_LOGIN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    });
    typeDigits(OPERATOR_PIN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    });
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: KEYBOARD_TRANSPORT }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SETUP_DONE }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    // The old transport is let go of — the port has no reader left — and the
    // wedge is standing again.
    await settle(() => expect(scanner.released()).toBe(true));
    await settle(() => expect(wedges()).toBe(1));

    // And it is the wedge the idle screen now answers.
    scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    expect(screen.getByText(EMPLOYEE.fullName)).toBeDefined();
    added.mockRestore();
    removed.mockRestore();
  });

  // `Done`'s "already reset" flag is a sticky ref, so a re-used instance would
  // never auto-reset again: the second worker's confirmation would stand on
  // screen until somebody pressed the button.
  it("auto-resets the second order's confirmation as well as the first's", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await takeOneBottle();
    await settle(() => expect(screen.getByText("Заявка № ORD-26-0005 передана")).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await takeOneBottle();
    await settle(() => expect(screen.getByText("Заявка № ORD-26-0006 передана")).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
  });
});
