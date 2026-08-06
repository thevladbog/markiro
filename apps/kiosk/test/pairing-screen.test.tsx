import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { KioskBootstrapDto, PairKioskResultDto } from "../src/api/types.js";
import type { ScanListener } from "../src/scanner/source.js";
import type * as CacheModule from "../src/store/cache.js";
import type * as ConfigModule from "../src/store/config.js";
import { readSnapshot } from "../src/store/cache.js";
import { readConfig, type KioskConfig } from "../src/store/config.js";
import { Pairing } from "../src/screens/Pairing.js";

/**
 * The screen imports its two writes directly, so the module boundary is the
 * only seam a test has on them. Each wrapper records the call and then performs
 * the real write, unless a test makes it reject first — which is how the
 * store-shaped failure (an IndexedDB quota or transaction error) is reproduced,
 * as opposed to the payload-shaped one a bad `generatedAt` produces.
 */
const writes = vi.hoisted(() => ({
  replaceSnapshot: vi.fn<(bootstrap: unknown, fetchedAt: Date) => Promise<void> | void>(),
  writeConfig: vi.fn<(cfg: unknown) => Promise<void> | void>(),
}));

vi.mock("../src/store/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CacheModule>();
  return {
    ...actual,
    replaceSnapshot: async (bootstrap: KioskBootstrapDto, fetchedAt: Date) => {
      await writes.replaceSnapshot(bootstrap, fetchedAt);
      await actual.replaceSnapshot(bootstrap, fetchedAt);
    },
  };
});

vi.mock("../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    writeConfig: async (cfg: KioskConfig) => {
      await writes.writeConfig(cfg);
      await actual.writeConfig(cfg);
    },
  };
});

const SERVER = "https://srv.example";

function bundle(generatedAt = "2026-07-28T07:00:00.000Z"): PairKioskResultDto {
  return {
    device: { kioskId: "k-1", kioskName: "Склад №1", place: "Проходная" },
    token: "tok-abc",
    nextDeviceSeq: 7,
    bootstrap: {
      generatedAt,
      config: { dayLimitPerEmployee: 5, showPrices: true },
      badgeSalt: "c2FsdA==",
      reasons: [{ id: "r1", name: "Брак" }],
      products: [],
      employees: [
        { id: "e1", fullName: "Иванов И.", role: null, badgeHash: null, takenTodayElsewhere: 0 },
      ],
      operators: [],
    },
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: "Unauthorized",
    json: () => Promise.resolve({ message }),
  } as unknown as Response;
}

/**
 * The shell's fan-out (`KioskShell`'s listener `Set`) over whatever transport
 * the kiosk is running — this screen's only seam onto a scanner.
 *
 * Not a `ScanSource` it starts for itself, and the distinction is the reason
 * this screen works at all on the transport the commissioning order actually
 * produces. Design brief 07 §5 puts scanner setup BEFORE pairing precisely so
 * the pairing barcode can be scanned, so an installer following it arrives here
 * on Web Serial — where `createWebSerialSource` is single-subscriber and the
 * shell has held the port's reader since boot. A source started here would read
 * nothing whatsoever.
 *
 * `joins`/`leaves` count subscriptions rather than transport starts, because
 * that is now what this screen does to a scanner: it takes a place in the set
 * and gives it back. Pausing means LEAVING the set — the device's scanner keeps
 * running, as it must, since no screen may stop the transport under the others.
 */
function fakeFanOut(): {
  subscribe: (listener: ScanListener) => () => void;
  emit: (raw: string) => void;
  joins: () => number;
  leaves: () => number;
  listeners: () => number;
} {
  const set = new Set<ScanListener>();
  let joins = 0;
  let leaves = 0;
  return {
    subscribe(listener) {
      set.add(listener);
      joins += 1;
      return () => {
        leaves += 1;
        set.delete(listener);
      };
    },
    emit(raw) {
      act(() => set.forEach((listener) => listener(raw)));
    },
    joins: () => joins,
    leaves: () => leaves,
    listeners: () => set.size,
  };
}

function typeDigits(digits: string): void {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

/** The confirmation §5.2 asks for, for the bundle above. */
const BOUND = "Kiosk bound to “Проходная”";
/** How long that confirmation stands before the shell is told to move on. */
const HANDOFF_MS = 4_000;

/**
 * Pairing now ENDS in a confirmation the installer reads, so reaching the
 * working mode is one step further than it used to be. Every test below whose
 * subject is what got WRITTEN takes that step here and carries on.
 */
async function handOver(): Promise<void> {
  await waitFor(() => expect(screen.getByText(BOUND)).toBeDefined());
  fireEvent.click(startWorking());
}

const submitButton = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
const startWorking = () =>
  screen.getByRole("button", { name: "Start working" }) as HTMLButtonElement;
const scanButton = () => screen.getByRole("button", { name: "Scan code" }) as HTMLButtonElement;
const scannerSetupButton = () =>
  screen.getByRole("button", { name: "Set up the scanner" }) as HTMLButtonElement;
const serverToggle = () => screen.getByRole("button", { name: "Change the server address" });
/** The live region showing what has been entered so far. `role="status"` and
 * not an `aria-label` test hook: it is announced, so it is real. */
const codeDisplay = () => screen.getByRole("status");

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.restoreAllMocks();
  // `mockReset` and not `mockClear`: a test that installed a one-shot rejection
  // must not leak it into the next one.
  writes.replaceSnapshot.mockReset();
  writes.writeConfig.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Typed with `fetch`'s own parameters so a test can assert what was POSTed and
// where — the server-address field is only real if the URL actually changes.
function stubFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const mock = vi.fn(impl);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("Pairing", () => {
  it("renders only the screen's localized clear action beside the digit-only keypad", () => {
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Backspace" })).toBeNull();
  });

  it("enables the submit only once all eight digits are entered", () => {
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(submitButton().disabled).toBe(true);
    typeDigits("1234567");
    expect(submitButton().disabled).toBe(true);
    typeDigits("8");
    expect(submitButton().disabled).toBe(false);
  });

  it("persists the token, the counter and the bundle's own snapshot in a single round trip", async () => {
    const result = bundle();
    const fetchMock = stubFetch(() => Promise.resolve(okResponse(result)));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await handOver();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(await readConfig()).toEqual({
      serverUrl: SERVER,
      token: "tok-abc",
      // WHICH KIOSK THE DEVICE JUST BECAME, and the only moment it can be
      // learned. The day count needs it to tell the orders this gate filed from
      // the ones the server reports for every other gate, and a tablet moved
      // between gates has nothing else to distinguish them by.
      kioskId: "k-1",
      kioskName: "Склад №1",
      place: "Проходная",
      nextDeviceSeq: 7,
    });
    // The pair response embeds the bootstrap precisely so the device is usable
    // immediately -- a second round trip here would strand a kiosk paired at a
    // gate whose network dropped one second after the code was accepted.
    expect((await readSnapshot())?.bootstrap).toEqual(result.bootstrap);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The ORDER is the load-bearing part, so it is pinned here: the snapshot
    // goes in first and the token last, because the token is what marks the
    // device paired. Writing it first would make a failure of the second write
    // permanent (see the next test).
    expect(writes.replaceSnapshot.mock.invocationCallOrder[0]!).toBeLessThan(
      writes.writeConfig.mock.invocationCallOrder[0]!,
    );
  });

  /**
   * The upgrade path on the SERVER's side of the wire, for the binding. The
   * response is a cast over `res.json()` and nothing validates it at runtime,
   * so an API too old to name the kiosk must leave the device UNIDENTIFIED
   * rather than bound to `undefined` — the day count compares this value for
   * equality, and a third kind of unknown would match nothing.
   */
  it("pairs against a server that does not name the kiosk, and stays unidentified", async () => {
    const result = bundle();
    delete (result.device as Partial<PairKioskResultDto["device"]>).kioskId;
    stubFetch(() => Promise.resolve(okResponse(result)));
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await handOver();
    expect((await readConfig())?.token).toBe("tok-abc");
    expect((await readConfig())?.kioskId).toBeNull();
  });

  it("leaves the device unpaired and recoverable when the snapshot write itself fails", async () => {
    // The store-shaped failure, not the payload-shaped one: `withStore` rejects
    // on an IndexedDB quota or transaction error. With the snapshot written
    // first, no token exists yet — so the device is still on this screen and a
    // fresh code can pair it. With the writes the other way round it would hold
    // a token and no dataset, read as `paired`, and never show this screen
    // again while the code it burned is already spent server-side.
    const result = bundle();
    stubFetch(() => Promise.resolve(okResponse(result)));
    writes.replaceSnapshot.mockRejectedValueOnce(new Error("QuotaExceededError"));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(await readConfig()).toBeNull();
    expect(await readSnapshot()).toBeNull();
    expect(writes.writeConfig).not.toHaveBeenCalled();
    expect(onPaired).not.toHaveBeenCalled();
    // ...and the proof that it is recoverable: the screen the installer needs
    // is still the one in front of them, with its keypad live.
    expect(submitButton()).toBeDefined();
  });

  /**
   * The failure the ORDER of the writes cannot fix, and must therefore be told
   * truthfully instead.
   *
   * `pairKiosk` came back 200, which means `attemptRedeem` has already stamped
   * `usedAt` and rotated the device token: the entered code is spent from that
   * line onwards, whatever the device manages to store afterwards. So a store
   * failure here is NOT the network blink it resembles — a Retry offered on it
   * can only ever be answered 401, and every press walks the installer further
   * from the one thing that works, which is a new code.
   *
   * Both writes are exercised, because both live on the spent side of the
   * redemption and the classification must not depend on which one broke.
   */
  it.each([
    ["snapshot", writes.replaceSnapshot],
    ["config", writes.writeConfig],
  ] as const)(
    "asks for a NEW code when the %s write fails after the code was already redeemed",
    async (_which, write) => {
      stubFetch(() => Promise.resolve(okResponse(bundle())));
      write.mockRejectedValueOnce(new Error("QuotaExceededError"));
      const onPaired = vi.fn();
      render(
        <Pairing
          defaultServerUrl={SERVER}
          subscribe={fakeFanOut().subscribe}
          onPaired={onPaired}
          onConfigureScanner={vi.fn()}
        />,
      );

      typeDigits("12345678");
      fireEvent.click(submitButton());

      await waitFor(() =>
        expect(
          screen.getByText(
            "The code has already been used, but the kiosk could not save the data. Ask the administrator for a new code.",
          ),
        ).toBeDefined(),
      );
      // The whole point: no button that can only fail.
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      // Unpaired either way — the token is the last write, so it never landed.
      expect(await readConfig()).toBeNull();
      expect(onPaired).not.toHaveBeenCalled();
    },
  );

  it("shows the invalid-code message on a 401 and issues no write at all", async () => {
    stubFetch(() => Promise.resolve(errorResponse(401, "invalid code")));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    // The copy names the lockout too, and deliberately does not promise which
    // of the three it was: the server answers a rate-limit lockout with the
    // same bare 401 as a wrong guess (`assertUnderPairRateLimit`,
    // `apps/api/src/modules/kiosk/pairing.service.ts:401`), so a message
    // saying only "wrong or expired" would send a locked-out technician back
    // to a keypad that cannot let them in no matter what they type.
    await waitFor(() =>
      expect(
        screen.getByText(
          "The code is wrong, expired, or there have been too many attempts. Get a new code from the admin panel.",
        ),
      ).toBeDefined(),
    );
    // Asserted at the writes, not only at the reads: an empty store proves
    // nothing was *kept*, these prove nothing was *attempted* — which is what
    // stays true if a delete path is ever added.
    expect(writes.writeConfig).not.toHaveBeenCalled();
    expect(writes.replaceSnapshot).not.toHaveBeenCalled();
    expect(await readConfig()).toBeNull();
    expect(await readSnapshot()).toBeNull();
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("distinguishes a dead network from a wrong code, and offers a retry", async () => {
    // A worker who mistyped a code and a worker whose Wi-Fi died need different
    // instructions, so the two failures must not collapse into one message.
    stubFetch(() => Promise.resolve(errorResponse(401, "invalid code")));
    const first = render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );
    typeDigits("12345678");
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    const wrongCodeText = screen.getByRole("alert").textContent;
    first.unmount();

    stubFetch(() => Promise.reject(new Error("Failed to fetch")));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );
    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(
        screen.getByText("No connection to the server. Check the network and try again."),
      ).toBeDefined(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).not.toBe(wrongCodeText);
    expect(onPaired).not.toHaveBeenCalled();
    expect(await readConfig()).toBeNull();
  });

  it("retries with the same code when Retry is pressed, and pairs on the second attempt", async () => {
    // The retry button existed but nothing ever pressed it: the whole point of
    // keeping the code after a connection failure is that one press finishes
    // the pair, with no retyping and no second trip to the administrator.
    const result = bundle();
    let attempt = 0;
    const fetchMock = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("Failed to fetch"))
        : Promise.resolve(okResponse(result));
    });
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await handOver();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ code: "12345678" });
    expect((await readConfig())?.token).toBe("tok-abc");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the code after a 401 but keeps it after a connection failure", async () => {
    // The two lifecycles are the reason the retry works at all: a rejected code
    // must be retyped, a code the server never judged must survive untouched.
    stubFetch(() => Promise.resolve(errorResponse(401, "invalid code")));
    const rejected = render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );
    typeDigits("12345678");
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(
        screen.getByText(
          "The code is wrong, expired, or there have been too many attempts. Get a new code from the admin panel.",
        ),
      ).toBeDefined(),
    );
    expect(codeDisplay().textContent).toBe("");
    expect(submitButton().disabled).toBe(true);
    rejected.unmount();

    stubFetch(() => Promise.reject(new Error("Failed to fetch")));
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );
    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());
    expect(codeDisplay().textContent).toBe("12345678");
    expect(submitButton().disabled).toBe(false);
  });

  it("pairs against the address edited in the server field — the whole on-prem story", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse(bundle())));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    // Collapsed by default: a SaaS build bakes the origin in, and the field
    // would only be one more thing between a worker and a paired kiosk.
    expect(screen.queryByLabelText("Server address")).toBeNull();
    fireEvent.click(serverToggle());
    fireEvent.change(screen.getByLabelText("Server address"), {
      target: { value: "http://kiosk.local:3000/" },
    });
    typeDigits("12345678");
    fireEvent.click(submitButton());

    await handOver();
    expect(onPaired).toHaveBeenCalledTimes(1);
    // The edited address is the one actually POSTed, and the one stored — a
    // default that quietly won here would make the field decorative.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://kiosk.local:3000/kiosk/pair");
    expect((await readConfig())?.serverUrl).toBe("http://kiosk.local:3000/");
  });

  it("keeps scanner setup reachable before pairing — the scanner is often what reads the code", () => {
    const onConfigureScanner = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={onConfigureScanner}
      />,
    );

    fireEvent.click(scannerSetupButton());
    expect(onConfigureScanner).toHaveBeenCalledTimes(1);
  });

  it("disables scanner setup while a pair is in flight, so a pair cannot land behind that screen", async () => {
    let release!: (res: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const onPaired = vi.fn();
    const onConfigureScanner = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={onConfigureScanner}
      />,
    );

    typeDigits("12345678");
    expect(scannerSetupButton().disabled).toBe(false);
    fireEvent.click(submitButton());

    await waitFor(() => expect(scannerSetupButton().disabled).toBe(true));
    fireEvent.click(scannerSetupButton());
    expect(onConfigureScanner).not.toHaveBeenCalled();

    release(okResponse(bundle()));
    await handOver();
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it("listens from mount, so a scan arriving before anything is pressed is not dropped", () => {
    // The admin panel's pairing modal renders the code as a barcode and tells
    // the worker to scan it; at an unattended kiosk the instinct is to scan
    // first and read the screen second. A listener armed by a button press
    // would silently drop exactly that scan.
    const scanner = fakeFanOut();
    const view = render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(scanner.joins()).toBe(1);
    scanner.emit(" 12345678 ");

    expect(codeDisplay().textContent).toBe("12345678");
    expect(submitButton().disabled).toBe(false);
    // Joined once and left once: a subscription left standing after this screen
    // goes away would go on setting a pairing code behind the idle screen that
    // replaced it, out of the very same scans that screen is reading.
    view.unmount();
    expect(scanner.joins()).toBe(1);
    expect(scanner.leaves()).toBe(1);
    expect(scanner.listeners()).toBe(0);
  });

  it("offers the large scan button, and pressing it announces that a scan is awaited", () => {
    // The button is not the only way in (the listener is always armed), but it
    // is the affordance the brief mandates beside the keypad: this screen is
    // read at arm's length in floor mode, where a small hint line does not
    // carry "you can scan this" at all. Pressing it commits the screen to a
    // visible waiting state instead of doing nothing.
    const scanner = fakeFanOut();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(scanButton().disabled).toBe(false);
    expect(screen.queryByText("Waiting for the scan")).toBeNull();

    fireEvent.click(scanButton());
    expect(screen.getByText("Waiting for the scan")).toBeDefined();
    expect(scanButton().getAttribute("aria-pressed")).toBe("true");

    // Choosing the keypad after all ends the state — the screen must not go on
    // claiming it is waiting for a scan while the worker types the digits.
    typeDigits("1");
    expect(screen.queryByText("Waiting for the scan")).toBeNull();

    fireEvent.click(scanButton());
    scanner.emit(" 12345678 ");
    expect(codeDisplay().textContent).toBe("12345678");
    // ...and it ends when what it waited for arrives.
    expect(screen.queryByText("Waiting for the scan")).toBeNull();
  });

  it("takes a scan although the scan button was never pressed — the button only announces", () => {
    // The property that matters: restoring the button must not turn it back
    // into the arming switch it used to be. A worker who walks up and scans,
    // pressing nothing, still pairs.
    const scanner = fakeFanOut();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(scanButton()).toBeDefined();
    scanner.emit(" 12345678 ");

    expect(codeDisplay().textContent).toBe("12345678");
    expect(submitButton().disabled).toBe(false);
  });

  it("names what is being downloaded while the pair is in flight", async () => {
    // A bare disabled button says nothing about a redeem that also pulls the
    // whole dataset down; on a slow gate link that wait is long enough for a
    // worker to conclude the device is dead and start pressing things.
    let release!: (res: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(
        screen.getByText("Binding the device… downloading settings and operators"),
      ).toBeDefined(),
    );

    release(okResponse(bundle()));
    await handOver();
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Binding the device… downloading settings and operators")).toBeNull();
  });

  it("refuses a scan that is not exactly eight digits, says so, and keeps listening", () => {
    const scanner = fakeFanOut();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    scanner.emit("123");
    expect(screen.getByText("Not a pairing code: eight digits are required")).toBeDefined();
    expect(codeDisplay().textContent).toBe("");

    // A marking code scanned by mistake is REFUSED, not truncated to its first
    // eight digits and offered for submission as if the worker had meant it.
    scanner.emit("0104600682000013");
    expect(codeDisplay().textContent).toBe("");
    expect(submitButton().disabled).toBe(true);

    // Still listening: the real code lands without anything being pressed.
    scanner.emit(" 12345678 ");
    expect(codeDisplay().textContent).toBe("12345678");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it("pauses the scan listener while the server field is open — the wedge would eat what is typed", () => {
    const scanner = fakeFanOut();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    fireEvent.click(serverToggle());
    scanner.emit("12345678");
    expect(codeDisplay().textContent).toBe("");
    // Paused by LEAVING the fan-out, and by nothing more. The device's scanner
    // is not this screen's to stop — the shell owns the transport, and a screen
    // that switched it off to protect its own text field would take the scanner
    // away from whatever stands here next.
    expect(scanner.listeners()).toBe(0);

    fireEvent.click(serverToggle());
    scanner.emit("12345678");
    expect(codeDisplay().textContent).toBe("12345678");
    expect(scanner.joins()).toBe(2);
    expect(scanner.listeners()).toBe(1);
  });

  it("refuses a bundle whose generatedAt is unparseable, and does not half-pair the device", async () => {
    // Same hole as `refreshSnapshot`'s, through a different door: `cacheAge`
    // cannot measure such a stamp, so persisting it would disable the seven-day
    // lockout forever.
    stubFetch(() => Promise.resolve(okResponse(bundle("not-a-date"))));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(writes.replaceSnapshot).not.toHaveBeenCalled();
    expect(writes.writeConfig).not.toHaveBeenCalled();
    expect(await readConfig()).toBeNull();
    expect(await readSnapshot()).toBeNull();
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("asks for a NEW code when the bundle is unusable, instead of a retry that can only 401", async () => {
    // Redeeming the code SPENT it server-side, so this is not a network blink:
    // no amount of retrying with this code can now succeed. Dressing it as one
    // ("No connection…" plus a Retry button) sends the worker into a loop that
    // has no exit; the only way forward is a new code from the administrator.
    stubFetch(() => Promise.resolve(okResponse(bundle("not-a-date"))));
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(
        screen.getByText("The server sent unusable data. Ask the administrator for a new code."),
      ).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  /**
   * WHAT THE INSTALLER READS BEFORE THE KIOSK STARTS WORKING — design
   * 2026-07-24 §5.2: «Успех → „Киоск привязан к точке X“ → рабочий режим».
   *
   * The pair used to jump straight to the idle screen, and `kioskName`/`place`
   * were written to `KioskConfig` and then read by nothing at all. So the one
   * mistake commissioning actually produces — a tablet bound to the wrong
   * kiosk row, or to the right one at the wrong point — was invisible on the
   * device until somebody reconciled orders days later.
   */
  it("names the kiosk and its point before it hands over to the working mode", async () => {
    stubFetch(() => Promise.resolve(okResponse(bundle())));
    const scanner = fakeFanOut();
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={scanner.subscribe}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByText(BOUND)).toBeDefined());
    expect(screen.getByText("This is “Склад №1”")).toBeDefined();
    // The handover waits: telling the shell now would replace the confirmation
    // with the idle screen before anybody could read it.
    expect(onPaired).not.toHaveBeenCalled();
    // The form it replaced is gone — there is nothing left to pair a second
    // time, and no keypad standing under a device that is already bound.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    // ...and the scanner is let go with it: a code arriving now has no field to
    // land in, and the screen this one is about to hand over to wants it.
    expect(scanner.listeners()).toBe(0);

    fireEvent.click(startWorking());
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it("still reads correctly for a kiosk the panel gave no point", async () => {
    // `place` is nullable — the server maps it from `kiosks.location`, which an
    // administrator need never fill in. «привязан к точке „“» would read as a
    // broken screen at exactly the moment the installer is checking the binding.
    const result = bundle();
    result.device.place = null;
    stubFetch(() => Promise.resolve(okResponse(result)));
    render(
      <Pairing
        defaultServerUrl={SERVER}
        subscribe={fakeFanOut().subscribe}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByText("Kiosk bound — no point is set")).toBeDefined());
    // The kiosk is still named, which is the half of the check that always works.
    expect(screen.getByText("This is “Склад №1”")).toBeDefined();
    const said = document.body.textContent ?? "";
    expect(said).not.toContain("null");
    expect(said).not.toContain("“”");
  });

  /**
   * And it hands over on its own, because an installer who has read the
   * confirmation walks away from the tablet. A kiosk left on a success screen
   * until somebody presses a button is a kiosk that never opens for business.
   */
  it("hands over by itself after the confirmation has been up briefly, and only once", async () => {
    // Only the timer functions: `fake-indexeddb` schedules every transaction
    // step through `setImmediate`, so faking that would freeze both writes this
    // screen makes and nothing would ever pair.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      stubFetch(() => Promise.resolve(okResponse(bundle())));
      const onPaired = vi.fn();
      render(
        <Pairing
          defaultServerUrl={SERVER}
          subscribe={fakeFanOut().subscribe}
          onPaired={onPaired}
          onConfigureScanner={vi.fn()}
        />,
      );

      typeDigits("12345678");
      fireEvent.click(submitButton());

      // `vi.waitFor` and NOT the Testing Library one: this one polls on the
      // real timers it captured before the fakes were installed.
      await vi.waitFor(() => expect(screen.getByText(BOUND)).toBeDefined(), { timeout: 2_000 });
      await act(async () => {});
      expect(onPaired).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(HANDOFF_MS);
      });
      expect(onPaired).toHaveBeenCalledTimes(1);

      // And the timer the button pre-empts must not fire behind it either: two
      // handovers would reload the shell twice for one pairing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HANDOFF_MS * 3);
      });
      expect(onPaired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
