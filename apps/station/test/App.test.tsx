import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `@tauri-apps/plugin-sql`'s `Database.load`/`execute`/`select` are themselves
// thin wrappers over `@tauri-apps/api/core`'s `invoke` (`plugin:sql|load`,
// `plugin:sql|execute`, ...), so mocking this one module covers both the
// config bridge (`read_config`/`write_config`) and the SQLite mirror
// migrations App runs on mount — no real Tauri runtime needed under jsdom.
const invokeMock = vi.fn<(cmd: string, payload?: unknown) => Promise<unknown>>((cmd) => {
  if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
  if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
  if (cmd === "plugin:sql|select") return Promise.resolve([]);
  return Promise.resolve(undefined);
});
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class FakeChannel {
    onmessage: (payload: unknown) => void;

    constructor(onmessage: (payload: unknown) => void = () => undefined) {
      this.onmessage = onmessage;
    }
  },
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
  listUsbPrinters: vi.fn<() => Promise<{ name: string; port: string }[]>>(async () => []),
  openScanner: vi.fn<(port: string, baud: number) => Promise<void>>(async () => {}),
  closeScanner: vi.fn<() => Promise<void>>(async () => {}),
  onScan: vi.fn<(listener: (raw: string) => void) => Promise<() => void>>(async () => () => {}),
  onScannerStatus: vi.fn<
    (listener: (status: "connected" | "disconnected") => void) => Promise<() => void>
  >(async () => () => {}),
  print: vi.fn<(target: unknown, bytes: Uint8Array) => Promise<void>>(async () => {}),
}));

const lockdownMock = vi.hoisted(() => ({
  snapshot: { mode: "locked", pending: false, error: null } as LockdownModule.LockdownSnapshot,
  listeners: new Set<() => void>(),
  start: vi.fn<() => () => void>(() => () => {}),
  enter: vi.fn<() => Promise<void>>(),
  exit: vi.fn<() => Promise<void>>(),
  subscribe: vi.fn<(listener: () => void) => () => void>(),
  getSnapshot: vi.fn<() => LockdownModule.LockdownSnapshot>(),
  clearError: vi.fn<() => void>(),
  whenSettled: vi.fn<() => Promise<void>>(async () => {}),
  publish(next: LockdownModule.LockdownSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  },
}));

vi.mock("../src/lib/lockdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LockdownModule>();
  return { ...actual, createLockdownLifecycle: () => lockdownMock };
});

vi.mock("../src/lib/hardware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HardwareModule>();
  return { ...actual, tauriHardware: hardwareMock };
});

import i18n from "../src/i18n/index.js";
import {
  App,
  nextStationView,
  pairingServerUrl,
  pickScanSource,
  scannerIndicator,
} from "../src/App.js";
import type { StationConfig } from "../src/lib/config.js";
import { hashSecret } from "../src/lib/crypto.js";
import type { HardwareConfig } from "../src/lib/hardware-config.js";
import type * as HardwareModule from "../src/lib/hardware.js";
import type { ScannerStatus } from "../src/lib/hardware.js";
import type * as LockdownModule from "../src/lib/lockdown.js";
import { applyMigrations, readShiftContext } from "../src/lib/mirror.js";
import { tauriExecutor } from "../src/lib/sqlite.js";
import { BACKOFF_START_MS } from "../src/lib/sync.js";
import { OPERATOR_IDLE_TIMEOUT_MS } from "../src/lib/operator-idle-lock.js";
import * as WorkScreenModule from "../src/pages/WorkScreen.js";
import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.useRealTimers();
  invokeMock.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  hardwareMock.listScannerPorts.mockReset().mockResolvedValue([]);
  hardwareMock.listUsbPrinters.mockReset().mockResolvedValue([]);
  hardwareMock.openScanner.mockReset().mockResolvedValue(undefined);
  hardwareMock.closeScanner.mockReset().mockResolvedValue(undefined);
  hardwareMock.onScan.mockReset().mockResolvedValue(() => {});
  hardwareMock.onScannerStatus.mockReset().mockResolvedValue(() => {});
  hardwareMock.print.mockReset().mockResolvedValue(undefined);
  lockdownMock.start.mockReset().mockReturnValue(() => {});
  lockdownMock.snapshot = { mode: "locked", pending: false, error: null };
  lockdownMock.enter.mockReset().mockImplementation(async () => {
    lockdownMock.publish({ mode: "locked", pending: false, error: null });
  });
  lockdownMock.exit.mockReset().mockImplementation(async () => {
    lockdownMock.publish({ mode: "windowed", pending: false, error: null });
  });
  lockdownMock.subscribe.mockReset().mockImplementation((listener) => {
    lockdownMock.listeners.add(listener);
    return () => lockdownMock.listeners.delete(listener);
  });
  lockdownMock.getSnapshot.mockReset().mockImplementation(() => lockdownMock.snapshot);
  lockdownMock.clearError.mockReset().mockImplementation(() => {
    lockdownMock.publish({ ...lockdownMock.snapshot, error: null });
  });
  lockdownMock.whenSettled.mockReset().mockResolvedValue(undefined);
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
  pinHash:
    "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
  badgeHash: null,
  active: true,
};

// -- Render-level floor-stage helpers (Finding 4) -----------------------

const OPERATOR_LOGIN = "1001";
const OPERATOR_PIN = "4242";
const SECOND_OPERATOR_LOGIN = "1002";
const SECOND_OPERATOR_PIN = "4343";
const FIRST_KM = "0104600000000015215Ab1";
const SECOND_KM = "0104600000000015215Ab2";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Row shape `readOperatorsMirror` expects back from `plugin:sql|select`. */
function operatorMirrorRow(
  pinHash: string,
  identity: { operatorId: string; name: string; login: string } = {
    operatorId: "op1",
    name: "Ivan",
    login: OPERATOR_LOGIN,
  },
) {
  return {
    operator_id: identity.operatorId,
    name: identity.name,
    login: identity.login,
    role: "operator",
    pin_hash: pinHash,
    badge_hash: null,
    active: 1,
  };
}

/** Row shape `readBatch` (sync.ts) expects back from `plugin:sql|select`. */
interface OutboxSeedRow {
  id: number;
  shift_id: string;
  terminal_id: string | null;
  raw: string;
  verdict: string;
  scanned_at: string;
  code_hash: string | null;
  gtin14: string | null;
  serial: string | null;
  box_id: string | null;
  operator_id: string | null;
}

function outboxRow(id: number): OutboxSeedRow {
  return {
    id,
    shift_id: "shift-1",
    terminal_id: "t1",
    raw: `RAW${id}`,
    verdict: "ok",
    scanned_at: new Date().toISOString(),
    code_hash: `hash${id}`,
    gtin14: "04600000000017",
    serial: `S${id}`,
    box_id: null,
    operator_id: null,
  };
}

/**
 * Wires `invokeMock` so the app can reach the floor stage: an enrolled
 * config, the given hardware configuration under the `hardware_config`
 * `station_meta` key, a fixed `install_id` (the sync engine's per-
 * installation batch key component, Finding 3 — its exact value is never
 * asserted by anything in this file), one active operator (verifiable with
 * `OPERATOR_PIN`) behind `readOperatorsMirror`'s query, `outboxRows` behind
 * the outbox queries the sync engine issues (mutated on ack, so a drained
 * queue actually reads back empty rather than looping forever — and
 * returned, so a test can push more rows into it later to simulate a new
 * scan), and empty defaults for everything else (`sound_settings`,
 * `operators_slot`, migrations).
 */
/** Row shape the `conflicts_mirror` table holds (see conflicts.ts). */
interface ConflictSeedRow {
  code_hash: string;
  winning_terminal_id: string | null;
  winning_scanned_at: string;
  detected_at: string;
}

function mockInvokeForFloor(
  pinHash: string,
  hardwareConfig: HardwareConfig,
  outboxRows: OutboxSeedRow[] = [],
  stationConfig: Record<string, unknown> = {
    machine_id: "m1",
    device_id: "device-1",
    api_key: "mk_key",
    server_url: "http://localhost:3000",
  },
  onInvoke?: (cmd: string, payload: unknown) => void,
  recoverySnapshotFailure?: Error,
  configWriteFailure?: Error,
): OutboxSeedRow[] {
  const outbox = [...outboxRows];
  // Mutated by a real `recordConflicts`/`conflictCount` round-trip through
  // this mock (see the Finding 1 regression test below): unlike `outbox`,
  // no test seeds this up front -- every existing test in this file never
  // touches `conflicts_mirror`, so `conflicts.length` stays 0 and behaves
  // exactly as the previous unconditional `Promise.resolve([])` fallback did.
  const conflicts: ConflictSeedRow[] = [];
  invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
    onInvoke?.(cmd, payload);
    if (cmd === "read_config") {
      return Promise.resolve(stationConfig);
    }
    if (cmd === "write_config") {
      if (configWriteFailure) return Promise.reject(configWriteFailure);
      const next = (payload as { cfg: Record<string, unknown> }).cfg;
      for (const key of Object.keys(stationConfig)) delete stationConfig[key];
      Object.assign(stationConfig, next);
      return Promise.resolve(undefined);
    }
    if (cmd === "clear_credential") {
      delete stationConfig.api_key;
      delete stationConfig.tenant_id;
      delete stationConfig.device_name;
      delete stationConfig.organization_name;
      delete stationConfig.line_id;
      delete stationConfig.line_name;
      return Promise.resolve(undefined);
    }
    if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
    if (cmd === "plugin:sql|execute") {
      const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
      // Mirrors `ackThrough` (outbox.ts): drops every seeded row up to and
      // including the acknowledged id, so a subsequent `readBatch` genuinely
      // sees an empty queue instead of resending the same batch forever.
      if (query.includes("DELETE FROM outbox")) {
        const maxId = values?.[0] as number;
        for (let i = outbox.length - 1; i >= 0; i--) {
          if (outbox[i]!.id <= maxId) outbox.splice(i, 1);
        }
      }
      // Mirrors `recordConflicts`'s upsert (conflicts.ts): keyed by
      // code_hash, same as the real `ON CONFLICT(code_hash) DO NOTHING`.
      if (query.includes("INSERT INTO conflicts_mirror")) {
        const [codeHash, winningTerminalId, winningScannedAt, detectedAt] = (values ?? []) as [
          string,
          string | null,
          string,
          string,
        ];
        if (!conflicts.some((c) => c.code_hash === codeHash)) {
          conflicts.push({
            code_hash: codeHash,
            winning_terminal_id: winningTerminalId,
            winning_scanned_at: winningScannedAt,
            detected_at: detectedAt,
          });
        }
      }
      return Promise.resolve([0, 0]);
    }
    if (cmd === "plugin:sql|select") {
      const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
      if (query.includes("AS scans")) {
        if (recoverySnapshotFailure) return Promise.reject(recoverySnapshotFailure);
        return Promise.resolve([{ scans: outbox.length, boxes: 0, exceptions: 0 }]);
      }
      // Checked before every other branch: none of the other queries below
      // reference the outbox table, so matching on it first is just the
      // narrowest check, not a correctness requirement.
      if (query.includes("FROM outbox")) {
        if (query.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ n: outbox.length }]);
        if (query.startsWith("SELECT scanned_at")) {
          return Promise.resolve(outbox.length ? [{ scanned_at: outbox[0]!.scanned_at }] : []);
        }
        return Promise.resolve(outbox);
      }
      // `conflictCount` (its own COUNT statement) and `readConflicts` (a
      // LEFT JOIN against `codes_mirror`, aliased `conflicts_mirror c`) both
      // reference this table -- neither is asserted on by name elsewhere in
      // this mock, so one branch answers both.
      if (query.includes("FROM conflicts_mirror")) {
        if (query.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ n: conflicts.length }]);
        return Promise.resolve(conflicts.map((c) => ({ ...c, gtin14: null, serial: null })));
      }
      // Checked BEFORE the `station_meta` branch below: `readOperatorsMirror`
      // resolves the active slot and reads its rows in one statement (see
      // mirror.ts), so its query text references `station_meta` too (a
      // correlated subquery gating each `UNION ALL` branch) alongside the
      // `operators_mirror` columns. A `station_meta`-first check would
      // misroute that single statement into the branch below and answer it
      // with `[]`, never reaching the operator row. Word boundary so this
      // matches `operators_mirror` only, not `operators_mirror_b` (the
      // roster-sync's inactive slot) — see the F3 test above for the same
      // discipline.
      if (/FROM operators_mirror\b/.test(query)) {
        return Promise.resolve([operatorMirrorRow(pinHash)]);
      }
      if (query.includes("station_meta")) {
        if (values?.[0] === "hardware_config") {
          return Promise.resolve([{ value: JSON.stringify(hardwareConfig) }]);
        }
        // The sync engine's install id (Finding 3): answered as already
        // persisted so `getInstallId` returns on its first SELECT and never
        // needs the INSERT round-trip this ad hoc mock does not actually
        // persist. No test in this file cares about the exact value, only
        // that a batchId gets built at all.
        if (values?.[0] === "install_id") return Promise.resolve([{ value: "test-install-id" }]);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve(undefined);
  });
  return outbox;
}

function clickDigits(value: string) {
  for (const ch of value) {
    fireEvent.click(screen.getByRole("button", { name: ch }));
  }
}

/** Drives the real badge-first OperatorLogin fallback to reach the floor stage. */
async function signInAsOperator(login = OPERATOR_LOGIN, pin = OPERATOR_PIN) {
  await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Use personnel number" }));
  clickDigits(login);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  clickDigits(pin);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("scanner-status")).toBeDefined());
}

/**
 * Opens the re-pair confirmation from an already-visible Workstation setup.
 *
 * `findByRole` alone is not enough here, and the difference is not cosmetic:
 * WorkstationSetup renders the footer's «Re-pair this station» button on its
 * very first commit but holds it `disabled={busy || loading}`, and `loading`
 * starts `true` and only clears when the screen's own `loadHardwareConfig(exec)`
 * read resolves -- a mirror read that goes through the invoke mock, i.e. at
 * least one full turn after the button appears. React does not dispatch click
 * events to a disabled form control, so a click fired inside that window is not
 * delayed, it is DROPPED: `resetConfirmationOpen` never flips, the
 * confirmation dialog never mounts, and the synchronous query for its
 * «Remove credentials and re-pair» button fails outright. Nothing re-delivers
 * the click, so waiting afterwards cannot recover it.
 *
 * On an idle machine the config read has almost always settled by the time
 * `findByRole`'s first poll runs, which is why this only ever failed on a
 * loaded runner. Waiting for the control to be ENABLED asserts the same thing
 * the click assumed, just awaited instead of assumed.
 */
async function openResetCredentialConfirmation() {
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Re-pair this station" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Re-pair this station" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove credentials and re-pair" }));
}

/**
 * Expands the floor status panel, waiting for the auto-collapse to settle first.
 *
 * `FloorShell` only offers the collapse toggle once the panel is collapsible at
 * all (`statusBarCollapsible && shiftLabel !== null`), and it drives the
 * automatic collapse from a PASSIVE EFFECT that fires the first time
 * `shiftLabel` turns non-null. The rest of the floor -- the «Pause» button, box
 * progress -- commits BEFORE that, so having awaited one of those proves
 * nothing about this.
 *
 * The old synchronous `queryByRole` therefore raced the effect twice over: it
 * could run before the toggle existed at all, or on the one commit where the
 * toggle is present but the panel has not collapsed yet. Either way it matched
 * nothing and returned having done nothing -- and the panel then collapsed a
 * moment later, taking the operator name and the «Change operator» control with
 * it (`StatusBar` renders both only while expanded), so the caller's very next
 * query failed. Nothing re-expands it, so waiting afterwards cannot recover.
 *
 * `findByRole` waits for the toggle to exist; `await act(async () => {})` then
 * closes the second window by construction. React flushes passive effects
 * through the scheduler's `setImmediate` (check phase) while RTL's async
 * wrapper hands control back after a `setTimeout(..., 0)` (timers phase), and
 * timers run first -- so on a loaded runner `findByRole` can resume with the
 * collapse still pending. `act` is resumed via `setImmediate` too, so it is
 * queued strictly BEHIND that flush and cannot overtake it. The expand click
 * itself is unchanged, and still conditional.
 */
async function expandStatusPanelIfCollapsed(language: "en" | "ru" = "en") {
  const expandLabel = language === "ru" ? "Развернуть панель состояния" : "Expand status panel";
  const collapseLabel = language === "ru" ? "Свернуть панель состояния" : "Collapse status panel";
  await screen.findByRole("button", {
    name: (name: string) => name === expandLabel || name === collapseLabel,
  });
  await act(async () => {});
  const button = screen.queryByRole("button", { name: expandLabel });
  if (button) fireEvent.click(button);
}

async function mockBackfilledActiveShiftRecovery(pinHash: string) {
  const db = new DatabaseSync(":memory:");
  const exec = {
    async run(sql: string, values: unknown[] = []) {
      db.prepare(sql).run(...(values as never[]));
    },
    async all<T>(sql: string, values: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(values as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  await exec.run(
    `INSERT INTO operators_mirror
       (operator_id, name, login, role, pin_hash, badge_hash, active)
     VALUES (?,?,?,?,?,?,?)`,
    ["op1", "Ivan", OPERATOR_LOGIN, "operator", pinHash, null, 1],
  );
  await exec.run(
    `INSERT INTO product_mirror
       (id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
        default_counterparty_id, default_label_template_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ["product-1", "04600000000015", "Cola", null, 10, null, "active", null, null],
  );
  await exec.run(
    `INSERT INTO shift_mirror
       (id, status, mode, product_id, product_name, box_capacity, pallets_enabled,
        issuer_prefix, box_label_template_spec)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ["shift-1", "active", "aggregation", "product-1", "Cola", 10, 0, "460123456", null],
  );
  await exec.run(
    `INSERT INTO boxes_mirror
       (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, closed_by,
        print_state, print_error_code)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      "fixed-box-id",
      "shift-1",
      "device-1",
      "046012345600000016",
      "2026-08-14T08:00:00.000Z",
      "2026-08-14T08:10:00.000Z",
      "op1",
      "pending",
      null,
    ],
  );
  await exec.run(
    `INSERT INTO codes_mirror
       (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
     VALUES (?,?,?,?,?,?)`,
    [
      "fixed-code-hash",
      "shift-1",
      "04600000000015",
      "5Ab1",
      "2026-08-14T08:05:00.000Z",
      "fixed-box-id",
    ],
  );
  await exec.run(
    `INSERT INTO scan_events_mirror
       (shift_id, terminal_id, raw, verdict, scanned_at, operator_id)
     VALUES (?,?,?,?,?,?)`,
    ["shift-1", "device-1", FIRST_KM, "ok", "2026-08-14T08:05:00.000Z", "op1"],
  );
  await exec.run(
    `INSERT INTO outbox
       (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial, box_id,
        operator_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      "shift-1",
      "device-1",
      FIRST_KM,
      "ok",
      "2026-08-14T08:05:00.000Z",
      "fixed-code-hash",
      "04600000000015",
      "5Ab1",
      "fixed-box-id",
      "op1",
    ],
  );
  await exec.run(
    `INSERT INTO sscc_pool
       (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
     VALUES (?,?,?,?,?)`,
    ["460123456", 0, 1, 100, 2],
  );
  await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [
    "hardware_config",
    JSON.stringify({
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    }),
  ]);
  await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [
    "install_id",
    "test-install-id",
  ]);

  const persistedConfig = {
    machine_id: "m1",
    device_id: "device-1",
    api_key: "mk_key",
    server_url: "https://api.factory.example",
  };
  const executed: Array<{ query: string; values: unknown[] }> = [];
  invokeMock.mockImplementation(async (cmd: string, payload?: unknown): Promise<unknown> => {
    if (cmd === "read_config") return persistedConfig;
    if (cmd === "plugin:sql|load") return "sqlite:station-mirror.db";
    if (cmd === "plugin:sql|execute") {
      const { query, values = [] } = (payload ?? {}) as { query: string; values?: unknown[] };
      executed.push({ query, values });
      db.prepare(query).run(...(values as never[]));
      return [0, 0];
    }
    if (cmd === "plugin:sql|select") {
      const { query, values = [] } = (payload ?? {}) as { query: string; values?: unknown[] };
      return db.prepare(query).all(...(values as never[]));
    }
    return undefined;
  });
  return { exec, executed };
}

async function expectEmptyQueueCredentialRecovery(
  persistedConfig: Record<string, unknown>,
  outbox: OutboxSeedRow[],
): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("sealed-work-summary")).toBeDefined());
  expect(screen.getByTestId("sealed-work-summary").textContent).toBe(
    "Unsynchronized work is sealed on this station: 0 scans, 0 boxes, 0 corrections.",
  );
  expect(screen.queryByTestId("scanner-status")).toBeNull();
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clear_credential")).toHaveLength(1);
  expect(outbox).toEqual([]);
  expect(persistedConfig).toEqual({
    machine_id: "m1",
    device_id: "device-1",
    server_url: "https://api.factory.example",
  });
  const destructiveFactWrites = invokeMock.mock.calls.filter(([cmd, payload]) => {
    if (cmd !== "plugin:sql|execute") return false;
    const query = (((payload ?? {}) as { query?: string }).query ?? "").trimStart();
    return /^DELETE FROM (outbox|codes_mirror|scan_events_mirror|boxes_mirror|box_exceptions_mirror|conflicts_mirror|sscc_pool)/.test(
      query,
    );
  });
  expect(destructiveFactWrites).toEqual([]);
}

/**
 * Reaches the floor stage (enrolled config + signed-in operator, no serial
 * scanner configured) with one outbox row already queued, and a `fetch` stub
 * that answers every request the sync engine and the roster sync make.
 * Returns the mutable outbox array (`mockInvokeForFloor`'s), so a test can
 * push more rows into it later to simulate a fresh scan.
 *
 * The first `/station/scans` attempt deliberately fails (mirroring the F3
 * roster-retry test above), which schedules the engine's own backoff retry.
 *
 * IMPORTANT coupling with `BACKOFF_START_MS` (sync.ts): since `nudge()` no
 * longer starts a fresh drain while a retry is already scheduled (the
 * Finding 1 backoff fix — a nudge racing that window used to be the ONLY way
 * to prove the `online` listener actually calls `nudge()`, rather than
 * merely restating that the engine retries on its own), a test that wants to
 * prove the listener wiring works must first wait past this window — until
 * the engine's own retry has fired and settled the queue — before doing
 * anything that depends on a nudge starting a NEW drain. See the "nudges the
 * sync engine when the device comes back online" test below.
 */
async function renderAtFloorStage(
  opts: { onPost?: (path: string, body: unknown) => void; strictMode?: boolean } = {},
) {
  const pinHash = await hashSecret(OPERATOR_PIN);
  const outbox = mockInvokeForFloor(
    pinHash,
    { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
    [outboxRow(1)],
  );

  let scansAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      const path = new URL(url).pathname;
      const body: unknown = init.body ? JSON.parse(init.body as string) : undefined;
      opts.onPost?.(path, body);
      if (path === "/station/scans") {
        scansAttempts += 1;
        if (scansAttempts === 1) throw new Error("station: simulated network blip");
        const items = (body as { items: unknown[] }).items;
        return new Response(JSON.stringify({ applied: items.length, alreadyApplied: false }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }),
  );

  render(
    opts.strictMode ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  );
  await signInAsOperator();
  return outbox;
}

async function renderActiveShiftForOperatorSwitch(
  pendingBoxPrint = false,
  productionDate: string | null = null,
) {
  lockdownMock.snapshot = { mode: "locked", pending: false, error: null };
  lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
  const firstPinHash = await hashSecret(OPERATOR_PIN);
  const secondPinHash = await hashSecret(SECOND_OPERATOR_PIN);
  const hardwareConfig: HardwareConfig = {
    scanner: { port: "COM7", baud: 9600 },
    printer: null,
    printerLanguage: "zpl",
    verifyPrintedLabel: false,
  };
  mockInvokeForFloor(firstPinHash, hardwareConfig);
  const baseInvoke = invokeMock.getMockImplementation();
  if (!baseInvoke) throw new Error("floor invoke mock is unavailable");

  let releaseFirstJournal!: () => void;
  let markFirstJournalStarted!: () => void;
  const firstJournalGate = new Promise<void>((resolve) => {
    releaseFirstJournal = resolve;
  });
  const firstJournalStarted = new Promise<void>((resolve) => {
    markFirstJournalStarted = resolve;
  });
  const journalOperatorIds: string[] = [];
  const outboxOperatorIds: string[] = [];
  const postPaths: string[] = [];
  let boxItemCount = 3;

  invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
    if (cmd === "plugin:sql|select") {
      const { query } = (payload ?? {}) as { query: string; values?: unknown[] };
      if (/FROM operators_mirror\b/.test(query)) {
        return Promise.resolve([
          operatorMirrorRow(firstPinHash),
          operatorMirrorRow(secondPinHash, {
            operatorId: "op2",
            name: "Maria",
            login: SECOND_OPERATOR_LOGIN,
          }),
        ]);
      }
      if (pendingBoxPrint && query.includes("b.print_state = 'pending'")) {
        return Promise.resolve([
          {
            box_id: "box-closed",
            sscc: "046012345600000016",
            item_count: 10,
            print_state: "pending",
            print_error_code: "printer_unconfigured",
          },
        ]);
      }
      if (query.includes("FROM boxes_mirror") && query.includes("closed_at IS NULL")) {
        return Promise.resolve([
          {
            box_id: "box-open",
            shift_id: "shift-1",
            sscc: null,
            opened_at: "2026-08-13T08:00:00.000Z",
            closed_at: null,
            item_count: boxItemCount,
          },
        ]);
      }
      if (query.includes("FROM boxes_mirror")) return Promise.resolve([]);
      if (query.includes("product_mirror")) {
        return Promise.resolve([
          {
            gtin14: "04600000000015",
            name: "Cola",
            counterparty_name: null,
            production_date: productionDate,
          },
        ]);
      }
      if (query.includes("FROM shift_mirror WHERE")) {
        return Promise.resolve([
          {
            id: "shift-1",
            status: "active",
            mode: "aggregation",
            counterparty_gln: null,
            label_template_spec: null,
            box_capacity: 10,
            issuer_prefix: "460123456",
            box_label_template_spec: pendingBoxPrint
              ? JSON.stringify({
                  widthMm: 58,
                  heightMm: 40,
                  dpi: 203,
                  language: "zpl",
                  elements: [
                    {
                      id: "sscc",
                      kind: "field",
                      field: "sscc",
                      xMm: 4,
                      yMm: 4,
                      fontSizePt: 10,
                    },
                  ],
                })
              : null,
          },
        ]);
      }
      if (query.includes("FROM codes_mirror")) return Promise.resolve([]);
    }
    if (cmd === "plugin:sql|execute") {
      const { query, values = [] } = (payload ?? {}) as { query: string; values?: unknown[] };
      if (query.includes("INSERT INTO codes_mirror")) boxItemCount += 1;
      if (query.includes("INSERT INTO scan_events_mirror")) {
        journalOperatorIds.push(values[5] as string);
        if (journalOperatorIds.length === 1) {
          markFirstJournalStarted();
          return firstJournalGate;
        }
      }
      if (query.includes("INSERT INTO outbox")) outboxOperatorIds.push(values[9] as string);
    }
    return baseInvoke(cmd, payload);
  });

  let scanListener: (raw: string) => void = () => {};
  hardwareMock.onScan.mockImplementation(async (listener) => {
    scanListener = listener;
    return () => {
      if (scanListener === listener) scanListener = () => {};
    };
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST") postPaths.push(path);
      if (path === "/shifts" && method === "GET") {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "shift-1",
                status: "planned",
                mode: "aggregation",
                productName: "Cola",
                plannedQty: 10,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === "/shifts/shift-1/open" && method === "POST") {
        return new Response(
          JSON.stringify({ id: "shift-1", status: "active", mode: "aggregation" }),
          { status: 200 },
        );
      }
      if (path === "/station/scans" && method === "POST") {
        return new Response(JSON.stringify({ applied: 0, alreadyApplied: false }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }),
  );

  render(<App />);
  await signInAsOperator();
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeDefined());
  await expandStatusPanelIfCollapsed();
  if (pendingBoxPrint) {
    await screen.findByText("Printer is not configured");
  } else {
    await waitFor(() => expect(screen.getByTestId("box-progress").textContent).toBe("3 / 10"));
    await screen.findByRole("button", { name: "Change operator" });
  }

  return {
    emitScan(raw: string) {
      scanListener(raw);
    },
    captureScanListener() {
      return scanListener;
    },
    firstJournalStarted,
    releaseFirstJournal,
    journalOperatorIds,
    outboxOperatorIds,
    postPaths,
  };
}

describe("station updater shift lifecycle", () => {
  it("keeps shift entry blocked until Back cancellation settles an active update download", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lockdownMock.snapshot = { mode: "locked", pending: false, error: null };
      lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
      lockdownMock.subscribe.mockImplementation((listener) => {
        lockdownMock.listeners.add(listener);
        return () => lockdownMock.listeners.delete(listener);
      });
      lockdownMock.start.mockReturnValue(() => {});
      const pinHash = await hashSecret(OPERATOR_PIN);
      mockInvokeForFloor(pinHash, {
        scanner: null,
        printer: null,
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      });
      const baseInvoke = invokeMock.getMockImplementation();
      if (!baseInvoke) throw new Error("floor invoke mock is unavailable");
      const closeActive = deferred<unknown>();
      const download = deferred<unknown>();
      let checkCount = 0;
      invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
        if (cmd === "station_update_check") {
          checkCount += 1;
          return Promise.resolve({
            candidateId: checkCount === 1 ? "candidate-visible" : "candidate-installing",
            currentVersion: "0.1.0-beta.1",
            version: "0.1.0-beta.2",
            publishedAt: "2026-08-11T00:00:00.000Z",
            selectedOrigin: "yandex",
            fallbackReason: null,
          });
        }
        if (cmd === "station_update_download_and_install") return download.promise;
        if (cmd === "station_update_close") {
          const candidateId = (payload as { request?: { candidateId?: string } })?.request
            ?.candidateId;
          return candidateId === "candidate-installing"
            ? closeActive.promise
            : Promise.resolve(null);
        }
        return baseInvoke(cmd, payload);
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/shifts" && (init?.method ?? "GET") === "GET") {
            return new Response(
              JSON.stringify({
                items: [
                  {
                    id: "shift-1",
                    status: "active",
                    mode: "validation",
                    productName: "Cola",
                    plannedQty: null,
                    productId: "product-1",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (path === "/station/scans" && init?.method === "POST") {
            return new Response(JSON.stringify({ applied: 0, alreadyApplied: false }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();
      fireEvent.click(await screen.findByRole("button", { name: /Update/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Download and install" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
      await waitFor(() =>
        expect(
          invokeMock.mock.calls.some(
            ([command]) => command === "station_update_download_and_install",
          ),
        ).toBe(true),
      );

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      const rejoin = await screen.findByRole("button", { name: "Rejoin" });
      fireEvent.click(rejoin);

      await waitFor(() => expect((rejoin as HTMLButtonElement).disabled).toBe(true));
      expect(screen.queryByText("Preparing the shift…")).toBeNull();

      closeActive.resolve(null);
      download.reject({ code: "installation-failed", retryable: false });
      await waitFor(() => expect(screen.getByText("Preparing the shift…")).toBeDefined());
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "station_update_download_and_install",
        ),
      ).toHaveLength(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("holds one lease from updater cancellation through planned activation and local publish", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lockdownMock.snapshot = { mode: "locked", pending: false, error: null };
      lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
      lockdownMock.subscribe.mockImplementation((listener) => {
        lockdownMock.listeners.add(listener);
        return () => lockdownMock.listeners.delete(listener);
      });
      lockdownMock.start.mockReturnValue(() => {});
      const pinHash = await hashSecret(OPERATOR_PIN);
      mockInvokeForFloor(pinHash, {
        scanner: null,
        printer: null,
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      });
      const baseInvoke = invokeMock.getMockImplementation();
      if (!baseInvoke) throw new Error("floor invoke mock is unavailable");
      const cancellation = deferred<unknown>();
      invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
        if (cmd === "station_update_check") {
          return Promise.resolve({
            candidateId: "candidate-before-shift",
            currentVersion: "0.1.0-beta.1",
            version: "0.1.0-beta.2",
            publishedAt: "2026-08-11T00:00:00.000Z",
            selectedOrigin: "yandex",
            fallbackReason: null,
          });
        }
        if (cmd === "station_update_close") return cancellation.promise;
        if (cmd === "station_update_download_and_install") {
          throw new Error("install must remain unreachable while entering a shift");
        }
        return baseInvoke(cmd, payload);
      });
      const openShift = deferred<Response>();
      let openCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/shifts" && (init?.method ?? "GET") === "GET") {
            return new Response(
              JSON.stringify({
                items: [
                  {
                    id: "shift-1",
                    status: "planned",
                    mode: "validation",
                    productName: "Cola",
                    plannedQty: null,
                    productId: "product-1",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (path === "/shifts/shift-1/open" && init?.method === "POST") {
            openCalls += 1;
            return openShift.promise;
          }
          if (path === "/station/scans" && init?.method === "POST") {
            return new Response(JSON.stringify({ applied: 0, alreadyApplied: false }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();
      await screen.findByRole("button", { name: /Update 0\.1\.0-beta\.2/ });
      fireEvent.click(await screen.findByRole("button", { name: "Open" }));

      await waitFor(() =>
        expect(
          invokeMock.mock.calls.filter(([command]) => command === "station_update_close"),
        ).toHaveLength(1),
      );
      expect(openCalls).toBe(0);
      cancellation.resolve(null);
      await waitFor(() => expect(openCalls).toBe(1));

      const updateButton = screen.getByRole("button", {
        name: /Update 0\.1\.0-beta\.2/,
      }) as HTMLButtonElement;
      const operatorButton = screen.getByRole("button", {
        name: "Saving the current operation…",
      }) as HTMLButtonElement;
      const newShiftButton = screen.getByRole("button", { name: "New shift" }) as HTMLButtonElement;
      expect(updateButton.disabled).toBe(true);
      expect(operatorButton.disabled).toBe(true);
      expect(newShiftButton.disabled).toBe(true);
      fireEvent.click(updateButton);
      fireEvent.click(operatorButton);
      fireEvent.click(newShiftButton);
      expect(screen.queryByText("Station updates")).toBeNull();
      expect(screen.queryByTestId("new-shift-input")).toBeNull();
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "station_update_check"),
      ).toHaveLength(1);
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "station_update_download_and_install",
        ),
      ).toHaveLength(0);

      openShift.resolve(
        new Response(JSON.stringify({ id: "shift-1", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );
      await waitFor(() => expect(screen.getByText("Preparing the shift…")).toBeDefined());
      const statusPanelToggle = screen.getByRole("button", { name: /status panel/ });
      if (statusPanelToggle.getAttribute("aria-expanded") === "false") {
        fireEvent.click(statusPanelToggle);
      }
      const releasedOperatorButton = screen.getByRole("button", {
        name: "Change operator",
      }) as HTMLButtonElement;
      expect(releasedOperatorButton.disabled).toBe(false);
      expect(openCalls).toBe(1);
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "station_update_close"),
      ).toHaveLength(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("nextStationView", () => {
  it("routes to loading while config has not been read yet", () => {
    expect(nextStationView(null, null)).toBe("loading");
  });

  it("routes an unpaired first-run device to pairing", () => {
    expect(nextStationView({ machineId: "m1" }, null)).toBe("pairing");
  });

  it("routes a durable device without a credential to recovery pairing", () => {
    expect(nextStationView({ machineId: "m1", deviceId: "device-1" }, null)).toBe("pairing");
  });

  it("routes to login once enrolled but no operator is signed in", () => {
    expect(nextStationView(enrolledConfig, null)).toBe("login");
  });

  it("routes to the floor once enrolled and an operator is signed in", () => {
    expect(nextStationView(enrolledConfig, operator)).toBe("floor");
  });
});

describe("pairingServerUrl", () => {
  it("uses the trusted build API base for a fresh station, never the webview origin", () => {
    expect(pairingServerUrl({ machineId: "m1" }, "https://api.factory.example/")).toBe(
      "https://api.factory.example",
    );
  });

  it("keeps the persisted API base for durable credential recovery", () => {
    const credentialClearedConfig: StationConfig = {
      machineId: "m1",
      deviceId: "device-1",
      serverUrl: "https://recovery.factory.example",
    };
    expect(nextStationView(credentialClearedConfig, null)).toBe("pairing");
    expect(pairingServerUrl(credentialClearedConfig, "https://api.factory.example")).toBe(
      "https://recovery.factory.example",
    );
  });

  it("refuses a missing or unsafe build base instead of falling back to location.origin", () => {
    expect(pairingServerUrl({ machineId: "m1" }, undefined)).toBeNull();
    expect(pairingServerUrl({ machineId: "m1" }, "https://operator:secret@api.example")).toBeNull();
  });
});

describe("App", () => {
  it("keeps fullscreen while workstation setup opens and closes", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );

    render(<App />);
    await signInAsOperator();

    expect(lockdownMock.start).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    expect(await screen.findByRole("heading", { name: "Workstation setup" })).toBeDefined();
    expect(lockdownMock.exit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeDefined();

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(lockdownMock.enter).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeDefined();
    expect(screen.getByText("Ivan")).toBeDefined();

    lockdownMock.exit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(lockdownMock.exit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Return to fullscreen" })).toBeDefined();
    expect(screen.getByText("Ivan")).toBeDefined();
  });

  it("keeps windowed mode while workstation setup opens and closes", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Return to fullscreen" })).toBeDefined(),
    );
    lockdownMock.enter.mockClear();
    lockdownMock.exit.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));

    expect(lockdownMock.exit).not.toHaveBeenCalled();
    expect(lockdownMock.enter).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Return to fullscreen" })).toBeDefined();
  });

  it("does not change the window after a failed fullscreen attempt when setup opens", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    lockdownMock.snapshot = { mode: "windowed", pending: false, error: "enter" };

    render(<App />);
    await signInAsOperator();
    lockdownMock.enter.mockClear();
    lockdownMock.exit.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));

    expect(await screen.findByRole("heading", { name: "Workstation setup" })).toBeDefined();
    expect(lockdownMock.exit).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(lockdownMock.enter).not.toHaveBeenCalled();
  });

  it("renders Enrollment when readConfig resolves an un-enrolled config", async () => {
    vi.stubEnv("VITE_STATION_API_URL", "https://api.factory.example");
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
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeDefined();
  });

  it("confirms active-shift exit without replacing the shift screen", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pinHash = await hashSecret(OPERATOR_PIN);
      mockInvokeForFloor(pinHash, {
        scanner: null,
        printer: null,
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          if (path === "/shifts" && init?.method !== "POST") {
            return new Response(
              JSON.stringify({
                items: [
                  {
                    id: "shift-1",
                    status: "planned",
                    mode: "validation",
                    productName: "Product",
                    plannedQty: 10,
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (path === "/shifts/shift-1/open" && init?.method === "POST") {
            return new Response(
              JSON.stringify({ id: "shift-1", status: "active", mode: "validation" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();
      fireEvent.click(await screen.findByRole("button", { name: "Open" }));
      await waitFor(() => expect(screen.getByText("Preparing the shift…")).toBeDefined());
      lockdownMock.exit.mockClear();

      fireEvent.click(await screen.findByRole("button", { name: "Expand status panel" }));
      fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
      expect(lockdownMock.exit).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Exit fullscreen?" })).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Confirm exit fullscreen" }));
      expect(lockdownMock.exit).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Preparing the shift…")).toBeDefined();
      expect(screen.getByText("Ivan")).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("returns from an idle floor to badge login without clearing credentials or queued work", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lockdownMock.snapshot = { mode: "locked", pending: false, error: null };
      lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
      const pinHash = await hashSecret(OPERATOR_PIN);
      const queued = mockInvokeForFloor(
        pinHash,
        { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
        [outboxRow(1)],
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (new URL(url).pathname === "/station/scans" && init?.method === "POST") {
            throw new Error("keep durable outbox pending");
          }
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();
      fireEvent.click(screen.getByRole("button", { name: "Change operator" }));

      await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
      expect(screen.getByText("Scan your badge to sign in")).toBeDefined();
      expect(queued).toHaveLength(1);
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "clear_credential")).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("locks the operator after ten inactive minutes without clearing credentials or queued work", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const queued = await renderAtFloorStage();
      vi.useFakeTimers();
      fireEvent.pointerDown(window);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPERATOR_IDLE_TIMEOUT_MS - 1);
      });
      expect(screen.queryByText("Operator sign-in")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText("Operator sign-in")).toBeDefined();
      expect(queued).toHaveLength(1);
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "clear_credential")).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("forwards the mirrored production date from App into WorkScreen", async () => {
    const ActualWorkScreen = WorkScreenModule.WorkScreen;
    const observedProductionDates: Array<string | null | undefined> = [];
    const workScreenSpy = vi.spyOn(WorkScreenModule, "WorkScreen").mockImplementation((props) => {
      observedProductionDates.push(props.productionDate);
      return <ActualWorkScreen {...props} />;
    });

    try {
      await renderActiveShiftForOperatorSwitch(false, "2026-08-20");
      await waitFor(() => expect(observedProductionDates).toContain("2026-08-20"));
    } finally {
      workScreenSpy.mockRestore();
    }
  });

  it("drains accepted local work, resumes the same shift and open box, and changes journal attribution", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const floor = await renderActiveShiftForOperatorSwitch();

      act(() => floor.emitScan(FIRST_KM));
      await floor.firstJournalStarted;
      fireEvent.click(screen.getByRole("button", { name: "Change operator" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Change operator?" })).getByRole("button", {
          name: "Change operator",
        }),
      );

      expect(screen.queryByText("Operator sign-in")).toBeNull();
      expect(screen.getByTestId("operator-switch-settling").textContent).toContain(
        "Saving the current operation…",
      );
      floor.releaseFirstJournal();
      await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());

      await signInAsOperator(SECOND_OPERATOR_LOGIN, SECOND_OPERATOR_PIN);
      expect(await screen.findByRole("button", { name: "Pause" })).toBeDefined();
      await expandStatusPanelIfCollapsed();
      expect(screen.getByText("Maria")).toBeDefined();
      await waitFor(() => expect(screen.getByTestId("box-progress").textContent).toBe("4 / 10"));
      const counters = within(screen.getByRole("region", { name: "Accepted, Rejected" }));
      expect(counters.getAllByRole("definition")[0]?.textContent).toBe("0");

      act(() => floor.emitScan(SECOND_KM));
      await waitFor(() => expect(floor.journalOperatorIds).toEqual(["op1", "op2"]));
      expect(floor.outboxOperatorIds).toEqual(["op1", "op2"]);
      expect(floor.postPaths.some((path) => path.endsWith("/close"))).toBe(false);
      expect(counters.getAllByRole("definition")[0]?.textContent).toBe("1");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("auto-locks safely and lets another operator resume the same shift and open box", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const floor = await renderActiveShiftForOperatorSwitch();
      vi.useFakeTimers();
      fireEvent.pointerDown(window);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPERATOR_IDLE_TIMEOUT_MS - 1);
      });

      act(() => floor.emitScan(FIRST_KM));
      await floor.firstJournalStarted;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPERATOR_IDLE_TIMEOUT_MS - 1);
      });
      expect(screen.queryByText("Operator sign-in")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText("Operator sign-in")).toBeNull();
      expect(screen.getByTestId("operator-switch-settling").textContent).toContain(
        "Saving the current operation…",
      );

      floor.releaseFirstJournal();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("Operator sign-in")).toBeDefined();

      vi.useRealTimers();
      await signInAsOperator(SECOND_OPERATOR_LOGIN, SECOND_OPERATOR_PIN);
      expect(await screen.findByRole("button", { name: "Pause" })).toBeDefined();
      await expandStatusPanelIfCollapsed();
      expect(screen.getByText("Maria")).toBeDefined();
      await waitFor(() => expect(screen.getByTestId("box-progress").textContent).toBe("4 / 10"));

      act(() => floor.emitScan(SECOND_KM));
      await waitFor(() => expect(floor.journalOperatorIds).toEqual(["op1", "op2"]));
      expect(floor.outboxOperatorIds).toEqual(["op1", "op2"]);
      expect(floor.postPaths.some((path) => path.endsWith("/close"))).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("disables every floor header action while accepted local work settles", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const floor = await renderActiveShiftForOperatorSwitch();
      act(() => floor.emitScan(FIRST_KM));
      await floor.firstJournalStarted;
      lockdownMock.exit.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Change operator" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Change operator?" })).getByRole("button", {
          name: "Change operator",
        }),
      );

      const update = screen.getByRole("button", { name: "↻ Updates" });
      const operatorSwitch = screen.getByRole("button", {
        name: "Saving the current operation…",
      });
      const windowMode = screen.getByRole("button", { name: "Exit fullscreen" });
      expect((update as HTMLButtonElement).disabled).toBe(true);
      expect((operatorSwitch as HTMLButtonElement).disabled).toBe(true);
      expect((windowMode as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(update);
      fireEvent.click(operatorSwitch);
      fireEvent.click(windowMode);
      expect(screen.queryByRole("heading", { name: "Station updates" })).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Exit fullscreen?" })).toBeNull();
      expect(lockdownMock.exit).not.toHaveBeenCalled();

      floor.releaseFirstJournal();
      await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("locks ordinary floor navigation during print recovery but keeps printer setup available", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await renderActiveShiftForOperatorSwitch(true);
      expect(await screen.findByText("Printer is not configured")).toBeDefined();

      expect(
        (screen.getByRole("button", { name: "↻ Updates" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Saving the current operation…" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Exit fullscreen" }) as HTMLButtonElement).disabled,
      ).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Set up printer" }));
      expect(await screen.findByRole("heading", { name: "Workstation setup" })).toBeDefined();
      expect(
        (screen.getByRole("button", { name: "↻ Updates" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Saving the current operation…" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: /fullscreen/ }) as HTMLButtonElement).disabled,
      ).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(await screen.findByText("Printer is not configured")).toBeDefined();
      expect(
        (screen.getByRole("button", { name: "↻ Updates" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("refreshes a backfilled active-shift bundle offline-first and preserves the same print recovery", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
    lockdownMock.subscribe.mockImplementation((listener) => {
      lockdownMock.listeners.add(listener);
      return () => lockdownMock.listeners.delete(listener);
    });
    const pinHash = await hashSecret(OPERATOR_PIN);
    const recovery = await mockBackfilledActiveShiftRecovery(pinHash);
    const boxLabelSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [{ id: "sscc", kind: "field", field: "sscc", xMm: 4, yMm: 4, fontSizePt: 10 }],
    };
    const bundle = {
      shift: {
        id: "shift-1",
        status: "active",
        mode: "aggregation",
        productId: "product-1",
        productName: "Cola",
        lineId: null,
        lineName: null,
        counterpartyId: null,
        counterpartyName: null,
        labelTemplateId: null,
        labelTemplateName: null,
        plannedQty: null,
        plannedDate: null,
        boxCapacity: 10,
        palletCapacity: null,
        palletsEnabled: false,
        openedAt: "2026-08-14T08:00:00.000Z",
      },
      product: {
        id: "product-1",
        gtin14: "04600000000015",
        name: "Cola",
        productGroup: null,
        boxCapacity: 10,
        palletCapacity: null,
        status: "active",
        defaultCounterpartyId: null,
        defaultLabelTemplateId: null,
      },
      labelTemplate: null,
      boxLabelTemplate: { id: "template-box", name: "Box", spec: boxLabelSpec },
      counterpartyGln: null,
      operators: [],
      sscc: null,
    };
    let bundleAvailable = false;
    let referenceBundleAttempts = 0;
    let normalBundleAttempts = 0;
    let syncAttempts = 0;
    let resolveRecoveryWindowSync!: (response: Response) => void;
    let resolveResumedSync!: (response: Response) => void;
    const recoveryWindowSync = new Promise<Response>((resolve) => {
      resolveRecoveryWindowSync = resolve;
    });
    const resumedSync = new Promise<Response>((resolve) => {
      resolveResumedSync = resolve;
    });
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        paths.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/shifts" && (init?.method ?? "GET") === "GET") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "shift-1",
                  status: "active",
                  mode: "aggregation",
                  productId: "product-1",
                  productName: "Cola",
                  plannedQty: null,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (path === "/shifts/shift-1/reference-bundle") {
          referenceBundleAttempts += 1;
          if (!bundleAvailable) throw new Error("station offline");
          return new Response(JSON.stringify(bundle), { status: 200 });
        }
        if (path === "/shifts/shift-1/bundle") {
          normalBundleAttempts += 1;
          throw new Error("normal allocation bundle must not start before recovery classification");
        }
        if (path === "/station/operators") throw new Error("keep cached roster");
        if (path === "/station/scans" && init?.method === "POST") {
          syncAttempts += 1;
          return syncAttempts === 1 ? recoveryWindowSync : resumedSync;
        }
        if ((init?.method ?? "GET") === "POST") throw new Error("keep outbox pending");
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );
    const factSnapshot = async () =>
      JSON.stringify({
        boxes: await recovery.exec.all("SELECT * FROM boxes_mirror ORDER BY box_id"),
        codes: await recovery.exec.all("SELECT * FROM codes_mirror ORDER BY code_hash"),
        journal: await recovery.exec.all("SELECT * FROM scan_events_mirror ORDER BY id"),
        outbox: await recovery.exec.all("SELECT * FROM outbox ORDER BY id"),
        pool: await recovery.exec.all("SELECT * FROM sscc_pool ORDER BY issuer_prefix"),
      });
    const before = await factSnapshot();

    try {
      render(<App />);
      await waitFor(() => expect(syncAttempts).toBe(1));
      await signInAsOperator();
      await act(async () => i18n.changeLanguage("ru"));
      fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
      await expandStatusPanelIfCollapsed("ru");

      // The normal sync request is held in the network phase. Recovery may
      // neither inspect the mirror nor start either bundle path until the
      // awaited pause-and-idle barrier has retired that request.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("button", { name: "Повторить восстановление" })).toBeNull();
      expect(referenceBundleAttempts).toBe(0);
      expect(normalBundleAttempts).toBe(0);

      await act(async () => {
        resolveRecoveryWindowSync(
          new Response(JSON.stringify({ applied: 1, alreadyApplied: false }), { status: 200 }),
        );
      });
      const retry = await screen.findByRole("button", { name: "Повторить восстановление" });
      await expandStatusPanelIfCollapsed("ru");
      expect(referenceBundleAttempts).toBe(0);
      expect(normalBundleAttempts).toBe(0);
      expect(
        screen.getByRole("button", { name: "↻ Обновления" }) as HTMLButtonElement,
      ).toHaveProperty("disabled", true);
      expect(
        screen.getByRole("button", { name: "Сохраняем текущую операцию…" }) as HTMLButtonElement,
      ).toHaveProperty("disabled", true);

      for (const key of SECOND_KM) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
      fireEvent.click(retry);

      expect(
        await screen.findByText("Не удалось загрузить смены. Проверьте доступ к серверу."),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "Повторить восстановление" })).toBeDefined();
      expect(referenceBundleAttempts).toBe(1);
      expect(normalBundleAttempts).toBe(0);
      expect(await factSnapshot()).toBe(before);

      bundleAvailable = true;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Повторить восстановление" }));
      });

      expect(
        await screen.findByText("Печать была прервана. Проверьте принтер и повторите печать."),
      ).toBeDefined();
      expect(screen.getByText("046012345600000016")).toBeDefined();
      expect(screen.getByRole("button", { name: "Повторить печать" })).toBeDefined();
      expect(referenceBundleAttempts).toBe(2);
      expect(normalBundleAttempts).toBe(0);
      await waitFor(() => expect(syncAttempts).toBe(2));
      // The resumed request is deliberately still pending, proving the first
      // response could not acknowledge anything during the recovery window.
      expect(await factSnapshot()).toBe(before);
      expect(paths).not.toContain("POST /shifts/shift-1/open");
      expect(
        recovery.executed.filter(({ query }) =>
          /INSERT INTO boxes_mirror|UPDATE boxes_mirror\s+SET sscc|UPDATE sscc_pool\s+SET next_serial = next_serial \+ 1|INSERT INTO scan_events_mirror|INSERT INTO outbox/.test(
            query,
          ),
        ),
      ).toEqual([]);
      expect(
        await recovery.exec.all<{ box_id: string; sscc: string; print_state: string }>(
          "SELECT box_id, sscc, print_state FROM boxes_mirror",
        ),
      ).toEqual([
        {
          box_id: "fixed-box-id",
          sscc: "046012345600000016",
          print_state: "pending",
        },
      ]);

      resolveResumedSync(
        new Response(JSON.stringify({ applied: 1, alreadyApplied: false }), { status: 200 }),
      );
      await waitFor(async () => {
        expect(await recovery.exec.all("SELECT * FROM outbox")).toEqual([]);
      });
    } finally {
      await act(async () => i18n.changeLanguage("en"));
      consoleErrorSpy.mockRestore();
    }
  });

  it("releases the print-recovery setup latch when service reset returns to pairing", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await renderActiveShiftForOperatorSwitch(true);
      expect(await screen.findByText("Printer is not configured")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Set up printer" }));
      await openResetCredentialConfirmation();

      await waitFor(() => expect(screen.getByText("Connect station")).toBeDefined());
      expect(screen.getByRole("button", { name: /fullscreen/ })).toHaveProperty("disabled", false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps one retired queue closed through timeout and retry until its write settles", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const floor = await renderActiveShiftForOperatorSwitch();
      act(() => floor.emitScan(FIRST_KM));
      await floor.firstJournalStarted;
      act(() => {
        lockdownMock.publish({ mode: "locked", pending: false, error: "exit" });
      });
      lockdownMock.clearError.mockClear();
      const staleScannerListener = floor.captureScanListener();
      const scannerSubscriptionsBeforeSwitch = hardwareMock.onScan.mock.calls.length;
      const destructiveBefore = invokeMock.mock.calls.filter(([cmd, payload]) => {
        if (cmd === "clear_credential") return true;
        if (cmd !== "plugin:sql|execute") return false;
        const query = ((payload ?? {}) as { query?: string }).query ?? "";
        return /^\s*DELETE FROM (outbox|codes_mirror|scan_events_mirror|boxes_mirror|box_exceptions_mirror)/.test(
          query,
        );
      }).length;

      fireEvent.click(screen.getByRole("button", { name: "Change operator" }));
      vi.useFakeTimers();
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Change operator?" })).getByRole("button", {
          name: "Change operator",
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_001);
      });

      expect(screen.getByText("Ivan")).toBeDefined();
      expect(screen.queryByText("Operator sign-in")).toBeNull();
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes(
              "Could not change operator. The current operator and local work remain active.",
            ),
          ),
      ).toBe(true);
      const retryOperatorSwitch = screen.getByRole("button", {
        name: "Retry operator change",
      });
      expect((retryOperatorSwitch as HTMLButtonElement).disabled).toBe(false);
      expect(
        (screen.getByRole("button", { name: "Change operator" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "↻ Updates" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Exit fullscreen" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      const dismissWindowError = screen.getByRole("button", {
        name: "Dismiss window mode error",
      });
      expect((dismissWindowError as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(dismissWindowError);
      expect(lockdownMock.clearError).not.toHaveBeenCalled();
      expect(screen.getByTestId("operator-switch-settling")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Close shift" })).toBeNull();
      expect(hardwareMock.onScan).toHaveBeenCalledTimes(scannerSubscriptionsBeforeSwitch);

      fireEvent.click(screen.getByRole("button", { name: "Retry operator change" }));
      expect(screen.getByTestId("operator-switch-settling")).toBeDefined();
      expect(hardwareMock.onScan).toHaveBeenCalledTimes(scannerSubscriptionsBeforeSwitch);
      act(() => staleScannerListener(SECOND_KM));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(floor.journalOperatorIds).toEqual(["op1"]);

      const destructiveAfter = invokeMock.mock.calls.filter(([cmd, payload]) => {
        if (cmd === "clear_credential") return true;
        if (cmd !== "plugin:sql|execute") return false;
        const query = ((payload ?? {}) as { query?: string }).query ?? "";
        return /^\s*DELETE FROM (outbox|codes_mirror|scan_events_mirror|boxes_mirror|box_exceptions_mirror)/.test(
          query,
        );
      }).length;
      expect(destructiveAfter).toBe(destructiveBefore);
      floor.releaseFirstJournal();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
      expect(floor.journalOperatorIds).toEqual(["op1"]);
      expect(floor.outboxOperatorIds).toEqual(["op1"]);
      expect(floor.postPaths.some((path) => path.endsWith("/close"))).toBe(false);
    } finally {
      vi.useRealTimers();
      consoleErrorSpy.mockRestore();
    }
  });

  it("drives the real pairing success path to OperatorLogin, not back to pairing", async () => {
    // Mutable so a `write_config` call updates what the next `read_config`
    // resolves to. This exercises the upgrade-safe route: an enrolled bundle
    // still advances directly to operator login after a refresh.
    let rustConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      server_url: "http://localhost:3000",
    };
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (new URL(url.toString()).pathname === "/station/pair") {
        return new Response(
          JSON.stringify({
            device: {
              id: "device-1",
              name: "Packing station",
              tenantId: "tenant-1",
              organizationName: "Factory",
              line: null,
            },
            credential: { apiKey: "station-credential", serverUrl: "http://localhost:3000" },
            operators: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Connect station")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));

    await waitFor(() => expect(screen.getByText("Operator sign-in")).toBeDefined());
    expect(screen.queryByLabelText("Pairing code")).toBeNull();

    vi.restoreAllMocks();
  });

  it("retries the roster sync when the browser fires 'online' after the initial sync failed (F3)", async () => {
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "read_config") {
        return Promise.resolve({
          machine_id: "m1",
          device_id: "device-1",
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
          pinHash:
            "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
          badgeHash: null,
          active: true,
        },
      ],
    });
    let rosterRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (new URL(url).pathname !== "/station/operators") {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      rosterRequests += 1;
      return rosterRequests === 1
        ? Promise.reject(new Error("device offline"))
        : Promise.resolve(new Response(rosterBody, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // Initial sync (App mounts with a client already configured) fails.
    await waitFor(() => expect(rosterRequests).toBe(1));

    // The device comes back online -- this must trigger a second attempt.
    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(rosterRequests).toBe(2));
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

  it("coalesces startup and browser-online roster refreshes through one App refresher", async () => {
    lockdownMock.start.mockReturnValue(() => {});
    lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
    lockdownMock.subscribe.mockImplementation((listener) => {
      lockdownMock.listeners.add(listener);
      return () => lockdownMock.listeners.delete(listener);
    });
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "read_config") {
        return Promise.resolve({
          machine_id: "m1",
          device_id: "device-1",
          api_key: "mk_key",
          server_url: "http://localhost:3000",
        });
      }
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    let rosterRequests = 0;
    let resolveRoster!: (response: Response) => void;
    const fetchMock = vi.fn((url: string) => {
      if (new URL(url).pathname !== "/station/operators") {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      rosterRequests += 1;
      return new Promise<Response>((resolve) => {
        resolveRoster = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(rosterRequests).toBe(1));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });

    expect(rosterRequests).toBe(1);
    await act(async () => {
      resolveRoster(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    });
  });

  it("keeps a successful Station API response authoritative after an offline browser hint", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    let rejectInitialShifts!: (reason?: unknown) => void;
    const initialShifts = new Promise<Response>((_resolve, reject) => {
      rejectInitialShifts = reject;
    });
    let operatorRequests = 0;
    let shiftRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      if (path === "/station/operators") {
        operatorRequests += 1;
        return operatorRequests === 1
          ? Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))
          : new Promise<Response>(() => {});
      }
      if (path === "/shifts") {
        shiftRequests += 1;
        return shiftRequests === 2
          ? initialShifts
          : Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(shiftRequests).toBe(1));
    await signInAsOperator();

    expect(screen.getByTestId("server-status").textContent).toBe("Available");
    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByTestId("server-status").textContent).toBe("No connection");
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(operatorRequests).toBe(2));
    expect(screen.getByTestId("server-status").textContent).toBe("No connection");

    act(() => window.dispatchEvent(new Event("offline")));
    act(() => rejectInitialShifts(new TypeError("network")));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("server-status").textContent).toBe("Available"));
  });

  it("ignores a late reachability outcome from the client replaced by credential re-pairing", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      tenant_id: "tenant-1",
      api_key: "old-key",
      server_url: "https://api.factory.example",
    };
    mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    let rejectOldShift!: (reason?: unknown) => void;
    const oldShift = new Promise<Response>((_resolve, reject) => {
      rejectOldShift = reject;
    });
    let shiftRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        if (path === "/station/pair") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                device: {
                  id: "device-1",
                  name: "Packing station",
                  tenantId: "tenant-1",
                  organizationName: "Factory",
                  line: null,
                },
                credential: { apiKey: "new-key", serverUrl: "https://api.factory.example" },
                operators: [],
              }),
              { status: 201, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        if (path === "/shifts") {
          shiftRequests += 1;
          return shiftRequests === 1
            ? oldShift
            : Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }),
    );

    render(<App />);
    await signInAsOperator();
    await waitFor(() => expect(shiftRequests).toBe(2));
    // `shiftRequests` counts requests ISSUED. "Available" is published from the
    // client's `onReachabilityChange` when the second one SETTLES -- a React
    // state change a further turn later -- so the count proving the request went
    // out says nothing about the status bar yet. Same assertion as before, just
    // awaited, exactly like its twin further down.
    await waitFor(() => expect(screen.getByTestId("server-status").textContent).toBe("Available"));

    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    await openResetCredentialConfirmation();
    await screen.findByText("Connect station");
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));
    await signInAsOperator();
    await waitFor(() => expect(screen.getByTestId("server-status").textContent).toBe("Available"));

    await act(async () => {
      rejectOldShift(new TypeError("late old-client failure"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("server-status").textContent).toBe("Available");
  });

  it("backfills a real legacy config before sync and later recovers a 401 against the same durable device", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key-not-to-render",
      server_url: "https://api.factory.example",
    };
    const order: string[] = [];
    let backfillWrite: Record<string, unknown> | null = null;
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
      (cmd, payload) => {
        if (cmd === "write_config") {
          order.push("write-config");
          backfillWrite = (payload as { cfg: Record<string, unknown> }).cfg;
        }
      },
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path === "/station/identity") {
        order.push("identity");
        return new Response(
          JSON.stringify({
            device: {
              id: "device-legacy",
              name: "Legacy packing station",
              tenantId: "tenant-legacy",
              organizationName: "Factory",
              line: { id: "line-1", name: "Packing" },
            },
            subscription: {
              access: "read_only",
              status: "expired",
              startsAt: "2026-08-01T00:00:00.000Z",
              endsAt: "2026-08-10T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "POST" && path === "/station/scans") {
        order.push("sync");
        return new Response(JSON.stringify({ message: "revoked" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("sealed-work-summary")).toBeDefined());
    expect(order.slice(0, 3)).toEqual(["identity", "write-config", "sync"]);
    expect(backfillWrite).toMatchObject({
      machine_id: "legacy-machine",
      device_id: "device-legacy",
      api_key: "legacy-key-not-to-render",
      server_url: "https://api.factory.example",
    });
    expect(persistedConfig).toEqual({
      machine_id: "legacy-machine",
      device_id: "device-legacy",
      server_url: "https://api.factory.example",
    });
    expect(outbox).toHaveLength(1);
    expect(screen.queryByText("legacy-key-not-to-render")).toBeNull();
  });

  it.each([
    ["missing", {}],
    ["empty", { server_url: "" }],
    ["invalid", { server_url: "not a valid station API URL" }],
  ])(
    "keeps a legacy keyed config with a %s server URL out of every enrollment path",
    async (_case, serverFields) => {
      vi.stubEnv("VITE_STATION_API_URL", "");
      const pinHash = await hashSecret(OPERATOR_PIN);
      const persistedConfig: Record<string, unknown> = {
        machine_id: "legacy-machine",
        api_key: "legacy-key",
        ...serverFields,
      };
      const outbox = mockInvokeForFloor(
        pinHash,
        { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
        [outboxRow(1)],
        persistedConfig,
      );
      const originalQueue = JSON.stringify(outbox);
      const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      render(<App />);

      expect(
        await screen.findByText(
          "Station identity cannot be updated because no trusted API address is available. Local work and the device key are preserved; contact service support.",
        ),
      ).toBeDefined();
      expect(screen.queryByLabelText("Pairing code")).toBeNull();
      expect(screen.queryByLabelText("Server URL")).toBeNull();
      expect(screen.queryByLabelText("Device key")).toBeNull();
      expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("clear_credential");
      expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
      expect(persistedConfig).toEqual({
        machine_id: "legacy-machine",
        api_key: "legacy-key",
        ...serverFields,
      });
      expect(JSON.stringify(outbox)).toBe(originalQueue);
    },
  );

  it("uses and persists the canonical trusted build-time base for a partial legacy config", async () => {
    vi.stubEnv("VITE_STATION_API_URL", "https://api.factory.example/deployment/path");
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "not a valid station API URL",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    const originalQueue = JSON.stringify(outbox);
    let resolveIdentity!: (response: Response) => void;
    const fetchMock = vi.fn((url: string) => {
      if (new URL(url).pathname === "/station/identity") {
        return new Promise<Response>((resolve) => {
          resolveIdentity = resolve;
        });
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.factory.example/station/identity");
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.queryByLabelText("Device key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();

    resolveIdentity(
      new Response(
        JSON.stringify({
          device: {
            id: "legacy-device",
            name: "Legacy station",
            tenantId: "legacy-tenant",
            organizationName: "Factory",
            line: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() =>
      expect(persistedConfig).toMatchObject({
        machine_id: "legacy-machine",
        device_id: "legacy-device",
        api_key: "legacy-key",
        server_url: "https://api.factory.example",
      }),
    );
    expect(JSON.stringify(outbox)).toBe(originalQueue);
    view.unmount();
  });

  it("keeps cached floor login available while legacy identity is offline and coalesces reconnect retries", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    let resolveReconnect!: (response: Response) => void;
    const reconnect = new Promise<Response>((resolve) => {
      resolveReconnect = resolve;
    });
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(reconnect);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const degradedNotice = await screen.findByText(
      "Station identity update is waiting for a connection. Cached offline work remains available.",
    );
    const loginFooter = degradedNotice.closest(".station-floor-footer");
    expect(loginFooter).not.toBeNull();
    expect(loginFooter?.closest(".operator-login")).not.toBeNull();
    expect((loginFooter as HTMLElement).style.position).toBe("");
    expect(screen.getByRole("button", { name: "Use personnel number" })).toBeDefined();
    await signInAsOperator();
    const floorFooter = screen
      .getByText(
        "Station identity update is waiting for a connection. Cached offline work remains available.",
      )
      .closest(".station-floor-footer");
    expect(floorFooter?.closest(".station-root")).not.toBeNull();
    expect(floorFooter?.closest(".station-screen-slot")).toBeNull();
    expect(outbox).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      fetchMock.mock.calls.every(([url]) => new URL(url).pathname === "/station/identity"),
    ).toBe(true);
    expect(outbox).toHaveLength(1);
    resolveReconnect(new Response("{}", { status: 503 }));
  });

  it("keeps re-pairing unavailable in Setup while a legacy identity request is pending", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    const originalQueue = JSON.stringify(outbox);
    let resolveIdentity!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveIdentity = resolve;
          }),
      ),
    );

    const view = render(<App />);
    await screen.findByText("Updating station identity. Cached offline work remains available.");
    await signInAsOperator();
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));

    expect(
      await screen.findByText(
        "Re-pairing is unavailable until this legacy station identity is safely updated. Local production records remain preserved; retry the identity update or contact support.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Re-pair this station" })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("clear_credential");
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(JSON.stringify(outbox)).toBe(originalQueue);

    view.unmount();
    resolveIdentity(
      new Response(
        JSON.stringify({
          device: {
            id: "legacy-device",
            name: "Legacy station",
            tenantId: "tenant-legacy",
            organizationName: "Factory",
            line: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
    expect(persistedConfig).toEqual({
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    });
    expect(JSON.stringify(outbox)).toBe(originalQueue);
  });

  it("seals a degraded retry on unmount before a late identity response can write", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    const originalQueue = JSON.stringify(outbox);
    let resolveRetry!: (response: Response) => void;
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry identity update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    view.unmount();
    resolveRetry(
      new Response(
        JSON.stringify({
          device: {
            id: "legacy-device",
            name: "Legacy station",
            tenantId: "tenant-legacy",
            organizationName: "Factory",
            line: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
    expect(persistedConfig).toEqual({
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    });
    expect(JSON.stringify(outbox)).toBe(originalQueue);
  });

  it("keeps only the current legacy identity generation under StrictMode effect remounting", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    const originalQueue = JSON.stringify(outbox);
    const identityResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (new URL(url).pathname !== "/station/identity") {
          return new Promise<Response>(() => {});
        }
        return new Promise<Response>((resolve) => identityResolvers.push(resolve));
      }),
    );

    const view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(identityResolvers.length).toBeGreaterThan(0));
    act(() => {
      for (const resolve of identityResolvers) {
        resolve(
          new Response(
            JSON.stringify({
              device: {
                id: "legacy-device",
                name: "Legacy station",
                tenantId: "tenant-legacy",
                organizationName: "Factory",
                line: null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
    });

    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "write_config")).toHaveLength(1),
    );
    expect(persistedConfig).toMatchObject({
      machine_id: "legacy-machine",
      device_id: "legacy-device",
      api_key: "legacy-key",
    });
    expect(JSON.stringify(outbox)).toBe(originalQueue);
    view.unmount();
  });

  it("holds a rejected legacy identity in stable service recovery without clearing or pairing the queue", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const invoked: string[] = [];
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      {
        machine_id: "legacy-machine",
        api_key: "rejected-legacy-key",
        server_url: "https://api.factory.example",
      },
      (cmd) => invoked.push(cmd),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "revoked" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByText(
        "This legacy station key could not prove its device identity. Local work is preserved; contact service support before pairing again.",
      ),
    ).toBeDefined();
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invoked).not.toContain("clear_credential");
    expect(invoked).not.toContain("write_config");
    expect(outbox).toHaveLength(1);
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
  });

  it("keeps the legacy queue and key untouched when atomic identity persistence fails", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
      undefined,
      undefined,
      new Error("disk full"),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            device: {
              id: "device-legacy",
              name: "Legacy station",
              tenantId: "tenant-legacy",
              organizationName: "Factory",
              line: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByText(
        "Station identity update is waiting for a connection. Cached offline work remains available.",
      ),
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persistedConfig).toEqual({
      machine_id: "legacy-machine",
      api_key: "legacy-key",
      server_url: "https://api.factory.example",
    });
    expect(outbox).toHaveLength(1);
  });

  it("starts normally from a persisted backfill without requesting identity again", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      {
        machine_id: "legacy-machine",
        device_id: "device-legacy",
        tenant_id: "tenant-legacy",
        api_key: "legacy-key",
        server_url: "https://api.factory.example",
      },
    );
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        paths.push(path);
        if (init?.method === "POST" && path === "/station/scans") {
          return new Response(JSON.stringify({ applied: 1, alreadyApplied: false }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );

    render(<App />);

    await waitFor(() => expect(outbox).toHaveLength(0));
    expect(paths).not.toContain("/station/identity");
  });

  it("readShiftContext resolves null for a shift whose bundle has not been mirrored yet, so the 'preparing' branch is genuinely reachable", async () => {
    invokeMock.mockImplementation((cmd: string): Promise<unknown> => {
      if (cmd === "plugin:sql|select") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await expect(readShiftContext(tauriExecutor, "shift-not-yet-mirrored")).resolves.toBeNull();
  });

  it("uses the keyboard wedge when no serial scanner is configured", () => {
    expect(
      pickScanSource({
        scanner: null,
        printer: null,
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      }),
    ).toBe("wedge");
  });

  it("uses the hardware scanner once one is configured", () => {
    expect(
      pickScanSource({
        scanner: { port: "COM3", baud: 9600 },
        printer: null,
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      }),
    ).toBe("hardware");
  });

  it("shows the keyboard indicator until a configured scanner reports connected", () => {
    expect(
      scannerIndicator(
        { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
        null,
      ),
    ).toBe("keyboard");
    const configured = {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl" as const,
      verifyPrintedLabel: false,
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
      verifyPrintedLabel: false,
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
      verifyPrintedLabel: false,
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
      verifyPrintedLabel: false,
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
    fireEvent.change(await screen.findByRole("combobox", { name: "Port" }), {
      target: { value: "COM3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(hardwareMock.openScanner.mock.calls.length).toBeGreaterThan(openCallsBeforeSetup),
    );
  });

  it("explicit reset clears the shell credential then returns the same device record to pairing", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      tenant_id: "tenant-1",
      api_key: "credential-not-to-render",
      server_url: "https://api.factory.example",
    };
    mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    await openResetCredentialConfirmation();

    await waitFor(() => expect(screen.getByText("Connect station")).toBeDefined());
    expect(invokeMock).toHaveBeenCalledWith("clear_credential");
    expect(persistedConfig).toEqual({
      machine_id: "m1",
      device_id: "device-1",
      server_url: "https://api.factory.example",
    });
    expect(screen.queryByText("credential-not-to-render")).toBeNull();
  });

  it("recovers an empty-queue station when the swallowed roster refresh receives 401", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      tenant_id: "tenant-1",
      api_key: "revoked-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    let rejectRoster!: () => void;
    let credentialRevoked = false;
    const roster = new Promise<Response>((resolve) => {
      rejectRoster = () => {
        credentialRevoked = true;
        resolve(new Response(JSON.stringify({ message: "revoked" }), { status: 401 }));
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (new URL(url).pathname === "/station/operators") return roster;
        if (new URL(url).pathname === "/shifts" && credentialRevoked) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }),
    );

    render(<App />);
    await signInAsOperator();
    rejectRoster();

    await expectEmptyQueueCredentialRecovery(persistedConfig, outbox);
  });

  it("recovers an empty-queue station when the shift list receives 401", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      api_key: "revoked-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    let shiftRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URL(url).pathname;
        if (path === "/station/operators") {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (path === "/shifts") {
          shiftRequests += 1;
          return Promise.resolve(
            shiftRequests === 1
              ? new Response(JSON.stringify({ items: [] }), { status: 200 })
              : new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    render(<App />);
    await waitFor(() => expect(shiftRequests).toBe(1));
    await signInAsOperator();

    await expectEmptyQueueCredentialRecovery(persistedConfig, outbox);
  });

  it("recovers an empty-queue station when opening a listed shift receives 401", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      api_key: "revoked-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    let credentialRevoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/station/operators") {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (path === "/shifts") {
          if (credentialRevoked) {
            return Promise.resolve(
              new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: "shift-1",
                    status: "planned",
                    mode: "validation",
                    productName: "Product",
                    plannedQty: 10,
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (init?.method === "POST" && path === "/shifts/shift-1/open") {
          credentialRevoked = true;
          return Promise.resolve(
            new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await expectEmptyQueueCredentialRecovery(persistedConfig, outbox);
  });

  it("recovers an empty-queue station when a swallowed shift bundle receives 401", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      api_key: "revoked-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [],
      persistedConfig,
    );
    let credentialRevoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/station/operators") {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (path === "/shifts") {
          if (credentialRevoked) {
            return Promise.resolve(
              new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: "shift-1",
                    status: "planned",
                    mode: "validation",
                    productName: "Product",
                    plannedQty: 10,
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (init?.method === "POST" && path === "/shifts/shift-1/open") {
          return Promise.resolve(
            new Response(JSON.stringify({ id: "shift-1", status: "active", mode: "validation" }), {
              status: 200,
            }),
          );
        }
        if (path === "/shifts/shift-1/bundle") {
          credentialRevoked = true;
          return Promise.resolve(
            new Response(JSON.stringify({ message: "revoked" }), { status: 401 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await expectEmptyQueueCredentialRecovery(persistedConfig, outbox);
  });

  it("publishes and clears once when roster, shift list, and sync concurrently reject one credential", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      api_key: "revoked-key",
      server_url: "https://api.factory.example",
    };
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
    );
    let rejectRoster!: () => void;
    let rejectShiftList!: () => void;
    let rejectSync!: () => void;
    const roster = new Promise<Response>((resolve) => {
      rejectRoster = () =>
        resolve(new Response(JSON.stringify({ message: "revoked roster" }), { status: 401 }));
    });
    const shiftList = new Promise<Response>((resolve) => {
      rejectShiftList = () =>
        resolve(new Response(JSON.stringify({ message: "revoked shifts" }), { status: 401 }));
    });
    const sync = new Promise<Response>((resolve) => {
      rejectSync = () =>
        resolve(new Response(JSON.stringify({ message: "revoked sync" }), { status: 401 }));
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/station/operators") return roster;
      if (path === "/shifts") return shiftList;
      if (init?.method === "POST" && path === "/station/scans") return sync;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await signInAsOperator();
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
      expect(paths).toContain("/station/operators");
      expect(paths).toContain("/shifts");
      expect(paths).toContain("/station/scans");
    });
    act(() => {
      rejectRoster();
      rejectShiftList();
      rejectSync();
    });

    await waitFor(() => expect(screen.getByTestId("sealed-work-summary")).toBeDefined());
    expect(screen.getByTestId("sealed-work-summary").textContent).toBe(
      "Unsynchronized work is sealed on this station: 1 scans, 0 boxes, 0 corrections.",
    );
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clear_credential")).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([cmd, payload]) => {
        if (cmd !== "plugin:sql|execute") return false;
        const query = (((payload ?? {}) as { query?: string }).query ?? "").trimStart();
        return query.startsWith("DELETE FROM outbox");
      }),
    ).toEqual([]);
    expect(persistedConfig).toEqual({
      machine_id: "m1",
      device_id: "device-1",
      server_url: "https://api.factory.example",
    });
  });

  it("leaves the floor before clearing rejected credentials and shows the sealed queue in same-device pairing", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const persistedConfig: Record<string, unknown> = {
      machine_id: "m1",
      device_id: "device-1",
      tenant_id: "tenant-1",
      api_key: "credential-not-to-render",
      server_url: "https://api.factory.example",
    };
    let checkedFloorExit = false;
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      persistedConfig,
      (cmd) => {
        if (cmd === "clear_credential") {
          expect(screen.queryByTestId("scanner-status")).toBeNull();
          checkedFloorExit = true;
        }
      },
    );
    let rejectSync!: () => void;
    const rejectedResponse = new Promise<Response>((resolve) => {
      rejectSync = () =>
        resolve(
          new Response(JSON.stringify({ message: "revoked" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        );
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST" && new URL(url).pathname === "/station/scans") {
        return rejectedResponse;
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await signInAsOperator();
    rejectSync();

    await waitFor(() => expect(screen.getByTestId("sealed-work-summary")).toBeDefined());
    expect(checkedFloorExit).toBe(true);
    expect(screen.getByTestId("sealed-work-summary").textContent).toContain("1");
    expect(screen.getByTestId("sealed-work-summary").textContent).toContain("0");
    expect(invokeMock).toHaveBeenCalledWith("clear_credential");
    expect(outbox).toHaveLength(1);
    expect(persistedConfig).toEqual({
      machine_id: "m1",
      device_id: "device-1",
      server_url: "https://api.factory.example",
    });
    expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();
    expect(screen.queryByText("credential-not-to-render")).toBeNull();
  });

  it("stays fail-closed when the sealed-work snapshot cannot be read", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    const invoked: string[] = [];
    const outbox = mockInvokeForFloor(
      pinHash,
      { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
      [outboxRow(1)],
      {
        machine_id: "m1",
        device_id: "device-1",
        api_key: "mk_key",
        server_url: "https://api.factory.example",
      },
      (cmd) => invoked.push(cmd),
      new Error("snapshot unavailable"),
    );
    let rejectSync!: () => void;
    const rejectedResponse = new Promise<Response>((resolve) => {
      rejectSync = () =>
        resolve(
          new Response(JSON.stringify({ message: "revoked" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
        );
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST" && new URL(url).pathname === "/station/scans") {
        return rejectedResponse;
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await signInAsOperator();
    act(() => rejectSync());
    const retryRecovery = await screen.findByRole("button", { name: "Retry recovery" });
    expect(retryRecovery.style.height).toBe("var(--control-floor)");

    expect(screen.queryByTestId("scanner-status")).toBeNull();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(invoked).not.toContain("clear_credential");
    expect(outbox).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          init?.method === "POST" && new URL(url as string).pathname === "/station/scans",
      ),
    ).toHaveLength(1);
  });

  it("keeps the enrolled state and shows a useful error when explicit credential reset fails", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
      if (cmd === "clear_credential") return Promise.reject(new Error("shell unavailable"));
      if (cmd === "read_config") {
        return Promise.resolve({
          machine_id: "m1",
          device_id: "device-1",
          api_key: "mk_key",
          server_url: "http://localhost:3000",
        });
      }
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
      if (cmd === "plugin:sql|select") {
        const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
        if (/FROM operators_mirror\b/.test(query))
          return Promise.resolve([operatorMirrorRow(pinHash)]);
        if (query.includes("station_meta") && values?.[0] === "hardware_config") {
          return Promise.resolve([
            {
              value: JSON.stringify({
                scanner: null,
                printer: null,
                printerLanguage: "zpl",
                verifyPrintedLabel: false,
              }),
            },
          ]);
        }
        if (query.includes("station_meta") && values?.[0] === "install_id") {
          return Promise.resolve([{ value: "test-install-id" }]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
    await openResetCredentialConfirmation();

    expect(
      await screen.findByText("Could not reset station credentials. Try again or contact support."),
    ).toBeDefined();
    expect(screen.queryByText("Connect station")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByText("Shifts")).toBeDefined());
  });

  it("regression (Finding 2, Back): leaving Setup via Back after a manual test-connect retires that session without saving it", async () => {
    const pinHash = await hashSecret(OPERATOR_PIN);
    mockInvokeForFloor(pinHash, {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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
    fireEvent.change(await screen.findByRole("combobox", { name: "Port" }), {
      target: { value: "COM9" },
    });
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
        verifyPrintedLabel: false,
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
      fireEvent.change(await screen.findByRole("combobox", { name: "Port" }), {
        target: { value: "COM9" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      await waitFor(() => expect(hardwareMock.openScanner).toHaveBeenCalledWith("COM9", 9600));
      // The invariant this whole indicator exists for: never green for a
      // scanner that did not actually open.
      expect(screen.getByTestId("scanner-status").textContent).not.toBe("Connected");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("drains queued scans once the app reaches the floor", async () => {
    // The first attempt is made to fail by `renderAtFloorStage` (see its doc
    // comment), which the sync engine logs via `console.error` and retries --
    // expected, and silenced the same way the other failure-inducing tests
    // in this file are.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Arrange the app the way the existing floor-stage tests do, with one
      // outbox row already queued, then assert the ingest call went out.
      const posts: { path: string; body: unknown }[] = [];
      await renderAtFloorStage({ onPost: (path, body) => posts.push({ path, body }) });

      await waitFor(() => expect(posts.some((p) => p.path === "/station/scans")).toBe(true));

      // Honest to the test's name (Finding 3): the assertion above is
      // satisfied by the deliberately-FAILED first attempt alone, so nothing
      // yet covers the acknowledge path. The engine's own backoff retry (no
      // `online` needed) is what drives the second, successful attempt --
      // wait long enough for it to fire, then assert the batch was actually
      // accepted: a second `/station/scans` post landed and the device's
      // queue -- reflected by the status bar's pending count -- reached
      // zero.
      await waitFor(
        () => expect(posts.filter((p) => p.path === "/station/scans").length).toBeGreaterThan(1),
        { timeout: BACKOFF_START_MS + 2_000 },
      );
      await waitFor(() => expect(screen.getByTestId("sync-status").textContent).toBe("0"));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("nudges the sync engine when the device comes back online", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const posts: { path: string; body: unknown }[] = [];
      const outbox = await renderAtFloorStage({
        onPost: (path, body) => posts.push({ path, body }),
      });

      // Let the mount-time drain's deliberate first failure AND the engine's
      // own scheduled backoff retry fully play out, so no retry is left
      // pending. With the Finding 1 backoff fix, `nudge()` does nothing while
      // a retry is scheduled, so racing that window (what this test used to
      // do) can no longer discriminate the `online` listener from the
      // engine's own retry -- waiting for the queue to actually settle is
      // what makes the next `nudge()` unambiguously attributable to the
      // listener.
      await waitFor(() => expect(screen.getByTestId("sync-status").textContent).toBe("0"), {
        timeout: BACKOFF_START_MS + 2_000,
      });
      const before = posts.length;

      // New work queued directly -- standing in for another scan -- with no
      // retry scheduled: only the `online` listener's own `nudge()` can now
      // be the cause of a further post.
      outbox.push(outboxRow(2));

      act(() => {
        window.dispatchEvent(new Event("online"));
      });

      await waitFor(() => expect(posts.length).toBeGreaterThan(before));
      expect(posts.at(-1)?.path).toBe("/station/scans");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("the online-listener-nudges-engine wiring still works when the real App is rendered under StrictMode", async () => {
    // General StrictMode-compatibility smoke coverage for the real App: it
    // does NOT, by itself, discriminate the exact race Finding 1 identified
    // (see the dedicated regression test below for that, and its doc comment
    // for why this one structurally can't) -- `App`'s own `config` state
    // starts `null` and is only populated by an inherently async
    // `readConfig()` call, so the sync engine's real creation always lands on
    // a later UPDATE commit, never on the fiber's literal first commit where
    // React's StrictMode double-invoke of effects actually applies. This
    // test still earns its place: it confirms nothing about rendering the
    // real App under StrictMode (double-mounted unrelated effects included)
    // breaks the `online` -> nudge wiring.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const posts: { path: string; body: unknown }[] = [];
      const outbox = await renderAtFloorStage({
        onPost: (path, body) => posts.push({ path, body }),
        strictMode: true,
      });

      // Mount-time drain (its first attempt deliberately failed) and its own
      // scheduled retry have both settled -- see the non-StrictMode "nudges
      // ... online" test above for why this replaces racing the backoff
      // window now that a nudge no longer bypasses a scheduled retry
      // (Finding 1).
      await waitFor(() => expect(screen.getByTestId("sync-status").textContent).toBe("0"), {
        timeout: BACKOFF_START_MS + 2_000,
      });
      const before = posts.length;

      outbox.push(outboxRow(2));
      act(() => {
        window.dispatchEvent(new Event("online"));
      });

      await waitFor(() => expect(posts.length).toBeGreaterThan(before));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // Task 6, Finding 1: `FloorShell`/`StatusBar` are exercised in isolation
  // elsewhere with a literal `conflicts` prop, which cannot catch App.tsx
  // wiring the wrong `SyncState` field into it -- `conflicts={syncState.conflicts}`
  // and `conflicts={syncState.pending}` are both valid `number`s and both
  // typecheck. This test drives a real conflict through the sync engine (a
  // server response's `conflicts` array, exactly how `sync.ts` populates
  // `conflicts_mirror` in production) so `conflicts-status` reflects a value
  // that genuinely came from `syncState.conflicts`, and asserts it against a
  // `pending` that has settled to a DIFFERENT number -- swapping the two
  // fields in App.tsx would make this assertion fail, not vacuously pass.
  it("regression (Finding 1): a conflict count reported by sync reaches the status bar under its own field, not pending's", async () => {
    // The mount-time drain's deliberate first failure (mirroring the other
    // floor-stage tests in this file) logs via `console.error` -- expected,
    // silenced the same way.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pinHash = await hashSecret(OPERATOR_PIN);
      mockInvokeForFloor(
        pinHash,
        { scanner: null, printer: null, printerLanguage: "zpl", verifyPrintedLabel: false },
        [outboxRow(1)],
      );

      let scansAttempts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (init?.method !== "POST") {
            return new Response(JSON.stringify({ items: [] }), { status: 200 });
          }
          const path = new URL(url).pathname;
          if (path === "/station/scans") {
            scansAttempts += 1;
            if (scansAttempts === 1) throw new Error("station: simulated network blip");
            const items = (JSON.parse(init.body as string) as { items: unknown[] }).items;
            return new Response(
              JSON.stringify({
                applied: items.length,
                alreadyApplied: false,
                conflicts: [
                  {
                    codeHash: "hash1",
                    winningTerminalId: "t9",
                    winningScannedAt: "2026-07-28T10:00:00.000Z",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();

      // The queue drains to 0 -- distinct from the conflict count asserted
      // next, which is what makes this discriminate the actual confusion.
      await waitFor(() => expect(screen.getByTestId("sync-status").textContent).toBe("0"), {
        timeout: BACKOFF_START_MS + 2_000,
      });
      await waitFor(() => expect(screen.getByTestId("conflicts-status").textContent).toBe("1"));
      expect(screen.getByTestId("conflicts-status").textContent).not.toBe(
        screen.getByTestId("sync-status").textContent,
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // Task 6, Finding 4: neither `ShiftSelection`'s conflicts button nor the
  // `App.tsx` route into `ConflictList` had any coverage.
  it("opens the conflict list from shift selection and returns via Back (Finding 4)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await renderAtFloorStage();

      fireEvent.click(screen.getByRole("button", { name: "Conflicts" }));
      expect(await screen.findByText("Codes claimed elsewhere")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      // Back on ConflictList to shift selection: the "Conflicts" button
      // (only rendered on the ShiftSelection screen) is visible again.
      expect(await screen.findByRole("button", { name: "Conflicts" })).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // Finding 5: `onExit={() => setShift(null)}` used to clear only the shift,
  // leaving `floorView` (separate state) at whatever NewShift's own path left
  // it at. A shift entered through NewShift sets floorView to "new" and
  // nothing ever reset it back to "select", so exiting such a shift
  // re-rendered NewShift instead of shift selection -- the opposite of what
  // the exit control promises ("return to shift selection").
  it("returns to shift selection, not the new-shift form, after exiting a shift entered via NewShift (Finding 5)", async () => {
    // mirrorShiftBundle's own download (GET /shifts/:id/bundle) is not
    // meaningfully mocked below, so it fails and logs -- expected and
    // harmless (see shift-bundle.ts's doc comment on why that path is
    // best-effort), silenced the same way other failure-inducing tests here
    // silence it.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pinHash = await hashSecret(OPERATOR_PIN);
      invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
        if (cmd === "read_config") {
          return Promise.resolve({
            machine_id: "m1",
            device_id: "device-1",
            api_key: "mk_key",
            server_url: "http://localhost:3000",
          });
        }
        if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
        if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
        if (cmd === "plugin:sql|select") {
          const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
          if (query.includes("FROM outbox")) {
            if (query.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ n: 0 }]);
            return Promise.resolve([]);
          }
          if (/FROM operators_mirror\b/.test(query)) {
            return Promise.resolve([operatorMirrorRow(pinHash)]);
          }
          // readShiftContext's join (mirror.ts) -- answered with a fixed
          // product row for whatever shift id NewShift's own flow creates
          // below (`s9`), so WorkScreen actually renders instead of getting
          // stuck on "Preparing the shift…" forever.
          if (query.includes("shift_mirror")) {
            return Promise.resolve([
              { gtin14: "04600000000015", name: "Cola", counterparty_name: null },
            ]);
          }
          if (query.includes("station_meta")) {
            if (values?.[0] === "hardware_config") {
              return Promise.resolve([
                {
                  value: JSON.stringify({
                    scanner: null,
                    printer: null,
                    printerLanguage: "zpl",
                    verifyPrintedLabel: false,
                  }),
                },
              ]);
            }
            if (values?.[0] === "install_id") {
              return Promise.resolve([{ value: "test-install-id" }]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve(undefined);
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = init?.method ?? "GET";
          if (path === "/products/gtin-check" && method === "POST") {
            return new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
              status: 200,
            });
          }
          if (path === "/products" && method === "GET") {
            return new Response(
              JSON.stringify({
                items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", boxCapacity: null }],
              }),
              { status: 200 },
            );
          }
          if (path === "/shifts" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "planned", mode: "validation" }),
              { status: 201 },
            );
          }
          if (path === "/shifts/s9/open" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "active", mode: "validation" }),
              { status: 200 },
            );
          }
          // Roster sync, ShiftSelection's own listing, mirrorShiftBundle's
          // bundle download, and the sync engine's drain (empty outbox here,
          // so /station/scans should not actually be hit) -- a harmless
          // empty body for anything else.
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();

      fireEvent.click(screen.getByRole("button", { name: "New shift" }));
      await waitFor(() => expect(screen.getByLabelText("Type or scan a GTIN")).toBeDefined());

      fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
        target: { value: "4600000000015" },
      });
      fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
      await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Start" }));

      // Reached the floor via NewShift's own path -- floorView is "new" here.
      // WorkScreen's fixed footer exposes a dedicated Pause action;
      // waiting for it also proves shiftContext landed.
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeDefined());

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));

      // No scans were queued for this shift, so Exit leaves immediately
      // without the pending-sync confirmation step.
      await waitFor(() => expect(screen.getByText("Shifts")).toBeDefined());
      expect(screen.queryByLabelText("Type or scan a GTIN")).toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps sync and the floor sealed until a transient shift-mirror read is retried", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
      lockdownMock.subscribe.mockImplementation((listener) => {
        lockdownMock.listeners.add(listener);
        return () => lockdownMock.listeners.delete(listener);
      });
      const pinHash = await hashSecret(OPERATOR_PIN);
      let shiftMirrorReads = 0;
      invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
        if (cmd === "read_config") {
          return Promise.resolve({
            machine_id: "m1",
            device_id: "device-1",
            api_key: "mk_key",
            server_url: "http://localhost:3000",
          });
        }
        if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
        if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
        if (cmd === "plugin:sql|select") {
          const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
          if (query.includes("FROM outbox")) {
            if (query.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ n: 0 }]);
            return Promise.resolve([]);
          }
          if (/FROM operators_mirror\b/.test(query)) {
            return Promise.resolve([operatorMirrorRow(pinHash)]);
          }
          // `readShiftContext` stays healthy while the independent local
          // recovery classification read fails once.
          if (query.includes("product_mirror")) {
            return Promise.resolve([
              { gtin14: "04600000000015", name: "Cola", counterparty_name: null },
            ]);
          }
          if (query.includes("shift_mirror")) {
            shiftMirrorReads += 1;
            if (shiftMirrorReads === 1) {
              return Promise.reject(new Error("simulated transient shift_mirror read failure"));
            }
            return Promise.resolve([
              {
                id: "s9",
                status: "active",
                mode: "validation",
                counterparty_gln: null,
                label_template_spec: null,
                box_capacity: null,
                issuer_prefix: null,
                box_label_template_spec: null,
              },
            ]);
          }
          if (query.includes("station_meta")) {
            if (values?.[0] === "hardware_config") {
              return Promise.resolve([
                {
                  value: JSON.stringify({
                    scanner: null,
                    printer: null,
                    printerLanguage: "zpl",
                    verifyPrintedLabel: false,
                  }),
                },
              ]);
            }
            if (values?.[0] === "install_id") {
              return Promise.resolve([{ value: "test-install-id" }]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve(undefined);
      });

      const requestPaths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = init?.method ?? "GET";
          requestPaths.push(`${method} ${path}`);
          if (path === "/products/gtin-check" && method === "POST") {
            return new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
              status: 200,
            });
          }
          if (path === "/products" && method === "GET") {
            return new Response(
              JSON.stringify({
                items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", boxCapacity: null }],
              }),
              { status: 200 },
            );
          }
          if (path === "/shifts" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "planned", mode: "validation" }),
              { status: 201 },
            );
          }
          if (path === "/shifts/s9/open" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "active", mode: "validation" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();

      fireEvent.click(screen.getByRole("button", { name: "New shift" }));
      await waitFor(() => expect(screen.getByLabelText("Type or scan a GTIN")).toBeDefined());

      fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
        target: { value: "4600000000015" },
      });
      fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
      await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Start" }));

      expect(await screen.findByText("Could not restore the print state")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Close shift" })).toBeNull();
      expect(requestPaths).not.toContain("GET /shifts/s9/bundle");

      fireEvent.click(screen.getByRole("button", { name: "Retry recovery" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeDefined());
      await waitFor(() => expect(requestPaths).toContain("GET /shifts/s9/bundle"));
      // One failed classification read, one successful retry read, and one
      // strict recovery classifier read that confirms this validation shift
      // has no pending box recovery.
      expect(shiftMirrorReads).toBe(3);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps periodic sync alive when a fresh bundle revision updates the work screen", async () => {
    lockdownMock.getSnapshot.mockImplementation(() => lockdownMock.snapshot);
    lockdownMock.subscribe.mockImplementation((listener) => {
      lockdownMock.listeners.add(listener);
      return () => lockdownMock.listeners.delete(listener);
    });
    lockdownMock.start.mockReturnValue(() => {});
    const pinHash = await hashSecret(OPERATOR_PIN);
    let fresh = false;
    let freshPlainMirrorReads = 0;
    let openBoxInsertCount = 0;
    const outbox: OutboxSeedRow[] = [];
    let scanPosts = 0;
    let resolveBundle!: (response: Response) => void;
    const delayedBundle = new Promise<Response>((resolve) => {
      resolveBundle = resolve;
    });

    invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
      if (cmd === "read_config") {
        return Promise.resolve({
          machine_id: "m1",
          device_id: "device-1",
          api_key: "mk_key",
          server_url: "http://localhost:3000",
        });
      }
      if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
      if (cmd === "plugin:sql|execute") {
        const { query, values = [] } = (payload ?? {}) as {
          query: string;
          values?: unknown[];
        };
        if (query.includes("INSERT INTO shift_mirror")) fresh = true;
        if (query.includes("INSERT INTO boxes_mirror")) openBoxInsertCount += 1;
        if (query.includes("DELETE FROM outbox")) {
          const maxId = values[0] as number;
          for (let index = outbox.length - 1; index >= 0; index -= 1) {
            if (outbox[index]!.id <= maxId) outbox.splice(index, 1);
          }
        }
        return Promise.resolve([0, 0]);
      }
      if (cmd === "plugin:sql|select") {
        const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
        if (query.includes("FROM outbox")) {
          if (query.startsWith("SELECT COUNT(*)")) {
            return Promise.resolve([{ n: outbox.length }]);
          }
          if (query.startsWith("SELECT scanned_at")) {
            return Promise.resolve(outbox.length ? [{ scanned_at: outbox[0]!.scanned_at }] : []);
          }
          return Promise.resolve(outbox);
        }
        if (/FROM operators_mirror\b/.test(query)) {
          return Promise.resolve([operatorMirrorRow(pinHash)]);
        }
        if (query.includes("boxes_mirror")) return Promise.resolve([]);
        if (query.includes("product_mirror")) {
          return Promise.resolve([
            { gtin14: "04600000000015", name: "Cola", counterparty_name: null },
          ]);
        }
        if (query.includes("shift_mirror")) {
          if (fresh) freshPlainMirrorReads += 1;
          return Promise.resolve([
            {
              id: "s9",
              status: "active",
              mode: "aggregation",
              counterparty_gln: null,
              label_template_spec: null,
              box_capacity: fresh ? 20 : 10,
              issuer_prefix: "460123456",
              box_label_template_spec: JSON.stringify({
                widthMm: fresh ? 80 : 58,
                heightMm: 40,
                dpi: 203,
                language: "zpl",
                elements: [],
              }),
            },
          ]);
        }
        if (query.includes("station_meta")) {
          if (values?.[0] === "hardware_config") {
            return Promise.resolve([
              {
                value: JSON.stringify({
                  scanner: null,
                  printer: null,
                  printerLanguage: "zpl",
                  verifyPrintedLabel: false,
                }),
              },
            ]);
          }
          if (values?.[0] === "install_id") {
            return Promise.resolve([{ value: "test-install-id" }]);
          }
        }
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (path === "/shifts" && method === "GET") {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "s9",
                  status: "active",
                  mode: "aggregation",
                  productName: "Cola",
                  plannedQty: 100,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (path === "/shifts/s9/bundle") return (await delayedBundle).clone();
        if (path === "/station/scans" && method === "POST") {
          scanPosts += 1;
          return new Response(JSON.stringify({ applied: 1, alreadyApplied: false }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );

    render(<App />);
    await signInAsOperator();
    fireEvent.click(await screen.findByRole("button", { name: "Rejoin" }));

    expect((await screen.findByTestId("box-progress")).textContent).toBe("0 / 10");
    await waitFor(() => expect(openBoxInsertCount).toBeGreaterThan(0));
    const openBoxInsertsBeforeRefresh = openBoxInsertCount;

    resolveBundle(
      new Response(
        JSON.stringify({
          shift: {
            id: "s9",
            status: "active",
            mode: "aggregation",
            productId: "p1",
            productName: "Cola",
            lineId: "line-1",
            lineName: "Line 1",
            counterpartyId: null,
            counterpartyName: null,
            labelTemplateId: null,
            labelTemplateName: null,
            plannedQty: 100,
            plannedDate: "2026-08-14",
            boxCapacity: 20,
            palletCapacity: null,
            palletsEnabled: false,
            openedAt: "2026-08-14T10:00:00Z",
          },
          product: {
            id: "p1",
            gtin14: "04600000000015",
            name: "Cola",
            productGroup: "Beverages",
            boxCapacity: 20,
            palletCapacity: null,
            status: "active",
            defaultCounterpartyId: null,
            defaultLabelTemplateId: null,
          },
          labelTemplate: null,
          boxLabelTemplate: {
            id: "box-new",
            name: "New box label",
            spec: { widthMm: 80, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
          },
          counterpartyGln: null,
          operators: [],
          sscc: {
            issuerPrefix: "460123456",
            extensionDigit: 0,
            fromSerial: 1,
            toSerial: 100,
            consumedThroughSerial: null,
          },
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => expect(screen.getByTestId("box-progress").textContent).toBe("0 / 20"));
    // One fresh read updates App's props; WorkScreen then re-reads the label
    // spec in place for the new bundle revision without recreating work state.
    expect(freshPlainMirrorReads).toBeGreaterThanOrEqual(2);
    expect(openBoxInsertCount).toBe(openBoxInsertsBeforeRefresh);

    outbox.push({
      id: 1,
      shift_id: "s9",
      terminal_id: "device-1",
      raw: FIRST_KM,
      verdict: "ok",
      scanned_at: "2026-08-15T13:57:23.692Z",
      code_hash: "a".repeat(64),
      gtin14: "04600000000015",
      serial: "5Ab1",
      box_id: null,
      operator_id: "op1",
    });

    // No scan callback or online event nudges the engine here. The normal
    // 15-second heartbeat must discover this durable row by itself after the
    // bundle revision, proving that recovery did not leave sync paused.
    await waitFor(() => expect(scanPosts).toBe(1), { timeout: 17_000 });
    expect(outbox).toEqual([]);
  }, 20_000);

  // Task 13 review, Finding 1: App.tsx used to hardcode `issuerPrefix={null}`
  // and `boxCapacity={null}` into WorkScreen unconditionally, so the box UI
  // (progress, close, printing, verification) was unreachable from a real
  // shift no matter what the server actually returned. This proves the
  // wiring reaches WorkScreen for real: `readShiftMirror`'s row (mocked
  // below, standing in for what `upsertBundle` would have written from a
  // bundle carrying a non-null `sscc` and `boxCapacity`) must surface as an
  // actual box section, not the "no box UI at all" branch a null
  // `issuerPrefix` renders instead.
  it("reaches box progress and the close-box control for an aggregation-mode shift with a valid issuer prefix (Task 13 review, Finding 1)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pinHash = await hashSecret(OPERATOR_PIN);
      invokeMock.mockImplementation((cmd: string, payload?: unknown): Promise<unknown> => {
        if (cmd === "read_config") {
          return Promise.resolve({
            machine_id: "m1",
            device_id: "device-1",
            api_key: "mk_key",
            server_url: "http://localhost:3000",
          });
        }
        if (cmd === "plugin:sql|load") return Promise.resolve("sqlite:station-mirror.db");
        if (cmd === "plugin:sql|execute") return Promise.resolve([0, 0]);
        if (cmd === "plugin:sql|select") {
          const { query, values } = (payload ?? {}) as { query: string; values?: unknown[] };
          if (query.includes("FROM outbox")) {
            if (query.startsWith("SELECT COUNT(*)")) return Promise.resolve([{ n: 0 }]);
            return Promise.resolve([]);
          }
          if (/FROM operators_mirror\b/.test(query)) {
            return Promise.resolve([operatorMirrorRow(pinHash)]);
          }
          // No box open yet for this shift -- WorkScreen's own box-loading
          // effect opens a fresh one, exactly like a real first scan would.
          if (query.includes("boxes_mirror")) return Promise.resolve([]);
          // `readShiftContext`'s join (product_mirror) -- checked BEFORE the
          // plain `readShiftMirror` branch below, since both queries'
          // text contain "shift_mirror" and only this one also joins
          // product_mirror.
          if (query.includes("product_mirror")) {
            return Promise.resolve([
              { gtin14: "04600000000015", name: "Cola", counterparty_name: null },
            ]);
          }
          // `readShiftMirror`'s own plain select -- this is what App.tsx now
          // reads `boxCapacity`/`issuerPrefix` off (Finding 1). Standing in
          // for what `upsertBundle` would have written from a bundle
          // carrying a non-null `sscc` and the shift's own `boxCapacity`.
          if (query.includes("shift_mirror")) {
            return Promise.resolve([
              {
                id: "s9",
                status: "active",
                mode: "aggregation",
                counterparty_gln: null,
                label_template_spec: null,
                box_capacity: 10,
                issuer_prefix: "460123456",
              },
            ]);
          }
          if (query.includes("station_meta")) {
            if (values?.[0] === "hardware_config") {
              return Promise.resolve([
                {
                  value: JSON.stringify({
                    scanner: null,
                    printer: null,
                    printerLanguage: "zpl",
                    verifyPrintedLabel: false,
                  }),
                },
              ]);
            }
            if (values?.[0] === "install_id") {
              return Promise.resolve([{ value: "test-install-id" }]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve(undefined);
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          const method = init?.method ?? "GET";
          if (path === "/products/gtin-check" && method === "POST") {
            return new Response(JSON.stringify({ gtin14: "04600000000015", owner: "own" }), {
              status: 200,
            });
          }
          if (path === "/products" && method === "GET") {
            return new Response(
              JSON.stringify({
                items: [{ id: "p1", gtin14: "04600000000015", name: "Cola", boxCapacity: 10 }],
              }),
              { status: 200 },
            );
          }
          if (path === "/shifts" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "planned", mode: "aggregation" }),
              { status: 201 },
            );
          }
          if (path === "/shifts/s9/open" && method === "POST") {
            return new Response(
              JSON.stringify({ id: "s9", status: "active", mode: "aggregation" }),
              { status: 200 },
            );
          }
          // Roster sync, ShiftSelection's own listing, mirrorShiftBundle's
          // bundle download, and the sync engine's drain -- a harmless empty
          // body for anything else; the SELECT mocks above are what this
          // test's assertions actually rest on, not a real bundle round-trip.
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }),
      );

      render(<App />);
      await signInAsOperator();

      fireEvent.click(screen.getByRole("button", { name: "New shift" }));
      await waitFor(() => expect(screen.getByLabelText("Type or scan a GTIN")).toBeDefined());

      fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
        target: { value: "4600000000015" },
      });
      fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
      await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Start" }));

      // The box section renders at all -- unreachable before this fix, since
      // `issuerPrefix` was hardcoded to `null` regardless of what the shift
      // actually carried.
      expect((await screen.findByTestId("box-progress")).textContent).toBe("0 / 10");
      expect(screen.getByRole("button", { name: "Close box" })).toBeDefined(); // en.json's "box.close"
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
