import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `@tauri-apps/plugin-sql`'s `Database.load`/`execute`/`select` are themselves
// thin wrappers over `@tauri-apps/api/core`'s `invoke` (`plugin:sql|load`,
// `plugin:sql|execute`, ...), so mocking this one module covers both the
// config bridge (`read_config`/`write_config`) and the SQLite mirror
// migrations App runs on mount — no real Tauri runtime needed under jsdom.
const invokeMock = vi.fn<(cmd: string) => Promise<unknown>>((cmd) => {
  if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
  if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
  if (cmd === "plugin:sql|select") return Promise.resolve([]);
  return Promise.resolve(undefined);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
}));

// `@tauri-apps/plugin-sql` is a real npm package outside the Vite SSR module
// graph, so its OWN internal `import { invoke } from "@tauri-apps/api/core"`
// does not resolve through the mock above (Vitest cannot rewrite a transitive
// import inside an externalized dependency) -- `Database.load`/`execute`
// would otherwise hit the real Tauri bridge and throw under jsdom. Mocking
// the package directly, routed through the same `invokeMock`, keeps every
// existing `plugin:sql|*` expectation in this file meaningful. The factory
// body is hoisted above this file's other top-level statements, so it must
// declare its own class rather than close over one defined further down.
vi.mock("@tauri-apps/plugin-sql", () => {
  // `invokeMock`'s declared type only takes `cmd` -- the real `invoke()` (and
  // this file's other mock, above) also forward the command's payload, cast
  // away here the same way, so `toHaveBeenCalledWith(cmd, payload)`
  // assertions keep working.
  const callInvoke = (...args: unknown[]) => invokeMock(...(args as [string]));

  class FakeDatabase {
    constructor(private readonly path: string) {}
    static async load(path: string): Promise<FakeDatabase> {
      const resolved = await callInvoke("plugin:sql|load", { db: path });
      return new FakeDatabase(resolved as string);
    }
    async execute(query: string, values: unknown[] = []): Promise<unknown> {
      return callInvoke("plugin:sql|execute", { db: this.path, query, values });
    }
    async select<T>(query: string, values: unknown[] = []): Promise<T> {
      return callInvoke("plugin:sql|select", { db: this.path, query, values }) as Promise<T>;
    }
  }
  return { default: FakeDatabase };
});

// Hardware boundary mock (Finding 4, Task 8 review). `tauriHardware.onScannerStatus`
// wraps `@tauri-apps/api/event`'s `listen`, which has no real transport under
// jsdom -- unlike the SQLite bridge above, there is no lower-level `invoke`
// call to intercept, so there is no way to fire a "connected"/"disconnected"
// event from a test without mocking this module directly. Each method is
// individually reconfigurable per test via `.mockImplementation`/
// `.mockResolvedValue`/`.mockRejectedValue`; defaults are inert no-ops so
// every OTHER existing test in this file (which never configures a serial
// scanner) is unaffected by this mock's mere presence.
// `vi.hoisted` (not a plain `const`): the object literal's initializer is not
// itself a bare `vi.fn(...)` call, so Vitest's hoist analysis would not lift
// a plain `const hardwareMock = { ... }` above the `vi.mock` factory below
// that closes over it, leaving `hardwareMock` in the temporal dead zone.
const hardwareMock = vi.hoisted(() => ({
  listScannerPorts: vi.fn<() => Promise<string[]>>(async () => []),
  openScanner: vi.fn<(port: string, baud: number) => Promise<void>>(async () => {}),
  closeScanner: vi.fn<() => Promise<void>>(async () => {}),
  onScan: vi.fn<(listener: (raw: string) => void) => Promise<() => void>>(async () => () => {}),
  onScannerStatus: vi.fn<
    (listener: (status: "connected" | "disconnected") => void) => Promise<() => void>
  >(async () => () => {}),
  print: vi.fn<(target: unknown, bytes: Uint8Array) => Promise<void>>(async () => {}),
}));

vi.mock("../src/lib/hardware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HardwareModule>();
  return { ...actual, tauriHardware: hardwareMock };
});

import i18n from "../src/i18n/index.js";
import { App, nextStationView, pickScanSource, scannerIndicator } from "../src/App.js";
import type { StationConfig } from "../src/lib/config.js";
import { hashSecret } from "../src/lib/crypto.js";
import type { HardwareConfig } from "../src/lib/hardware-config.js";
import type * as HardwareModule from "../src/lib/hardware.js";
import type { ScannerStatus } from "../src/lib/hardware.js";
import { readShiftContext } from "../src/lib/mirror.js";
import { tauriExecutor } from "../src/lib/sqlite.js";
import type { OperatorMirrorRecord } from "@markiro/db";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  invokeMock.mockClear();
  vi.unstubAllGlobals();
  hardwareMock.listScannerPorts.mockReset().mockResolvedValue([]);
  hardwareMock.openScanner.mockReset().mockResolvedValue(undefined);
  hardwareMock.closeScanner.mockReset().mockResolvedValue(undefined);
  hardwareMock.onScan.mockReset().mockResolvedValue(() => {});
  hardwareMock.onScannerStatus.mockReset().mockResolvedValue(() => {});
  hardwareMock.print.mockReset().mockResolvedValue(undefined);
});

// No `tenantId` here on purpose: `Enrollment` never persists one (the
// api-key implies the tenant server-side), so `isEnrolled`/`nextStationView`
// must not require it either — see the enrollment-flow test below, which
// drives the real `Enrollment` success path and never sets a `tenantId`.
const enrolledConfig: StationConfig = {
  machineId: "m1",
  apiKey: "mk_key",
  serverUrl: "http://localhost:3000",
};

const operator: OperatorMirrorRecord = {
  operatorId: "op1",
  name: "Ivan",
  login: "1001",
  role: "operator",
  pinHash: "hash",
  badgeHash: null,
  active: true,
};

// -- Render-level floor-stage helpers (Finding 4) -----------------------

const OPERATOR_LOGIN = "1001";
const OPERATOR_PIN = "4242";

/** Row shape `readOperatorsMirror` expects back from `plugin:sql|select`. */
function operatorMirrorRow(pinHash: string) {
  return {
    operator_id: "op1",
    name: "Ivan",
    login: OPERATOR_LOGIN,
    role: "operator",
    pin_hash: pinHash,
    badge_hash: null,
    active: 1,
  };
}

/**
 * Wires `invokeMock` so the app can reach the floor stage: an enrolled
 * config, the given hardware configuration under the `hardware_config`
 * `station_meta` key, one active operator (verifiable with `OPERATOR_PIN`)
 * behind `readOperatorsMirror`'s query, and empty defaults for everything
 * else (`sound_settings`, `operators_slot`, migrations).
 */
function mockInvokeForFloor(pinHash: string, hardwareConfig: HardwareConfig) {
  invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
    if (cmd === "read_config") {
      return Promise.resolve({
        machine_id: "m1",
        api_key: "mk_key",
        server_url: "http://localhost:3000",
      });
    }
    if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
    if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
    if (cmd === "plugin:sql|select") {
      const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
      if (query.includes("station_meta")) {
        return Promise.resolve(
          values?.[0] === "hardware_config" ? [{ value: JSON.stringify(hardwareConfig) }] : [],
        );
      }
      // Word boundary so this matches `operators_mirror` only, not
      // `operators_mirror_b` (the roster-sync's inactive slot) — see the F3
      // test above for the same discipline.
      if (/FROM operators_mirror\b/.test(query)) {
        return Promise.resolve([operatorMirrorRow(pinHash)]);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve(undefined);
  });
}

function clickDigits(value: string) {
  for (const ch of value) {
    fireEvent.click(screen.getByRole("button", { name: ch }));
  }
}

/** Drives the real OperatorLogin PIN-pad flow to reach the floor stage. */
async function signInAsOperator() {
  await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
  clickDigits(OPERATOR_LOGIN);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  clickDigits(OPERATOR_PIN);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("scanner-status")).toBeDefined());
}

describe("nextStationView", () => {
  it("routes to loading while config has not been read yet", () => {
    expect(nextStationView(null, null)).toBe("loading");
  });

  it("routes to enrollment when the device has no tenant/key/server", () => {
    expect(nextStationView({ machineId: "m1" }, null)).toBe("enrollment");
  });

  it("routes to login once enrolled but no operator is signed in", () => {
    expect(nextStationView(enrolledConfig, null)).toBe("login");
  });

  it("routes to the floor once enrolled and an operator is signed in", () => {
    expect(nextStationView(enrolledConfig, operator)).toBe("floor");
  });
});

describe("App", () => {
  it("renders Enrollment when readConfig resolves an un-enrolled config", async () => {
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "read_config") return Promise.resolve({ machine_id: "m1" });
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
      // App now loads sound settings unconditionally on mount (Task 12), which
      // reads via `plugin:sql|select` -- without this branch it resolves
      // `undefined` instead of `[]` and `loadSoundSettings` throws on `rows[0]`.
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Connect station")).toBeDefined());
  });

  it("drives the real Enrollment success path and advances to OperatorLogin, not back to Enrollment (regression for C1)", async () => {
    // Mutable so a `write_config` call updates what the next `read_config`
    // resolves to — this is what actually exercises the App.tsx C1 fix: with
    // the old `isEnrolled` (requiring `tenantId`, which `Enrollment` never
    // writes), App would read back the just-persisted config and bounce
    // straight back to the Enrollment screen instead of advancing.
    let rustConfig: Record<string, unknown> = { machine_id: "m1" };
    invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
      if (cmd === "read_config") return Promise.resolve(rustConfig);
      if (cmd === "write_config") {
        rustConfig = (payload as { cfg: Record<string, unknown> }).cfg;
        return Promise.resolve(undefined);
      }
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    // The enrollment probe is `GET /shifts` (see api-client.ts `whoami`); a
    // 200 proves the key resolves a tenant.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));

    render(<App />);

    await waitFor(() => expect(screen.getByText("Connect station")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "mk_key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
    expect(screen.queryByText("Connect station")).toBeNull();

    vi.restoreAllMocks();
  });

  it("retries the roster sync when the browser fires 'online' after the initial sync failed (F3)", async () => {
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "read_config") {
        return Promise.resolve({
          machine_id: "m1",
          api_key: "mk_key",
          server_url: "http://localhost:3000",
        });
      }
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const rosterBody = JSON.stringify({
      items: [
        {
          operatorId: "op1",
          name: "Ivan",
          login: "1001",
          role: "operator",
          pinHash: "hash",
          badgeHash: null,
          active: true,
        },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("device offline"))
      .mockResolvedValueOnce(new Response(rosterBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // Initial sync (App mounts with a client already configured) fails.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The device comes back online -- this must trigger a second attempt.
    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // A never-before-synced device has no `operators_slot` row, so
    // `activeSlot` defaults to "a" and this first-ever publish targets its
    // opposite, slot "b". Pinned with a word boundary so this only matches
    // `operators_mirror_b`, not `operators_mirror` (a plain `stringContaining`
    // would pass against either table and stop meaning anything).
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:sql|execute",
        expect.objectContaining({
          query: expect.stringMatching(/INSERT INTO operators_mirror_b\b/),
        }),
      ),
    );
  });

  it("readShiftContext resolves null for a shift whose bundle has not been mirrored yet, so the 'preparing' branch is genuinely reachable", async () => {
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await expect(readShiftContext(tauriExecutor, "shift-not-yet-mirrored")).resolves.toBeNull();
  });

  it("uses the keyboard wedge when no serial scanner is configured", () => {
    expect(pickScanSource({ scanner: null, printer: null, printerLanguage: "zpl" })).toBe("wedge");
  });

  it("uses the hardware scanner once one is configured", () => {
    expect(
      pickScanSource({
        scanner: { port: "COM3", baud: 9600 },
        printer: null,
        printerLanguage: "zpl",
      }),
    ).toBe("hardware");
  });

  it("shows the keyboard indicator until a configured scanner reports connected", () => {
    expect(scannerIndicator({ scanner: null, printer: null, printerLanguage: "zpl" }, null)).toBe(
      "keyboard",
    );
    const configured = {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl" as const,
    };
    expect(scannerIndicator(configured, null)).toBe("disconnected");
    expect(scannerIndicator(configured, "connected")).toBe("connected");
    expect(scannerIndicator(configured, "disconnected")).toBe("disconnected");
  });

  it("renders the disconnected copy for a stored serial scanner until 'connected' arrives, then the connected copy (render-level coverage for Finding 4)", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );

    let statusListener: ((status: ScannerStatus) => void) | null = null;
    hardwareMock.onScannerStatus.mockImplementation((listener) => {
      statusListener = listener;
      return Promise.resolve(() => {
        statusListener = null;
      });
    });

    render(<App />);
    await signInAsOperator();

    // Nothing has confirmed the port is open yet -- must read disconnected,
    // never green, however plausible "it's configured, so it's on" sounds.
    expect(screen.getByTestId("scanner-status").textContent).toBe("No signal");

    act(() => {
      statusListener?.("connected");
    });

    await waitFor(() => expect(screen.getByTestId("scanner-status").textContent).toBe("Connected"));
  });

  it("closes the scanner session before opening it (Finding 2 ordering the reconciliation effect depends on)", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const calls: string[] = [];
    hardwareMock.closeScanner.mockImplementation(async () => {
      calls.push("close");
    });
    hardwareMock.openScanner.mockImplementation(async () => {
      calls.push("open");
    });
    mockInvokeForFloor(pinHash, {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    hardwareMock.listScannerPorts.mockResolvedValue(["COM3"]);

    render(<App />);
    await signInAsOperator();
    await waitFor(() => expect(calls).toContain("open"));

    // The boot run's own close(es)-then-open pair is done settling by now --
    // clear it so what follows reflects ONLY the second, reconciling run
    // that leaving Setup triggers. Without this reset, the boot run
    // unconditionally pushes "close" at index 0 before its own "no scanner
    // configured yet" early return, so `calls.indexOf("close")` is always 0
    // and `< calls.indexOf("open")` can never fail -- even an implementation
    // that opened before closing in the RECONCILING run would still pass,
    // because the boot run's leading close always wins the index race.
    calls.length = 0;

    // Leave Setup with the scanner configuration unchanged -- the
    // `sessionEpoch` bump this triggers re-runs the effect even though
    // port/baud did not change, and that reconciling run is what must
    // close before it opens.
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    await waitFor(() => expect(calls).toContain("open"));
    expect(calls).toEqual(["close", "open"]);
  });

  it("regression (Finding 2): leaving Setup with an unchanged scanner configuration reopens the session", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    hardwareMock.listScannerPorts.mockResolvedValue(["COM3"]);

    render(<App />);
    await signInAsOperator();

    await waitFor(() => expect(hardwareMock.openScanner).toHaveBeenCalledWith("COM3", 9600));
    const openCallsBeforeSetup = hardwareMock.openScanner.mock.calls.length;

    // Open Setup, re-pick the SAME port (already selected) and press Done
    // without changing anything -- an identical `HardwareConfig` value, but a
    // fresh object reference from `currentConfig()`, exactly the scenario
    // where the open effect's dependency array (keyed on port/baud) alone
    // would never re-run.
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "COM3" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(hardwareMock.openScanner.mock.calls.length).toBeGreaterThan(openCallsBeforeSetup),
    );
  });

  it("regression (Finding 2, Back): leaving Setup via Back after a manual test-connect retires that session without saving it", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    hardwareMock.listScannerPorts.mockResolvedValue(["COM3", "COM9"]);

    render(<App />);
    await signInAsOperator();
    await waitFor(() => expect(hardwareMock.openScanner).toHaveBeenCalledWith("COM3", 9600));

    // Reach Setup, manually connect a different port with the screen's own
    // "Connect scanner" button (not Done), then leave via Back -- the config
    // is never saved, so `hardwareConfig` is untouched, but the session Back
    // leaves running must still be retired and the still-configured COM3
    // session reopened, without an app restart.
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "COM9" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
    await waitFor(() => expect(hardwareMock.openScanner).toHaveBeenCalledWith("COM9", 9600));

    const openCallsBeforeBack = hardwareMock.openScanner.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(hardwareMock.openScanner.mock.calls.length).toBeGreaterThan(openCallsBeforeBack),
    );
    expect(hardwareMock.openScanner).toHaveBeenLastCalledWith("COM3", 9600);
  });

  it("regression (Finding 1): reconfiguring a connected scanner to a port whose open fails must not leave the status bar reading Connected", async () => {
    // This test deliberately makes `openScanner` reject, which the App.tsx
    // reconciliation effect logs via `console.error` (Finding 5) -- expected,
    // and already covered by the assertions below, so it is silenced here
    // rather than left to print a stack trace into otherwise-pristine test
    // output. Spied (not globally suppressed) and restored in `finally` so
    // every other test's `console.error` calls still surface normally, and
    // so a genuinely unexpected error logged by this test would still show
    // up if this spy were removed.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pinHash = await hashSecret(OPERATOR_PIN);
      mockInvokeForFloor(pinHash, {
        scanner: { port: "COM3", baud: 9600 },
        printer: null,
        printerLanguage: "zpl",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
      );

      let statusListener: ((status: ScannerStatus) => void) | null = null;
      hardwareMock.onScannerStatus.mockImplementation((listener) => {
        statusListener = listener;
        return Promise.resolve(() => {
          statusListener = null;
        });
      });
      // COM3 (the boot configuration) opens fine; COM9 (what Setup will be
      // reconfigured to, below) fails -- mirroring the Rust `Io(NotFound)`
      // fast path for a port that does not exist.
      hardwareMock.openScanner.mockImplementation((port) => {
        if (port === "COM9") return Promise.reject(new Error("No such file or directory"));
        return Promise.resolve(undefined);
      });
      hardwareMock.listScannerPorts.mockResolvedValue(["COM9"]);

      render(<App />);
      await signInAsOperator();

      // Establish the "connected" state the bug lets survive a reconfiguration.
      act(() => {
        statusListener?.("connected");
      });
      await waitFor(() =>
        expect(screen.getByTestId("scanner-status").textContent).toBe("Connected"),
      );

      // Reach Setup and reconfigure to COM9, pressing only Done -- exactly
      // the operator action from Finding 1 (no "Connect scanner" test-press
      // first).
      fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
      fireEvent.click(await screen.findByRole("button", { name: "COM9" }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      await waitFor(() => expect(hardwareMock.openScanner).toHaveBeenCalledWith("COM9", 9600));
      // The invariant this whole indicator exists for: never green for a
      // scanner that did not actually open.
      expect(screen.getByTestId("scanner-status").textContent).not.toBe("Connected");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
