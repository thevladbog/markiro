import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { PairKioskResultDto } from "../src/api/types.js";
import type { ScanListener, ScanSource } from "../src/scanner/source.js";
import { readSnapshot } from "../src/store/cache.js";
import { readConfig } from "../src/store/config.js";
import { Pairing } from "../src/screens/Pairing.js";

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
function fakeScanSource(): ScanSource & { emit: (raw: string) => void; started: () => number } {
  let listener: ScanListener | null = null;
  let starts = 0;
  return {
    isAvailable: () => true,
    start(next) {
      listener = next;
      starts += 1;
      return () => {
        listener = null;
      };
    },
    emit(raw) {
      act(() => listener?.(raw));
    },
    started: () => starts,
  };
}

function typeDigits(digits: string): void {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

const submitButton = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(impl: () => Promise<Response>) {
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
  });

  it("shows the invalid-code message on a 401 and persists nothing", async () => {
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

    await waitFor(() => expect(screen.getByText("Wrong or expired code")).toBeDefined());
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

    fireEvent.click(screen.getByRole("button", { name: "Set up the scanner" }));
    expect(onConfigureScanner).toHaveBeenCalledTimes(1);
  });

  it("fills the entry from a scan, so a scanned code needs no retyping", () => {
    const source = fakeScanSource();
    render(
      <Pairing
        defaultServerUrl={SERVER}
        scanSource={source}
        onPaired={vi.fn()}
        onConfigureScanner={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Scan the code" }));
    expect(source.started()).toBe(1);
    source.emit(" 12345678 ");

    expect(screen.getByLabelText("code").textContent).toBe("12345678");
    expect(submitButton().disabled).toBe(false);
  });

  it("refuses a bundle whose generatedAt is unparseable, and does not half-pair the device", async () => {
    // Same hole as `refreshSnapshot`'s, through a different door: `cacheAge`
    // cannot measure such a stamp, so persisting it would disable the seven-day
    // lockout forever. Writing the token and then rejecting the snapshot would
    // be worse than not pairing at all.
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

    await waitFor(() =>
      expect(
        screen.getByText("No connection to the server. Check the network and try again."),
      ).toBeDefined(),
    );
    expect(await readConfig()).toBeNull();
    expect(await readSnapshot()).toBeNull();
    expect(onPaired).not.toHaveBeenCalled();
  });
});
