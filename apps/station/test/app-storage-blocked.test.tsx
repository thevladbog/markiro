import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HardwareModule from "../src/lib/hardware.js";
import type * as LockdownModule from "../src/lib/lockdown.js";

// Station files in both folders, or an unreadable move record, make
// `station_database_url` fail. The mocks below are the smallest set the
// first render of <App /> needs; test/App.test.tsx lines 16-148 are the
// full reference if another boundary turns out to be required.
const mocks = vi.hoisted(() => {
  const snapshot = {
    mode: "locked",
    pending: false,
    error: null,
  } as LockdownModule.LockdownSnapshot;
  return {
    invoke: vi.fn<(command: string, payload?: unknown) => Promise<unknown>>(async (command) => {
      if (command === "station_database_url") {
        throw new Error("station files exist in both the roaming and the local folder");
      }
      return undefined;
    }),
    load: vi.fn(),
    hardware: {
      listScannerPorts: vi.fn(async () => []),
      listUsbPrinters: vi.fn(async () => []),
      configureScanners: vi.fn(async () => {}),
      closeScanner: vi.fn(async () => {}),
      onScannerConnections: vi.fn(async () => () => {}),
      onScan: vi.fn(async () => () => {}),
      onScannerStatus: vi.fn(async () => () => {}),
      print: vi.fn(async () => {}),
    },
    lockdown: {
      start: () => () => {},
      enter: async () => {},
      exit: async () => {},
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      clearError: () => {},
      whenSettled: async () => {},
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class FakeChannel {
    onmessage: (payload: unknown) => void = () => undefined;
  },
  invoke: (command: string, payload?: unknown) => mocks.invoke(command, payload),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("../src/lib/lockdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LockdownModule>()),
  createLockdownLifecycle: () => mocks.lockdown,
}));
vi.mock("../src/lib/hardware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HardwareModule>()),
  tauriHardware: mocks.hardware,
}));

import i18n from "../src/i18n/index.js";
import { App } from "../src/App.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("App with blocked station storage", () => {
  it("stops on the recovery screen and never reads or mints the config", async () => {
    render(<App />);

    expect(
      await screen.findByText(
        "Local work is sealed, but station recovery could not be completed. Retry or contact support.",
      ),
    ).toBeDefined();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain("read_config");
    expect(screen.queryByText("Connect station")).toBeNull();
  });
});
