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
  readScannerSettings,
  writeConfig,
  writeScannerSettings,
  type KioskConfig,
} from "../src/store/config.js";
import { appendJournal, type JournalEntry } from "../src/store/journal.js";
import { enqueueOrder, listQuarantine, listQueue } from "../src/store/queue.js";
import { REFRESH_INTERVAL_MS, RETRY_MAX_MS, STALE_BLOCK_MS } from "../src/sync/worker.js";

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
/** The digest half of `badgeHash` — what an ORDER names the employee by, since
 * the scanned code must never reach the device's stores. */
let badgeDigest = "";
let operatorBadgeHash = "";
let operatorPinHash = "";
beforeAll(async () => {
  const phc = async (raw: string) =>
    formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(raw, SALT, PHC_ITERATIONS));
  badgeHash = await phc(BADGE);
  badgeDigest = await deriveDigestB64(BADGE, SALT, PHC_ITERATIONS);
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
    employees: [
      {
        id: EMPLOYEE.id,
        fullName: EMPLOYEE.fullName,
        role: null,
        badgeHash,
        // What this worker took at the OTHER kiosks today, which is the one
        // part of their day count this device cannot see for itself.
        takenTodayElsewhere: server.takenTodayElsewhere,
      },
    ],
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
  /**
   * The server no longer knows this device — the kiosk archived, or a
   * replacement device having redeemed a new token. `KioskDeviceGuard` answers
   * every authenticated route with 401, and it is definitive: unlike
   * `reachable: false`, the device is being ANSWERED.
   */
  revoked: boolean;
  /**
   * A GATEWAY IN FRONT OF AN API THAT IS NOT THERE — the Vite dev proxy's 502
   * with the API stopped, and Caddy's in front of a production deployment
   * (roadmap plan 08). `null` is a gateway simply passing requests through.
   *
   * Deliberately a RESOLVED response rather than a rejected `fetch`, and that is
   * the whole point of it: `reachable: false` models a dropped connection, which
   * is the only outage every test here modelled until a live smoke run found the
   * other one. A gateway ANSWERS, from the wrong machine, and the device read
   * that answer as proof of an application it had never reached.
   */
  gateway: number | null;
  generatedAt: string;
  /**
   * What the roster reports this employee took today AT EVERY OTHER KIOSK —
   * `employees[].takenTodayElsewhere`, and deliberately never a total. The
   * device adds it to what it counts off its own journal and queue, so the two
   * halves come from disjoint sources and cannot overlap.
   */
  takenTodayElsewhere: number;
  bootstraps: number;
  orders: CreateOrderDto[];
}
let server: FakeServer;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ message }),
  } as unknown as Response;
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
  server = {
    reachable: true,
    revoked: false,
    gateway: null,
    generatedAt: NOW.toISOString(),
    takenTodayElsewhere: 0,
    bootstraps: 0,
    orders: [],
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!server.reachable) throw new TypeError("Failed to fetch");
    // BEFORE the guard, and before any route: a proxy that cannot reach the
    // application answers on its own behalf, so nothing behind it ever sees the
    // request — not the device guard, not the order handler.
    if (server.gateway !== null) return errorResponse(server.gateway, "Bad Gateway");
    // The guard sits in front of every `/kiosk` route but the pairing redeem,
    // so a revoked device is refused before anything looks at the request.
    if (server.revoked) return errorResponse(401, "Unauthorized");
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

/** The gate this device is bound to, as pairing records it — and what the
 * journal's entries have to name to be counted as this gate's. */
const KIOSK_ID = "k-1";

const config = (over: Partial<KioskConfig> = {}): KioskConfig => ({
  serverUrl: "/api",
  token: "tok-abc",
  kioskId: KIOSK_ID,
  kioskName: "Склад №1",
  place: "Проходная",
  nextDeviceSeq: 5,
  ...over,
});

/**
 * Puts the device in the state a completed pairing leaves it in.
 *
 * The snapshot is stamped as FETCHED when it was generated, which is what a
 * real refresh does — the two are a round trip apart. Staleness is measured as
 * elapsed time since that fetch (`serverNow`, so a skewed tablet clock cancels
 * out), so a device that last synced a week ago is one whose snapshot was both
 * generated and fetched a week ago; a bundle generated last week but received
 * seconds ago says something about the SERVER, not about this device's age.
 */
async function pair(generatedAt = NOW.toISOString(), over: Partial<KioskConfig> = {}) {
  await replaceSnapshot(bootstrapAt(generatedAt), new Date(generatedAt));
  await writeConfig(config(over));
}

const queuedOrder = (deviceSeq: number): CreateOrderDto => ({
  deviceSeq,
  badgeDigest,
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

/**
 * Web Serial exists and the picker would still hand this port over — but
 * `getPorts()` answers empty, which is what a browser that no longer holds the
 * grant says: a reset profile, a different machine, a scanner that moved.
 *
 * The distinction from `setWebSerial` is the whole point of the test below: a
 * device in this state has a STORED transport of "serial" it cannot honour, so
 * the shell falls back to the wedge — and the stored mode is then a description
 * of a kiosk that no longer exists.
 */
function setWebSerialWithoutGrant(port: SerialPort): void {
  Object.defineProperty(navigator, "serial", {
    value: { requestPort: async () => port, getPorts: async () => [] },
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
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    await enqueueOrder(queuedOrder(4), EMPLOYEE.id);
    server.reachable = false;

    render(<App />);

    await settle(() =>
      expect(screen.getByText("Киоск временно не выдаёт продукцию")).toBeDefined(),
    );
    expect(said()).toContain("в очереди: 2");
  });

  /**
   * A REVOKED DEVICE MUST STOP, and «нет связи» is not what happened.
   *
   * `GET /kiosk/bootstrap` answers 401 once the kiosk is archived or a
   * replacement device has redeemed a new token. Read as an outage — which is
   * what every other refresh failure is — the device keeps its cached roster
   * and goes on admitting employees and confirming withdrawals for the seven
   * days it takes that roster to age out, none of which can ever authenticate.
   *
   * Back to PAIRING rather than to `Blocked`, because the worker in front of it
   * has to be told something true: `Blocked` says the data is stale and
   * promises the queue will go out «как только появится связь», and on a
   * revoked device both halves are false. Pairing states the device's actual
   * condition and offers the one action that fixes it.
   */
  it("sends a device the server no longer knows back to pairing, and stops transacting", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    server.revoked = true;

    render(<App />);

    await settle(() => expect(screen.getByText(PAIRING_TITLE)).toBeDefined());
    // The token is gone, which is what actually stops the device: there is no
    // request left it could authenticate.
    expect((await readConfig())?.token).toBeNull();
    // Not the idle screen, and therefore no badge can open a session at all.
    expect(screen.queryByText(IDLE_TITLE)).toBeNull();
    // Nothing was posted with a credential the server has already refused.
    expect(server.orders).toEqual([]);
  });

  /**
   * AND THE QUEUE IS PARKED, NOT CARRIED ACROSS — which looks like tidying and
   * is the difference between a re-paired kiosk and a silent data loss.
   *
   * Re-pairing redeems a code for a DIFFERENT kiosk row whose `nextDeviceSeq`
   * starts again at 0, so old orders left in the queue would drain under
   * sequences the new identity is about to hand out. The server answers a
   * repeated `(tenantId, kioskId, deviceSeq)` by returning the FIRST order
   * rather than filing a second, so some later worker's entire cart would
   * evaporate and be confirmed to them under a stranger's order number.
   *
   * Parked, though — never dropped. Those are pickups a worker really walked
   * away with, and they stay inspectable with the reason beside them.
   */
  it("sets the undeliverable queue aside on revocation instead of dropping or replaying it", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    await enqueueOrder(queuedOrder(4), EMPLOYEE.id);
    server.revoked = true;

    render(<App />);

    await settle(() => expect(screen.getByText(PAIRING_TITLE)).toBeDefined());
    await settle(async () => expect(await listQueue()).toEqual([]));
    const parked = await listQuarantine();
    expect(parked.map((order) => order.deviceSeq)).toEqual([3, 4]);
    // No verdict on the ORDER: the server never refused it, the device simply
    // lost the right to offer it — and the whole body survives either way.
    expect(parked[0]!.status).toBe(0);
    expect(parked[0]!.body.items).toEqual([{ rawKm: KM }]);
  });

  // A blink is not a revocation. Every other refresh failure has to go on
  // meaning "offline", or the first flaky access point would unpair the estate.
  it("keeps a paired device paired when the refresh merely fails", async () => {
    await pair();
    server.reachable = false;

    render(<App />);

    await settle(() => expect(screen.getByText(OFFLINE)).toBeDefined());
    expect(screen.getByText(IDLE_TITLE)).toBeDefined();
    expect((await readConfig())?.token).toBe("tok-abc");
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

  /**
   * The day limit across sessions, which is the only place it means anything:
   * within one cart the reducer's own arithmetic covers it, and a limit that
   * resets every time the worker badges out is not a day limit at all.
   *
   * The device answers this from its OWN journal — best effort, never the
   * decision (`POST /kiosk/orders` re-decides it against live data), which is
   * exactly what makes it safe to be incomplete.
   */
  it("counts what this device already handed the worker today against their limit", async () => {
    await pair();
    await appendJournal({
      at: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      kioskId: KIOSK_ID,
      deviceSeq: 3,
      orderNo: "ORD-26-0003",
      conflicts: [],
      employeeId: EMPLOYEE.id,
      acceptedCount: 2,
    });
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 3")).toBeDefined());
  });

  // An order the worker just placed but that has not synced still counts
  // against them: they walked away with the bottle either way, and the server
  // will count it the moment the queue drains.
  it("counts an order that is still sitting in the offline queue", async () => {
    await pair();
    server.reachable = false;
    setOnLine(false);
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await takeOneBottle();
    await settle(() => expect(screen.getByText(QUEUED_TITLE)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    });
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 4")).toBeDefined());
  });

  /**
   * The upgrade path. A device that has been running since before the journal
   * carried an employee holds entries nothing can attribute — they must be
   * skipped, not crash the cart and not be read as an anonymous withdrawal
   * charged to whoever badges in next.
   */
  it("opens the cart on a device whose journal predates the day count", async () => {
    await pair();
    await appendJournal({
      at: NOW.toISOString(),
      deviceSeq: 3,
      orderNo: "ORD-26-0003",
      conflicts: [{ rawKm: KM, reason: "duplicate" }],
    } as unknown as JournalEntry);
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 5")).toBeDefined());
  });

  /**
   * THE OTHER HALF OF THE DAY COUNT, and the failure it closes: a worker who
   * spent their allowance at another gate used to be offered a fresh one here,
   * scan a bottle, be told «Заявка передана», and walk off with it — the server
   * refused the overflow, but on an offline submit nobody was there to hear it.
   *
   * The device cannot know about the other kiosk's orders, so the SERVER
   * reports them, per employee, in the bootstrap roster.
   */
  it("counts what the worker took at another kiosk against their limit here", async () => {
    server.takenTodayElsewhere = 2;
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 3")).toBeDefined());
  });

  /**
   * The two halves ADD. They are split by SOURCE — this kiosk's orders come off
   * this device's own journal, every other kiosk's off the roster — so they
   * cannot overlap, and neither may replace the other. A snapshot figure that
   * OVERWROTE the local count would forget the bottle this device just handed
   * over; a local count that ignored the snapshot is the bug this test exists
   * for.
   */
  it("adds another kiosk's items to this one's rather than replacing them", async () => {
    server.takenTodayElsewhere = 2;
    await pair();
    await appendJournal({
      at: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      kioskId: KIOSK_ID,
      deviceSeq: 3,
      orderNo: "ORD-26-0003",
      conflicts: [],
      employeeId: EMPLOYEE.id,
      acceptedCount: 1,
    });
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    // 2 elsewhere + 1 here = 3 of 5.
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 2")).toBeDefined());
  });

  /**
   * A TABLET THAT HAS BEEN MOVED BETWEEN GATES, which is not exotic: re-pairing
   * is the documented recovery path for a device nobody can sign into.
   *
   * The two halves are split by SOURCE, and the source the DEVICE stands for is
   * one KIOSK — but nothing clears the journal when the tablet is re-paired, so
   * the old gate's orders used to be counted here AND arrive in the server's
   * `takenTodayElsewhere`, which excludes this gate and not the one they were
   * filed at. Double counted until UTC midnight, and over-counting is the unsafe
   * direction: it refuses a worker product they are entitled to, at a machine
   * with nobody standing there to overrule it.
   */
  it("does not charge the worker twice for an order filed at the gate this tablet came from", async () => {
    // The server's figure is "every kiosk except this one", so the old gate's
    // order is already inside it.
    server.takenTodayElsewhere = 1;
    await pair();
    await appendJournal({
      at: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      // Filed before somebody carried the tablet to this gate.
      kioskId: "k-other-gate",
      deviceSeq: 3,
      orderNo: "ORD-26-0003",
      conflicts: [],
      employeeId: EMPLOYEE.id,
      acceptedCount: 1,
    });
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    // One order, counted once — the server's 1, and nothing out of the journal.
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 4")).toBeDefined());
  });

  /**
   * THE UPGRADE PATH, and the reason the count did not simply drop every entry
   * that names no kiosk. A device paired before the binding was recorded holds
   * a config that names none and a journal that names none, and it has not
   * moved — so its history really is this gate's. Refusing to count it would
   * switch the local half of the day limit off across the whole installed base
   * until each tablet happened to be re-paired.
   */
  it("counts an un-stamped journal on a device that has not paired since the upgrade", async () => {
    await pair(NOW.toISOString(), { kioskId: null });
    await appendJournal({
      at: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      deviceSeq: 3,
      orderNo: "ORD-26-0003",
      conflicts: [],
      employeeId: EMPLOYEE.id,
      acceptedCount: 2,
    } as unknown as JournalEntry);
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 3")).toBeDefined());
  });

  /**
   * The upgrade path on the SERVER's side of the wire. Nothing validates a
   * bootstrap at runtime — `KioskBootstrapDto` is a cast over `res.json()`, not
   * a schema — so a device talking to an older API, or one still holding a
   * snapshot it cached before this field existed, gets a roster row without it.
   * That must read as zero: no `NaN` in «осталось», and no crash on the path
   * that opens a worker's cart.
   *
   * Held offline deliberately, which is also how this arises in the field: the
   * device upgraded its bundle, the cabinet did not, and the cached snapshot is
   * the old shape until something replaces it.
   */
  it("opens the cart on a bootstrap that predates the cross-kiosk count", async () => {
    const older = bootstrapAt(NOW.toISOString());
    delete (older.employees[0] as Partial<KioskBootstrapDto["employees"][number]>)
      .takenTodayElsewhere;
    await replaceSnapshot(older, NOW);
    await writeConfig(config());
    server.reachable = false;
    setOnLine(false);
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    scan(BADGE);

    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
    await settle(() => expect(screen.getByText("Лимит 5 шт в день · осталось 5")).toBeDefined());
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
      // The DIGEST of the badge that was scanned, never the badge itself — see
      // the store-scrubbing test below for the property this protects.
      badgeDigest,
      reason: "buy",
      items: [{ rawKm: KM }],
    });
    expect(server.orders[0]).not.toHaveProperty("badgeCode");
    // Acknowledged, so it has left the queue — and the counter moved on, or the
    // next order would collide with this one's idempotency key.
    expect(await listQueue()).toEqual([]);
    expect((await readConfig())?.nextDeviceSeq).toBe(6);
  });

  /**
   * A FAST-FORWARDED TABLET MUST NOT BUY A FRESH DAILY ALLOWANCE.
   *
   * The server files an order under the `createdAt` the device sends, and its
   * authoritative day limit counts that order against that stamp's UTC day. Read
   * off the raw tablet clock, moving the device's date forward — which anyone
   * standing at the kiosk can do from the tablet's own settings — dated the
   * withdrawal into a day the worker had not spent yet, repeatedly, and even
   * while online.
   *
   * The stamp now comes from the offset the last bootstrap established
   * (`serverNow`): `generatedAt` is the server's own reading of the instant the
   * device received it at `fetchedAt`, so the difference is this tablet's skew
   * and subtracting it puts the order back on the server's calendar.
   */
  it("dates an order by the server's clock, not by a tablet whose date was moved forward", async () => {
    const SKEW_MS = 3 * 24 * 60 * 60_000;
    // Same instant, two clocks: the server calls it the 25th, this tablet calls
    // it the 28th. Everything else about the kiosk is healthy.
    server.generatedAt = new Date(NOW.getTime() - SKEW_MS).toISOString();
    await replaceSnapshot(bootstrapAt(server.generatedAt), NOW);
    await writeConfig(config());
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());

    await takeOneBottle();

    await settle(() => expect(said()).toContain("ORD-"));
    const createdAt = server.orders[0]!.createdAt!;
    expect(createdAt.slice(0, 10)).toBe("2026-07-25");
    // Explicitly NOT the device's own day, which is the whole exploit.
    expect(createdAt.slice(0, 10)).not.toBe(NOW.toISOString().slice(0, 10));
    // And it is a correction, not a fixed stamp: within a few seconds of the
    // server's own reading of "now", the settle loop's clock creep included.
    expect(Math.abs(Date.parse(createdAt) - (NOW.getTime() - SKEW_MS))).toBeLessThan(10_000);
  });

  /**
   * THE SAME SKEW, IN THE OTHER DIRECTION IT USED TO BREAK.
   *
   * Staleness was a subtraction of two absolute clocks, so a tablet more than
   * `STALE_BLOCK_MS` fast read a bootstrap generated seconds ago as more than a
   * week old. Every successful refresh then left a perfectly healthy kiosk on
   * the Blocked screen, telling a worker its data was stale and an
   * administrator to check a network that was working — with nothing on screen
   * to suggest a clock.
   *
   * Measured through the offset, the age is elapsed time since the refresh —
   * two readings of the SAME clock — so the skew cancels and the kiosk works.
   */
  it("keeps working when the tablet's clock is a fortnight fast but the kiosk is syncing", async () => {
    server.generatedAt = new Date(NOW.getTime() - 2 * STALE_BLOCK_MS).toISOString();
    await replaceSnapshot(bootstrapAt(server.generatedAt), NOW);
    await writeConfig(config());

    render(<App />);

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    expect(screen.queryByText("Киоск временно не выдаёт продукцию")).toBeNull();
    // And it really is handing product out, not merely showing the idle screen.
    scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
  });

  /**
   * THE 24-HOUR PLAQUE, which design 2026-07-24 §7 asks for in as many words:
   * «>24 ч — ненавязчивая плашка "Данные обновлялись N назад", отбор разрешён».
   *
   * The threshold was enforced and the plaque was not: the strip said «больше
   * суток назад», which is the same sentence on the second day as on the sixth
   * — and the sixth is the one where a kiosk is about to stop entirely.
   */
  it("names how old its dataset is past a day, and goes on handing product out", async () => {
    // Out of contact for thirty hours, and still out of contact — a reachable
    // server would simply refresh the snapshot out from under the assertion.
    await pair(new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString());
    server.reachable = false;

    render(<App />);

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    expect(screen.getByText("Данные обновлялись 30 ч назад")).toBeDefined();

    // «отбор разрешён»: the plaque is a remark, not a gate.
    scan(BADGE);
    await settle(() => expect(screen.getByText(CART_TITLE)).toBeDefined());
  });

  /**
   * THE STRIP MUST NOT ASSERT A LINK THAT IS NOT THERE, and this is the way it
   * used to — found in a live smoke run rather than by reasoning.
   *
   * Stop the API while the Wi-Fi stays up: `navigator.onLine` is still true, no
   * `offline` event fires, and the refresh tick is up to five minutes away. So
   * for those five minutes the kiosk queued orders offline while the strip went
   * on saying «Связь с сервером есть». The `Done` screen told the truth, so
   * nothing was lost — but the strip is the one thing a passing administrator
   * reads, and it was the one thing lying.
   */
  it("stops claiming a connection the moment a delivery fails, long before the refresh tick", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    // The boot sync reached the server, so this is true when it is said.
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();

    // And now the API stops, with nothing on the device told about it.
    server.reachable = false;

    await takeOneBottle();

    await settle(() => expect(screen.getByText(QUEUED_TITLE)).toBeDefined());
    expect(screen.getByText(OFFLINE)).toBeDefined();
    expect(screen.queryByText("Связь с сервером есть")).toBeNull();
  });

  /**
   * And the other direction, which is what stops the fix becoming a strip stuck
   * on «нет связи»: a delivery that lands is proof of a link, whatever
   * `navigator.onLine` believes.
   *
   * Driven by the BACKOFF rather than by an `online` event or the refresh tick,
   * because that is the path a recovering kiosk actually takes — the browser
   * fires nothing at all when it was the API that went away and came back.
   */
  it("says the link is back as soon as a delivery lands, with nothing else telling it", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    server.reachable = false;
    setOnLine(false);
    render(<App />);
    await settle(() => expect(screen.getByText(OFFLINE)).toBeDefined());

    // The API comes back. `navigator.onLine` stays false, so not even the
    // browser's own event fires, and the refresh tick is minutes away.
    server.reachable = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    });

    await settle(() => expect(screen.getByText("Связь с сервером есть")).toBeDefined());
    expect(server.orders.map((order) => order.deviceSeq)).toEqual([3]);
    expect(await listQueue()).toEqual([]);
  });

  /**
   * THE SAME LIE, TOLD BY A PROXY — and the one the rule above could not catch.
   *
   * Stopping the API in a live smoke run did not produce a dead `fetch` at all.
   * The Vite dev proxy ANSWERED, `502 Bad Gateway`, and Caddy does the same in
   * front of a production deployment (roadmap plan 08). So the device had a
   * `KioskApiError` in its hands, read it as "the server answered", and went on
   * showing «Связь с сервером есть» while every order queued underneath it.
   *
   * A gateway status is the one kind of answer that says the APPLICATION was
   * never reached, which is exactly what the strip is reporting on. `fetch`
   * RESOLVES here — that is the whole gap, and no test above had it.
   */
  it("stops claiming a connection when a gateway answers for an API it cannot reach", async () => {
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    // The boot sync went all the way through to the application, so this is true.
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();

    // And now the API stops behind a proxy that is perfectly healthy: the link
    // is up, the request is answered, and nothing on the device is told.
    server.gateway = 502;

    await takeOneBottle();

    await settle(() => expect(screen.getByText(QUEUED_TITLE)).toBeDefined());
    expect(screen.getByText(OFFLINE)).toBeDefined();
    expect(screen.queryByText("Связь с сервером есть")).toBeNull();
  });

  /**
   * And the queue behind that gateway must not wait out the refresh tick.
   *
   * The backoff is what delivers a worker's order promptly once the API is
   * back, and it used to arm only for a failure carrying no status at all — so
   * behind a proxy it never armed, and every queued order sat for up to five
   * minutes after the outage had ended.
   *
   * The clock is advanced by less than a refresh interval on purpose: the ONLY
   * thing that can deliver this order inside that window is the backoff.
   */
  it("arms the backoff behind a gateway, and delivers as soon as the API is back", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    server.gateway = 503;
    // No browser event will help: the Wi-Fi never moved, so `online` never
    // fires — the commonest shape of this outage and the reason it is silent.
    setOnLine(false);
    render(<App />);
    await settle(() => expect(screen.getByText(OFFLINE)).toBeDefined());

    // The API comes back up behind the same proxy.
    server.gateway = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    });

    expect(RETRY_MAX_MS).toBeLessThan(REFRESH_INTERVAL_MS);
    await settle(() => expect(screen.getByText("Связь с сервером есть")).toBeDefined());
    expect(server.orders.map((order) => order.deviceSeq)).toEqual([3]);
    expect(await listQueue()).toEqual([]);
  });

  /**
   * THE RETRY MUST NOT OUTLIVE THE SHELL. It holds the client this tree built —
   * the one that records the reply for the order `submitCart` is awaiting — so
   * one left armed past an unmount fires into a React tree that is gone, and on
   * a device that has been re-paired in between would post under a token the
   * shell no longer has.
   */
  it("leaves no retry armed once the shell unmounts", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    server.reachable = false;
    const { unmount } = render(<App />);
    await settle(() => expect(screen.getByText(OFFLINE)).toBeDefined());
    const posted = () =>
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        ([input]) => String(input).endsWith("/kiosk/orders"),
      ).length;
    // A retry really is owed at this point, or this test proves nothing.
    expect(posted()).toBeGreaterThan(0);
    const before = posted();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * REFRESH_INTERVAL_MS);
    });

    expect(posted()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
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

  /**
   * THE QUEUE MUST NOT BE A CREDENTIAL STORE.
   *
   * This is the whole point of `badgeDigest`. An order is written to IndexedDB
   * before any network attempt — that is what makes a pickup survive a battery
   * pull — so during an outage the device holds one record per worker who
   * submitted, and it holds them until the queue drains. A permanently refused
   * order goes to the quarantine store instead, which nothing prunes at all.
   *
   * A badge CODE in there is the one credential on this tablet that also works
   * away from it: the same value opens a pickup at any kiosk, signs an operator
   * in at the line station, and is printed on a card. So the assertion is
   * deliberately about the whole serialised record rather than about one field
   * — a future field carrying the code anywhere in it fails this too.
   */
  it("keeps the scanned badge code out of the queue an outage fills up", async () => {
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

    const queued = await listQueue();
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued)).not.toContain(BADGE);
    // And what IS there is the digest, so the order is still resolvable —
    // scrubbing the code by simply dropping it would pass the line above and
    // strand every queued pickup.
    expect(queued[0]!.body.badgeDigest).toBe(badgeDigest);
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

  /**
   * BACKLOG RECOVERY, which is the one moment this can go wrong — and exactly
   * the moment the kiosk is busiest.
   *
   * The link comes back, the `online` handler starts draining an outage's
   * worth of orders, and workers start submitting again into that same window.
   * `submitCart` awaits its own drain to learn whether THIS order reached the
   * server; a drain that answered "somebody else is already draining" would
   * make it tell an online worker their order is queued with no number, and
   * send them to an administrator with nothing to look the order up by.
   */
  it("shows the real order number for a submit that lands while a backlog drain is running", async () => {
    await pair();
    // What an outage left behind, and what the boot drain picks up first.
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    let deliver = () => {};
    const held = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    let backlogPosted = false;
    const respond = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/kiosk/orders")) {
        const body = JSON.parse(String(init?.body)) as CreateOrderDto;
        // Only the backlog order is held, so the drain the worker's submit
        // lands beside is provably still in flight — and their own order is
        // not slowed down by this fixture at all.
        if (body.deviceSeq === 3) {
          backlogPosted = true;
          await held;
        }
      }
      return respond(input, init);
    }) as unknown as typeof fetch;

    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await settle(() => expect(backlogPosted).toBe(true));

    await takeOneBottle();
    deliver();

    await settle(() => expect(screen.getByText("Заявка № ORD-26-0005 передана")).toBeDefined());
    expect(said()).not.toContain(QUEUED_TITLE);
    expect(server.orders.map((order) => order.deviceSeq)).toEqual([3, 5]);
    expect(await listQueue()).toEqual([]);
  });

  it("drains the queue when the device comes back online", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
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

  /**
   * THE RADIO MUST DESCRIBE THE DEVICE, NOT THE STORE.
   *
   * Only the transport MODE is persisted — a `SerialPort` cannot be — so a
   * stored "serial" is honoured by the shell only while the browser still holds
   * the port grant behind it (`recoverGrantedPort`), and the kiosk falls back
   * to the keyboard wedge when it does not. Seeded from the store, the settings
   * screen then checks «Web Serial» over a kiosk running the wedge, and the
   * test scan below it certifies the wedge under that label: the installer runs
   * a successful scan through the wrong device, presses «Готово», and leaves
   * with a saved configuration that misdescribes the kiosk.
   *
   * So the shell says what it is actually running, and that wins over the
   * store.
   */
  it("shows the keyboard transport on a kiosk whose stored serial grant did not survive", async () => {
    const scanner = fakeSerialPort();
    setWebSerialWithoutGrant(scanner.port);
    await writeScannerSettings({ transport: "serial" });
    await pair();
    render(<App />);
    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    // The shell really did fall back: no serial transport was ever started, so
    // the wedge is the device's only scanner.
    expect(transports.starts).toEqual(["keyboard"]);

    await holdIdleHeader(SETTINGS_HOLD_MS);
    await settle(() => expect(screen.getByText(GATE_TITLE)).toBeDefined());
    await signInWithPin();
    await settle(() => expect(screen.getByText(SETUP_TITLE)).toBeDefined());
    // A full store round trip, so the stored mode has had every chance to land
    // on this screen. It must not be consulted at all — the shell has already
    // read it AND checked the grant behind it.
    await settle(async () => expect(await readScannerSettings()).toEqual({ transport: "serial" }));

    expect(transportRadio(KEYBOARD_TRANSPORT).checked).toBe(true);
    expect(transportRadio(SERIAL_TRANSPORT).checked).toBe(false);

    // And the label is honest end to end: the wedge is what answers the test
    // scan, which is the transport the screen is now naming.
    scan(BADGE);
    await settle(() => expect(verdict()).toBe(VERDICT_BADGE));
  });

  /**
   * A QUARANTINED ORDER HAS TO BE VISIBLE SOMEWHERE, and this strip is the only
   * candidate.
   *
   * A terminal per-order rejection (400/409/422) moves the order into the
   * quarantine store so the drain can continue past it. That is right — one
   * poisoned record must not hold a day's pickups — but it also removes the
   * order from every other indication the device has: it has left the queue, so
   * `Blocked`'s count no longer covers it; it will never be retried, so no
   * later drain will mention it; and the worker it belonged to walked away
   * days ago. Without a word here the kiosk sits indefinitely holding a pickup
   * nobody will ever look at.
   */
  it("says on the strip when the server has refused an order for good", async () => {
    await pair();
    await enqueueOrder(queuedOrder(3), EMPLOYEE.id);
    const respond = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // A verdict on the ORDER, not on the device: the body is one the server
      // will never take, however often it is offered.
      if (String(input).endsWith("/kiosk/orders"))
        return errorResponse(422, "Unprocessable Entity");
      return respond(input, init);
    }) as unknown as typeof fetch;

    render(<App />);

    await settle(() => expect(screen.getByText(IDLE_TITLE)).toBeDefined());
    await settle(async () => expect(await listQuarantine()).toHaveLength(1));
    await settle(() => expect(said()).toContain("Сервер отклонил заявки: 1"));
    // Whose problem it is. Nothing the worker standing here can do clears it.
    expect(said()).toContain("нужен администратор");
    // And it is stated on a kiosk that is otherwise working — which is exactly
    // why nothing else on this screen would ever mention the parked order.
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();
    expect(await listQueue()).toEqual([]);
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
