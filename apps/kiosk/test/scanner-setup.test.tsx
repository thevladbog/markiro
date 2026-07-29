import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { KioskBootstrapDto } from "../src/api/types.js";
import type * as OperatorModule from "../src/credentials/operator.js";
import type { ScanListener } from "../src/scanner/source.js";
import type { SerialPort } from "../src/scanner/web-serial.js";
import { readConfig, readScannerSettings, writeConfig } from "../src/store/config.js";
import { ScannerSetup } from "../src/screens/ScannerSetup.js";

/**
 * The one state a roster fixture cannot produce: a PIN check that THROWS.
 *
 * `verifyOperatorPin` reaches `crypto.subtle` through `verifyPhc`, which an
 * insecure context (a kiosk opened over plain http) simply does not have, and
 * the roster itself is read from IndexedDB — so «the check could not run» is a
 * real state of a real device, and distinct from «the check said no». The
 * module boundary is the only seam onto it; everything else passes straight
 * through to the real verifiers, badge tier included.
 */
const verifier = vi.hoisted(() => ({ pinThrows: false }));

vi.mock("../src/credentials/operator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OperatorModule>();
  return {
    ...actual,
    verifyOperatorPin: async (login: string, pin: string, bootstrap: KioskBootstrapDto) => {
      if (verifier.pinThrows) throw new Error("crypto.subtle is not available");
      return actual.verifyOperatorPin(login, pin, bootstrap);
    },
  };
});

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

/**
 * The shell's fan-out (`KioskShell`'s listener `Set`) over whatever transport
 * the kiosk is CURRENTLY running — and this screen's ONLY seam onto a scanner,
 * for the gate's badge and for the test scan alike.
 *
 * A fan-out rather than a `ScanSource` because that is the shape of the real
 * thing, and the shape is the fix: the shell subscribes to the transport once
 * and hands out set membership, so a screen joining it takes nothing away from
 * the screen behind it — which a second listener on a single-subscriber
 * `createWebSerialSource` very much does. There is deliberately no way to hand
 * this screen a source of its own; that the prop does not exist is what stops
 * the bug coming back.
 *
 * `listeners` is what pins the handover between this screen's two readers: the
 * gate and the test scan mean opposite things by the same gesture, so exactly
 * one of them may ever hold a place in the set.
 */
function fakeFanOut(): {
  subscribe: (listener: ScanListener) => () => void;
  emit: (raw: string) => void;
  listeners: () => number;
} {
  const set = new Set<ScanListener>();
  return {
    subscribe: (listener) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit: (raw) => act(() => set.forEach((listener) => listener(raw))),
    listeners: () => set.size,
  };
}

/** A fan-out nothing is ever pushed through, for the tests that are not about a
 * scan at all. Module-level so it is referentially stable, as the prop
 * requires. */
const noFanOut = (): (() => void) => () => {};

/**
 * The object `navigator.serial.requestPort()` hands back, and deliberately an
 * INERT one.
 *
 * This screen obtains the grant — it is the only place in the whole flow that
 * can, since `requestPort()` needs transient user activation — and then hands
 * it straight to the shell. It never opens the port, never reads it and never
 * closes it: one owner holds the transport, and this is not the owner. So the
 * port is here to be passed along and identified, and modelling a lifecycle
 * this screen does not drive would only imply it does.
 *
 * The lifecycle IS modelled where it is genuinely exercised — `restartablePort`
 * in `test/scanner.test.ts` for the source itself, and `fakeSerialPort` in
 * `test/app.test.tsx` for the shell that owns it.
 */
function fakePort(): { port: SerialPort } {
  return {
    port: {
      open: async () => {},
      close: async () => {},
      readable: null,
    },
  };
}

/**
 * `isWebSerialSupported()` reads `"serial" in navigator` — so the capability
 * is driven through its ACTUAL input here rather than by stubbing the module.
 * A stub would pass even if the screen asked the wrong question.
 *
 * `requestPort` goes on the same object for the same reason: it is the ONE
 * call that can ever produce a `SerialPort`, the browser only honours it under
 * transient user activation, and faking it here (rather than mocking the
 * screen's import) means the screen has to reach for the real API through the
 * real gesture handler to find it.
 */
function setWebSerial(present: boolean, requestPort?: () => Promise<SerialPort>): void {
  if (present) {
    Object.defineProperty(navigator, "serial", {
      value: requestPort ? { requestPort } : {},
      configurable: true,
      writable: true,
    });
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
  verifier.pinThrows = false;
});

afterEach(() => {
  setWebSerial(false);
});

describe("ScannerSetup — transports offered", () => {
  it("offers only the keyboard wedge when the device has no Web Serial", () => {
    render(<ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />);

    // A tablet must never be shown a port picker it cannot use.
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(radio(KEYBOARD)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: SERIAL })).toBeNull();
  });

  it("offers both transports when navigator.serial exists", () => {
    setWebSerial(true);
    render(<ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />);

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
      const scanner = fakeFanOut();
      render(
        <ScannerSetup
          paired={false}
          bootstrap={null}
          subscribe={scanner.subscribe}
          onClose={vi.fn()}
        />,
      );

      scanner.emit(raw);
      expect(status().textContent).toContain(label);
    });
  }

  it("does NOT fold the GS-dropped scan into the unrecognised verdict", () => {
    // This is the whole diagnostic point of the screen: an installer whose
    // keyboard wedge swallows GS must be able to tell that apart from a code
    // the kiosk simply does not know, because only the first one is fixed by
    // switching to Web Serial.
    const scanner = fakeFanOut();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={scanner.subscribe}
        onClose={vi.fn()}
      />,
    );

    scanner.emit(`01${GTIN}21KYC9X7MQ93Abcd`);
    const incomplete = status().textContent;
    scanner.emit(GTIN);
    const unknown = status().textContent;

    expect(incomplete).not.toEqual(unknown);
    expect(incomplete).toMatch(/GS/);
  });

  it("does not tell a device without Web Serial to switch to Web Serial", () => {
    // `beforeEach` leaves `navigator.serial` absent, so this screen has just
    // printed «Web Serial is not available». Advising the switch anyway would
    // dead-end the installer on the ONE diagnostic this screen exists to
    // deliver — the actionable fix on such a device is the scanner's own
    // configuration, which can be told to transmit GS.
    const scanner = fakeFanOut();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={scanner.subscribe}
        onClose={vi.fn()}
      />,
    );

    scanner.emit(`01${GTIN}21KYC9X7MQ93Abcd`);

    const advice = status().textContent ?? "";
    expect(advice).toContain("GS");
    expect(advice).not.toMatch(/switch to web serial/i);
    expect(advice).toMatch(/scanner's own settings/i);
  });

  it("keeps the switch-to-Web-Serial advice where Web Serial actually exists", () => {
    setWebSerial(true);
    const scanner = fakeFanOut();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={scanner.subscribe}
        onClose={vi.fn()}
      />,
    );

    scanner.emit(`01${GTIN}21KYC9X7MQ93Abcd`);

    expect(status().textContent).toMatch(/switch to web serial/i);
  });

  it("names the dropped separator in the primary language too", async () => {
    await i18n.changeLanguage("ru");
    try {
      const scanner = fakeFanOut();
      render(
        <ScannerSetup
          paired={false}
          bootstrap={null}
          subscribe={scanner.subscribe}
          onClose={vi.fn()}
        />,
      );

      scanner.emit(`01${GTIN}21KYC9X7MQ93Abcd`);
      expect(status().textContent).toContain("разделителя GS");
      scanner.emit(GTIN);
      expect(status().textContent).toContain("Не распознано");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("ScannerSetup — access before pairing", () => {
  it("opens with no credential at all, because the scanner is what reads the pairing code", () => {
    render(<ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />);

    expect(transportGroup()).toBeTruthy();
    expect(screen.getByText(TEST_SCAN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});

describe("ScannerSetup — access after pairing", () => {
  it("keeps the settings out of the document entirely until an operator signs in", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const { container } = render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />,
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
      <ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />,
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
      <ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />,
    );
    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("9999");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    const wrongPin = screen.getByRole("alert").textContent;
    first.unmount();

    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);
    typeDigits("7777");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));

    expect(screen.getByRole("alert").textContent).toEqual(wrongPin);
  });

  /**
   * A check that THREW is a rejection, said in the very same words.
   *
   * Two properties at once, and the second is the sharp one:
   *
   *  - the submit must not simply do nothing. `finally` cleared `busy` and
   *    nothing else, so a crypto or store failure left the operator pressing a
   *    button that visibly answered them with silence, with nothing in the
   *    console either.
   *  - the message must be BYTE-IDENTICAL to the one a wrong PIN earns. A
   *    distinguishable failure is an oracle: it tells whoever is standing at an
   *    unattended kiosk that this personnel number is worth more guesses.
   */
  it("answers a PIN check that throws exactly as it answers a wrong PIN", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const rejected = render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />,
    );
    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("9999");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    const wrongPin = screen.getByRole("alert").textContent;
    rejected.unmount();

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    verifier.pinThrows = true;
    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);
    // The RIGHT credentials this time: only the check itself is broken.
    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(wrongPin).toBeTruthy(); // the comparison below must not pass on ""
    expect(screen.getByRole("alert").textContent).toEqual(wrongPin);
    expect(transportGroup()).toBeNull();
    // Both stages cleared and back at the first one, exactly as a rejection
    // leaves them — the proof the failure was handled, not merely survived.
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(status().textContent).toBe("");
    // Nothing on screen may say what happened, so the console has to.
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("opens on the right personnel number and PIN", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);

    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(transportGroup()).toBeTruthy());
    expect(radio(KEYBOARD)).toBeTruthy();
  });

  it("opens on a badge scan of an active operator", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821", badge: "OPBADGE-7" }]);
    // Through the FAN-OUT, because that is where a badge presented at a
    // running kiosk actually arrives — and, since the shell owns the transport,
    // the only place it can arrive at all.
    const fanOut = fakeFanOut();
    render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={fanOut.subscribe} onClose={vi.fn()} />,
    );

    fanOut.emit("OPBADGE-7");

    await waitFor(() => expect(transportGroup()).toBeTruthy());
  });

  it("stays closed for a deactivated operator's badge", async () => {
    const bootstrap = await bootstrapWith([
      { login: "1042", pin: "4821", badge: "OPBADGE-7", active: false },
    ]);
    const fanOut = fakeFanOut();
    render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={fanOut.subscribe} onClose={vi.fn()} />,
    );

    fanOut.emit("OPBADGE-7");

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(transportGroup()).toBeNull();
  });

  /**
   * WHICH scanner the gate listens to — the device's, and only ever ONE
   * subscription to it.
   *
   * `createWebSerialSource` is single-subscriber (`port.readable` is locked by
   * the first reader) and on a serial kiosk the shell has held that reader
   * since boot, so a listener this screen started on a source of its own would
   * read NOTHING and the badge tier of the gate would be dead without a
   * symptom: PIN sign-in still works, so nobody is locked out to report it, and
   * Web Serial is the configuration this product recommends.
   *
   * The prop that made that possible is gone — a screen can no longer be handed
   * a source at all — so what is left to pin is the count: the gate joins the
   * device's scanner exactly once, and takes nothing away from the screen
   * standing behind it. (The end-to-end half of this, over a real
   * `SerialPort` the shell is holding, is `test/app.test.tsx`'s «signs an
   * operator in at the settings gate on a badge read over Web Serial».)
   */
  it("reads the gate's badge off the running transport, joining it exactly once", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821", badge: "OPBADGE-7" }]);
    const fanOut = fakeFanOut();
    render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={fanOut.subscribe} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(fanOut.listeners()).toBe(1));

    fanOut.emit("OPBADGE-7");

    await waitFor(() => expect(transportGroup()).toBeTruthy());
    // Still one: opening the gate hands the place over to the test scan, it
    // does not add a second reader beside the first.
    expect(fanOut.listeners()).toBe(1);
  });

  /**
   * The handover between this screen's two readers.
   *
   * The same gesture means opposite things on either side of the gate — «let me
   * in», then «tell me what you made of this» — so exactly one of the two may
   * ever hold a place in the fan-out. Two at once would answer one scan twice:
   * a badge presented at the still-locked gate would be echoed as a verdict on
   * a screen the operator has not been admitted to.
   *
   * That the verdict belongs to the transport the INSTALLER PICKED — the false
   * green light Task 11's review caught — is no longer arranged here at all. It
   * is arranged by ownership: picking a transport swaps what the shell reads,
   * so this seam IS the picked transport. `test/app.test.tsx`'s «moves the test
   * scan onto the transport just picked, and off the one before it» pins that
   * end to end, through the real swap rather than a stand-in for it.
   */
  it("hands its place in the fan-out from the gate to the test scan, never holding both", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    const fanOut = fakeFanOut();
    render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={fanOut.subscribe} onClose={vi.fn()} />,
    );

    // Shut: a scan is a sign-in attempt, and nothing else. It is refused and
    // NOT echoed as a verdict on a screen nobody has been admitted to.
    await waitFor(() => expect(fanOut.listeners()).toBe(1));
    fanOut.emit(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(status().textContent).toBe("");

    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(transportGroup()).toBeTruthy());

    // Open: one place still, now held by the other reader — and the very same
    // scan means the opposite thing.
    await waitFor(() => expect(fanOut.listeners()).toBe(1));
    fanOut.emit(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);

    expect(status().textContent).toContain("Marking code");
  });

  it("carries the can't-sign-in recovery hint on the gate", async () => {
    // Without it a kiosk whose roster is empty or unreachable is bricked with
    // no visible way out — re-pairing from the cabinet is that way out.
    const bootstrap = await bootstrapWith([]);
    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);

    const hint = screen.getByText(/unbind this kiosk/i);
    expect(hint.textContent).toMatch(/new code/i);
  });
});

/**
 * WHAT THE RADIO CLAIMS has to be what the kiosk is running, and the store
 * alone cannot say so.
 *
 * The shell honours a stored "serial" only while the browser still holds the
 * port grant behind it (`recoverGrantedPort` in `KioskShell.tsx`) and falls
 * back to the keyboard wedge when it does not — a reset profile, a different
 * machine, a scanner that moved. Reading the store here in that state checks
 * «Web Serial» over a kiosk running the wedge, and the test scan then certifies
 * the wedge under that label: the installer leaves on a green light, with a
 * saved configuration that misdescribes the device.
 */
describe("ScannerSetup — the transport the shell is actually running", () => {
  it("checks what the shell recovered, not what the store remembers", async () => {
    const { port } = fakePort();
    setWebSerial(true, async () => port);
    // A previous visit settled on Web Serial and stored it...
    const first = render(
      <ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />,
    );
    fireEvent.click(radio(SERIAL));
    await waitFor(async () => expect((await readScannerSettings())?.transport).toBe("serial"));
    first.unmount();

    // ...but the grant is gone, so the shell came up on the keyboard wedge.
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={noFanOut}
        activeTransport="keyboard"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(radio(KEYBOARD).checked).toBe(true));
    expect(radio(SERIAL).checked).toBe(false);
    // And the store is left alone: back on the machine that holds the grant,
    // the choice made there is still the choice.
    expect((await readScannerSettings())?.transport).toBe("serial");
  });

  it("follows a shell that settles on Web Serial after this screen is already up", async () => {
    // `recoverGrantedPort` is async and this screen opens without a credential
    // on an unpaired device, so it can be standing before the shell knows what
    // it ended up running. A radio seeded once at mount would go on describing
    // the transport the shell had before it settled.
    const { port } = fakePort();
    setWebSerial(true, async () => port);
    const props = {
      paired: false as const,
      bootstrap: null,
      subscribe: noFanOut,
      onClose: vi.fn(),
    };
    const view = render(<ScannerSetup {...props} activeTransport="keyboard" />);
    expect(radio(KEYBOARD).checked).toBe(true);

    view.rerender(<ScannerSetup {...props} activeTransport="serial" />);

    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));
    expect(radio(KEYBOARD).checked).toBe(false);
  });
});

describe("ScannerSetup — the chosen transport", () => {
  it("survives a remount", async () => {
    const { port } = fakePort();
    setWebSerial(true, async () => port);
    const first = render(
      <ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />,
    );

    fireEvent.click(radio(SERIAL));
    await waitFor(async () => expect((await readScannerSettings())?.transport).toBe("serial"));
    first.unmount();

    render(<ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />);

    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));
    expect(radio(KEYBOARD).checked).toBe(false);
  });
});

describe("ScannerSetup — granting the serial port", () => {
  it("asks the browser for a port, and keeps the choice only once the grant lands", async () => {
    // `createWebSerialSource` needs a `SerialPort`, and `requestPort()` under a
    // user gesture is the only thing that can ever produce one — `getPorts()`
    // lists grants that already happened and returns [] forever otherwise.
    // This radio is the single gesture in the whole install flow, so it is the
    // one place the grant can be asked for.
    const { port } = fakePort();
    const requestPort = vi.fn(async () => port);
    setWebSerial(true, requestPort);
    const onTransportChange = vi.fn();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={noFanOut}
        onTransportChange={onTransportChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(radio(SERIAL));

    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));
    expect(requestPort).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect((await readScannerSettings())?.transport).toBe("serial"));
    // Handed up, because the app shell (Task 14) mounts on boot with no
    // gesture and so can never ask for this grant itself.
    expect(onTransportChange).toHaveBeenCalledWith("serial", port);
  });

  /**
   * EVERY pick is announced, including a repeat of one already made — and the
   * grant travels with each one.
   *
   * This is the screen's whole half of the swap. It opens no port and reads no
   * bytes: it obtains the grant (the only place in the flow that can) and hands
   * it over, and the shell moving what it reads is what puts the test scan on
   * the picked transport. So a pick that is silently not announced is a green
   * light for the transport it replaced.
   *
   * The Serial → Keyboard → Serial path is the one an installer comparing the
   * two takes, and its second «serial» is the one most easily dropped — the
   * radio is already showing what the store already says, so a screen that only
   * announced CHANGES it noticed would leave the kiosk on the wedge while the
   * radio claims Web Serial. The port has to travel with it too: the shell
   * cannot rebuild a source from the mode alone.
   *
   * That the transport really does follow all three times is pinned end to end
   * in `test/app.test.tsx` («holds exactly one transport subscription across a
   * swap…», which finishes on a real scan through the twice-picked port).
   */
  it("announces every pick, and carries the grant with each serial one", async () => {
    const { port } = fakePort();
    setWebSerial(true, async () => port);
    const onTransportChange = vi.fn();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={noFanOut}
        onTransportChange={onTransportChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(radio(SERIAL));
    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));

    fireEvent.click(radio(KEYBOARD));
    await waitFor(() => expect(radio(KEYBOARD).checked).toBe(true));

    fireEvent.click(radio(SERIAL));
    await waitFor(() => expect(radio(SERIAL).checked).toBe(true));

    await waitFor(() => expect(onTransportChange).toHaveBeenCalledTimes(3));
    expect(onTransportChange.mock.calls).toEqual([
      ["serial", port],
      ["keyboard", undefined],
      ["serial", port],
    ]);
  });

  it("stays on the keyboard, stores nothing and says so when the picker is dismissed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // What Chrome throws when the installer closes the port picker.
    setWebSerial(true, () => Promise.reject(new DOMException("No port selected", "NotFoundError")));
    const onTransportChange = vi.fn();
    render(
      <ScannerSetup
        paired={false}
        bootstrap={null}
        subscribe={noFanOut}
        onTransportChange={onTransportChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(radio(SERIAL));

    // A silently ignored choice is worse than a refused one: without this the
    // installer walks away believing the kiosk is on Web Serial.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/keyboard mode/i));
    expect(radio(KEYBOARD).checked).toBe(true);
    expect(radio(SERIAL).checked).toBe(false);
    // A stored "serial" with no port grant is a mode the next boot would try
    // to honour and silently fail at, so nothing is written at all.
    expect(await readScannerSettings()).toBeNull();
    expect(onTransportChange).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ScannerSetup — the gate's entry", () => {
  it("lets a mistyped digit be cleared instead of forcing a failed sign-in", async () => {
    // A gloved hand on a floor kiosk mistypes. Without a clear control the
    // only way out is to submit, absorb the deliberately generic error, and
    // re-enter BOTH stages.
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);

    typeDigits("1043");
    expect(status().textContent).toBe("1043");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(status().textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull(); // corrected, not rejected

    typeDigits("1042");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    typeDigits("48212");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    typeDigits("4821");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(transportGroup()).toBeTruthy());
  });

  it("caps the entry so it cannot outgrow the letter-spaced display", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821" }]);
    render(<ScannerSetup paired bootstrap={bootstrap} subscribe={noFanOut} onClose={vi.fn()} />);

    typeDigits("1234567890123456789");

    expect(status().textContent).toHaveLength(12);
  });
});

describe("ScannerSetup — what the store keeps", () => {
  it("keeps a transport chosen BEFORE pairing across the pairing write", async () => {
    // The real-world order: the scanner is usually what reads the pairing code
    // off the admin panel, so it is configured first — and pairing then writes
    // its own record into the very same object store.
    const { port } = fakePort();
    setWebSerial(true, async () => port);
    const first = render(
      <ScannerSetup paired={false} bootstrap={null} subscribe={noFanOut} onClose={vi.fn()} />,
    );
    fireEvent.click(radio(SERIAL));
    await waitFor(async () => expect((await readScannerSettings())?.transport).toBe("serial"));
    first.unmount();

    // Exactly what `Pairing.submit()` writes on success.
    await writeConfig({
      serverUrl: "https://markiro.test",
      token: "device-token",
      kioskName: "Киоск 1",
      place: null,
      nextDeviceSeq: 1,
    });

    expect((await readScannerSettings())?.transport).toBe("serial");
    expect((await readConfig())?.token).toBe("device-token");
  });

  it("renders no verdict and persists nothing for a scan arriving while the gate is locked", async () => {
    const bootstrap = await bootstrapWith([{ login: "1042", pin: "4821", badge: "OPBADGE-7" }]);
    const fanOut = fakeFanOut();
    const { container } = render(
      <ScannerSetup paired bootstrap={bootstrap} subscribe={fanOut.subscribe} onClose={vi.fn()} />,
    );

    // Down the RUNNING transport, which is the only way anything reaches a
    // kiosk whose gate is shut.
    fanOut.emit(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    // The one live region is the entry display here, never a verdict: a scan
    // at a locked kiosk is a sign-in attempt and nothing else.
    expect(status().textContent).toBe("");
    expect(container.textContent).not.toContain("Marking code");
    expect(transportGroup()).toBeNull();
    expect(await readScannerSettings()).toBeNull();
  });
});
