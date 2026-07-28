import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { KioskBootstrapDto, PairKioskResultDto } from "../src/api/types.js";
import type { ScanListener, ScanSource } from "../src/scanner/source.js";
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
      employees: [{ id: "e1", fullName: "Иванов И.", role: null, badgeHash: null }],
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

/** A `ScanSource` whose `start` captures the listener, so a test can push a
 * payload through the same seam the keyboard wedge uses. */
function fakeScanSource(): ScanSource & {
  emit: (raw: string) => void;
  started: () => number;
  stopped: () => number;
} {
  let listener: ScanListener | null = null;
  let starts = 0;
  let stops = 0;
  return {
    isAvailable: () => true,
    start(next) {
      listener = next;
      starts += 1;
      return () => {
        stops += 1;
        listener = null;
      };
    },
    emit(raw) {
      act(() => listener?.(raw));
    },
    started: () => starts,
    stopped: () => stops,
  };
}

function typeDigits(digits: string): void {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

const submitButton = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
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
  it("enables the submit only once all eight digits are entered", () => {
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(await readConfig()).toEqual({
      serverUrl: SERVER,
      token: "tok-abc",
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

  it("leaves the device unpaired and retryable when the snapshot write itself fails", async () => {
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
        scanSource={fakeScanSource()}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(await readConfig()).toBeNull();
    expect(writes.writeConfig).not.toHaveBeenCalled();
    expect(onPaired).not.toHaveBeenCalled();

    // ...and the proof that it is recoverable: the very same screen, still
    // showing the code, pairs on the retry once the store is healthy again.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect((await readConfig())?.token).toBe("tok-abc");
    expect((await readSnapshot())?.bootstrap).toEqual(result.bootstrap);
  });

  it("shows the invalid-code message on a 401 and issues no write at all", async () => {
    stubFetch(() => Promise.resolve(errorResponse(401, "invalid code")));
    const onPaired = vi.fn();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
        onPaired={onPaired}
        onConfigureScanner={vi.fn()}
      />,
    );

    typeDigits("12345678");
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
  });

  it("listens from mount, so a scan arriving before anything is pressed is not dropped", () => {
    // The admin panel's pairing modal renders the code as a barcode and tells
    // the worker to scan it; at an unattended kiosk the instinct is to scan
    // first and read the screen second. A listener armed by a button press
    // would silently drop exactly that scan.
    const source = fakeScanSource();
    const view = render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(source.started()).toBe(1);
    source.emit(" 12345678 ");

    expect(codeDisplay().textContent).toBe("12345678");
    expect(submitButton().disabled).toBe(false);
    // Started once and stopped once: a window-level keydown handler left
    // subscribed after this screen goes away would eat the idle screen's scans.
    view.unmount();
    expect(source.started()).toBe(1);
    expect(source.stopped()).toBe(1);
  });

  it("offers the large scan button, and pressing it announces that a scan is awaited", () => {
    // The button is not the only way in (the listener is always armed), but it
    // is the affordance the brief mandates beside the keypad: this screen is
    // read at arm's length in floor mode, where a small hint line does not
    // carry "you can scan this" at all. Pressing it commits the screen to a
    // visible waiting state instead of doing nothing.
    const source = fakeScanSource();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
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
    source.emit(" 12345678 ");
    expect(codeDisplay().textContent).toBe("12345678");
    // ...and it ends when what it waited for arrives.
    expect(screen.queryByText("Waiting for the scan")).toBeNull();
  });

  it("takes a scan although the scan button was never pressed — the button only announces", () => {
    // The property that matters: restoring the button must not turn it back
    // into the arming switch it used to be. A worker who walks up and scans,
    // pressing nothing, still pairs.
    const source = fakeScanSource();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    expect(scanButton()).toBeDefined();
    source.emit(" 12345678 ");

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
        scanSource={fakeScanSource()}
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
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Binding the device… downloading settings and operators")).toBeNull();
  });

  it("refuses a scan that is not exactly eight digits, says so, and keeps listening", () => {
    const source = fakeScanSource();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    source.emit("123");
    expect(screen.getByText("Not a pairing code: eight digits are required")).toBeDefined();
    expect(codeDisplay().textContent).toBe("");

    // A marking code scanned by mistake is REFUSED, not truncated to its first
    // eight digits and offered for submission as if the worker had meant it.
    source.emit("0104600682000013");
    expect(codeDisplay().textContent).toBe("");
    expect(submitButton().disabled).toBe(true);

    // Still listening: the real code lands without anything being pressed.
    source.emit(" 12345678 ");
    expect(codeDisplay().textContent).toBe("12345678");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it("pauses the scan listener while the server field is open — the wedge would eat what is typed", () => {
    const source = fakeScanSource();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    fireEvent.click(serverToggle());
    source.emit("12345678");
    expect(codeDisplay().textContent).toBe("");

    fireEvent.click(serverToggle());
    source.emit("12345678");
    expect(codeDisplay().textContent).toBe("12345678");
    expect(source.started()).toBe(2);
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
        scanSource={fakeScanSource()}
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
        scanSource={fakeScanSource()}
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
});
