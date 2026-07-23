import { render, screen, waitFor } from "@testing-library/react";
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

const enrolledConfig: StationConfig = {
  machineId: "m1",
  tenantId: "t1",
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
});
