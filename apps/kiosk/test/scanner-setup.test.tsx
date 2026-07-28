import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { KioskBootstrapDto } from "../src/api/types.js";
import type { ScanListener, ScanSource } from "../src/scanner/source.js";
import { readScannerSettings } from "../src/store/config.js";
import { ScannerSetup } from "../src/screens/ScannerSetup.js";

const SALT = "fwGrIt01vwgBxxDlhqLVRQ==";
const GS = String.fromCharCode(0x1d);
const GTIN = "04600682000013";

async function hashFor(secret: string): Promise<string> {
  return formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(secret, SALT, PHC_ITERATIONS));
}

interface OperatorSeed {
  login: string;
  pin: string;
  badge?: string;
  active?: boolean;
}

/** Built exactly the way `test/credentials.test.ts` builds its roster, so the
 * verifiers this screen calls (Task 7) see real PHC strings and not stubs. */
async function bootstrapWith(seeds: OperatorSeed[]): Promise<KioskBootstrapDto> {
  const operators = await Promise.all(
    seeds.map(async (seed) => ({
      employeeId: `emp-${seed.login}`,
      name: `Оператор ${seed.login}`,
      login: seed.login,
      role: "operator",
      pinHash: await hashFor(seed.pin),
      badgeHash: seed.badge === undefined ? null : await hashFor(seed.badge),
      active: seed.active ?? true,
    })),
  );
  return {
    generatedAt: "2026-07-28T06:00:00.000Z",
    config: { dayLimitPerEmployee: 5, showPrices: true },
    badgeSalt: SALT,
    reasons: [],
    products: [],
    employees: [],
    operators,
  };
}

/** A `ScanSource` whose `start` captures the listener, so a test can push a
 * payload through the same seam the keyboard wedge uses. */
function fakeScanSource(): ScanSource & { emit: (raw: string) => void } {
  let listener: ScanListener | null = null;
  return {
    isAvailable: () => true,
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emit(raw) {
      act(() => listener?.(raw));
    },
  };
}

/**
 * `isWebSerialSupported()` reads `"serial" in navigator` — so the capability
 * is driven through its ACTUAL input here rather than by stubbing the module.
 * A stub would pass even if the screen asked the wrong question.
 */
function setWebSerial(present: boolean): void {
  if (present) {
    Object.defineProperty(navigator, "serial", { value: {}, configurable: true, writable: true });
  } else {
    delete (navigator as { serial?: unknown }).serial;
  }
}

const KEYBOARD = "Keyboard wedge (HID)";
const SERIAL = "Web Serial (COM port)";
const TRANSPORTS = "How the scanner is connected";
const TEST_SCAN = "Test scan";

const transportGroup = () => screen.queryByRole("group", { name: TRANSPORTS });
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
/** The one live region on the screen: the entry display while gated, the test
 * scan verdict once open. The two branches never coexist — that is the point. */
const status = () => screen.getByRole("status");

function typeDigits(digits: string): void {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit }));
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  setWebSerial(false);
});

afterEach(() => {
  setWebSerial(false);
});

describe("ScannerSetup — transports offered", () => {
  it("offers only the keyboard wedge when the device has no Web Serial", () => {
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        scanSource={fakeScanSource()}
        onClose={vi.fn()}
      />,
    );

    // A tablet must never be shown a port picker it cannot use.
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(radio(KEYBOARD)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: SERIAL })).toBeNull();
  });

  it("offers both transports when navigator.serial exists", () => {
    setWebSerial(true);
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        scanSource={fakeScanSource()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(radio(SERIAL)).toBeTruthy();
  });
});

describe("ScannerSetup — the test scan", () => {
  const cases: { what: string; raw: string; label: string }[] = [
    { what: "a marking code", raw: `01${GTIN}21KYC9X7MQ${GS}93Abcd`, label: "Marking code" },
    { what: "a badge", raw: "MARKIRO-BADGE-4412", label: "Badge" },
    {
      what: "a marking code whose GS separator the wedge swallowed",
      raw: `01${GTIN}21KYC9X7MQ93Abcd`,
      label: "without the GS separator",
    },
    { what: "an unrecognised payload", raw: GTIN, label: "Not recognised" },
  ];

  for (const { what, raw, label } of cases) {
    it(`echoes ${what} as its own kind`, () => {
      const source = fakeScanSource();
      render(
        <ScannerSetup paired={false} bootstrap={null} scanSource={source} onClose={vi.fn()} />,
      );

      source.emit(raw);
      expect(status().textContent).toContain(label);
    });
  }

  it("does NOT fold the GS-dropped scan into the unrecognised verdict", () => {
    // This is the whole diagnostic point of the screen: an installer whose
    // keyboard wedge swallows GS must be able to tell that apart from a code
    // the kiosk simply does not know, because only the first one is fixed by
    // switching to Web Serial.
    const source = fakeScanSource();
    render(<ScannerSetup paired={false} bootstrap={null} scanSource={source} onClose={vi.fn()} />);

    source.emit(`01${GTIN}21KYC9X7MQ93Abcd`);
    const incomplete = status().textContent;
    source.emit(GTIN);
    const unknown = status().textContent;

    expect(incomplete).not.toEqual(unknown);
    expect(incomplete).toMatch(/GS/);
  });

  it("names the dropped separator in the primary language too", async () => {
    await i18n.changeLanguage("ru");
    try {
      const source = fakeScanSource();
      render(
        <ScannerSetup paired={false} bootstrap={null} scanSource={source} onClose={vi.fn()} />,
      );

      source.emit(`01${GTIN}21KYC9X7MQ93Abcd`);
      expect(status().textContent).toContain("разделителя GS");
      source.emit(GTIN);
      expect(status().textContent).toContain("Не распознано");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("ScannerSetup — access before pairing", () => {
  it("opens with no credential at all, because the scanner is what reads the pairing code", () => {
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        scanSource={fakeScanSource()}
        onClose={vi.fn()}
      />,
    );

    expect(transportGroup()).toBeTruthy();
    expect(screen.getByText(TEST_SCAN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});

describe("ScannerSetup — access after pairing", () => {
  it("keeps the settings out of the document entirely until an operator signs in", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const { container } = render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );

    // Absent, not merely hidden: a CSS-hidden settings pane would still be in
    // the tree here, and a customer poking at an unattended kiosk could reach
    // it with a screen reader or the tab key.
    expect(transportGroup()).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(container.textContent).not.toContain(KEYBOARD);
    expect(container.textContent).not.toContain(TEST_SCAN);
    expect(screen.getByRole("heading", { name: "Sign in to the settings" })).toBeTruthy();
  });

  it("keeps it closed on a wrong PIN and says only that sign-in failed", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const { container } = render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );

    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("9999");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(transportGroup()).toBeNull();
    expect(container.textContent).not.toContain(KEYBOARD);
  });

  it("shows the SAME message for an unknown personnel number as for a wrong PIN", async () => {
    // Naming which half was wrong would let anyone standing at the kiosk
    // enumerate personnel numbers, exactly as the station guards against.
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const first = render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );
    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("9999");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    const wrongPin = screen.getByRole("alert").textContent;
    first.unmount();

    render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );
    typeDigits("7777");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));

    expect(screen.getByRole("alert").textContent).toEqual(wrongPin);
  });

  it("opens on the right personnel number and PIN", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );

    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(transportGroup()).toBeTruthy());
    expect(radio(KEYBOARD)).toBeTruthy();
  });

  it("opens on a badge scan of an active operator", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821", badge: "OPBADGE-7" }]);
    const source = fakeScanSource();
    render(<ScannerSetup paired bootstrap={bootstrap} scanSource={source} onClose={vi.fn()} />);

    source.emit("OPBADGE-7");

    await waitFor(() => expect(transportGroup()).toBeTruthy());
  });

  it("stays closed for a deactivated operator's badge", async () => {
    const bootstrap = await bootstrapWith([
      { login: "1042", pin: "4821", badge: "OPBADGE-7", active: false },
    ]);
    const source = fakeScanSource();
    render(<ScannerSetup paired bootstrap={bootstrap} scanSource={source} onClose={vi.fn()} />);

    source.emit("OPBADGE-7");

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(transportGroup()).toBeNull();
  });

  it("carries the can't-sign-in recovery hint on the gate", async () => {
    // Without it a kiosk whose roster is empty or unreachable is bricked with
    // no visible way out — re-pairing from the cabinet is that way out.
    const bootstrap = await bootstrapWith([]);
    render(
      <ScannerSetup paired bootstrap={bootstrap} scanSource={fakeScanSource()} onClose={vi.fn()} />,
    );

    const hint = screen.getByText(/unbind this kiosk/i);
    expect(hint.textContent).toMatch(/new code/i);
  });
});

describe("ScannerSetup — the chosen transport", () => {
  it("survives a remount", async () => {
    setWebSerial(true);
    const first = render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        scanSource={fakeScanSource()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(radio(SERIAL));
    await waitFor(async () => expect((await readScannerSettings())?.transport).toBe("serial"));
    first.unmount();

    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        scanSource={fakeScanSource()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));
    expect(radio(KEYBOARD).checked).toBe(false);
  });
});
