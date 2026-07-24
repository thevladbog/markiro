import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import i18n from "../src/i18n/index.js";
import { App, nextStationView } from "../src/App.js";
import type { StationConfig } from "../src/lib/config.js";
import type { OperatorMirrorRecord } from "@markiro/db";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  invokeMock.mockClear();
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
  role: "operator",
  pinHash: "hash",
  badgeHash: null,
  active: true,
};

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
});
