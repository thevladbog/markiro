import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { AgentStatus } from "../src/lib/bridge.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let statusListener: ((status: AgentStatus) => void) | null = null;

vi.mock("../src/lib/bridge.js", () => ({
  bridge: {
    status: vi.fn(),
    onStatus: vi.fn((listener: (status: AgentStatus) => void) => {
      statusListener = listener;
      return Promise.resolve(() => {
        statusListener = null;
      });
    }),
    listCertificates: vi.fn().mockResolvedValue([]),
    selectCertificate: vi.fn(),
    unpair: vi.fn(),
    pair: vi.fn(),
    setServerUrl: vi.fn(),
  },
}));

const eventStatus: AgentStatus = {
  phase: "degraded",
  hostname: "BUH-PC",
  tenantName: "Event tenant",
  certThumbprint: "AB12",
  lastTokenExpiresAt: null,
  lastError: "boom",
  journal: [],
};

const staleSnapshot: AgentStatus = {
  phase: "unpaired",
  hostname: "BUH-PC",
  tenantName: null,
  certThumbprint: null,
  lastTokenExpiresAt: null,
  lastError: null,
  journal: [],
};

describe("App status race", () => {
  // F6: `bridge.status()` (the initial snapshot) and `bridge.onStatus` (the
  // event stream) race. If a status event lands before the initial promise
  // resolves, the resolved snapshot must not overwrite it with stale data.
  it("keeps a status event that arrived before the initial snapshot resolved", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    const initial = deferred<AgentStatus>();
    vi.mocked(bridge.status).mockReturnValue(initial.promise);

    render(<App />);

    await screen.findByText(/загрузка|loading/i);

    // The event arrives first...
    await act(async () => {
      statusListener?.(eventStatus);
    });
    await screen.findByText("Event tenant");

    // ...then the stale initial snapshot resolves. It must not win.
    await act(async () => {
      initial.resolve(staleSnapshot);
    });

    expect(screen.queryByText("Event tenant")).not.toBeNull();
  });
});
