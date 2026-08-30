import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { SignerAgentsPanel } from "../src/pages/integrations/SignerAgentsPanel.js";
import type { ChzCodeStatusSummary } from "../src/pages/integrations/api.js";
import { jsonResponse } from "./helpers/http.js";

// Same fixture shape `signer-agents-panel.test.tsx` uses for this same panel:
// each admin test declares its own render helper and fetch stub, and the
// fetch stub builds a real `Response` via the shared `helpers/http.js`.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const NO_TOKEN = { status: "none" as const, obtainedAt: null, expiresAt: null, certThumbprint: null };

const READ_ONLY_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ],
};

let summaryFixture: ChzCodeStatusSummary = {
  total: 0,
  refreshedLastDay: 0,
  withoutProductGroup: 0,
  lastCheckedAt: null,
};

beforeEach(() => {
  summaryFixture = {
    total: 0,
    refreshedLastDay: 0,
    withoutProductGroup: 0,
    lastCheckedAt: null,
  };
});

function renderPanel(access: AccessDocument = READ_ONLY_ACCESS) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "GET" && path === "/signer-agents") {
      return jsonResponse(200, { agents: [], token: NO_TOKEN });
    }

    if (method === "GET" && path === "/integrations/chestny_znak/code-statuses") {
      return jsonResponse(200, summaryFixture);
    }

    return jsonResponse(404, { message: "not found" });
  });

  vi.stubGlobal("fetch", fetchMock);

  return render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={access}>
        <SignerAgentsPanel />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

describe("SignerAgentsPanel code-statuses freshness line", () => {
  it("renders the known/refreshed counts", async () => {
    summaryFixture = {
      total: 42,
      refreshedLastDay: 7,
      withoutProductGroup: 0,
      lastCheckedAt: "2026-08-29T10:00:00.000Z",
    };
    renderPanel();

    expect(await screen.findByText(/42/)).toBeDefined();
    expect(screen.getByText(/7/)).toBeDefined();
  });

  it("says no checks have run yet when the tenant has never had a pass", async () => {
    summaryFixture = {
      total: 0,
      refreshedLastDay: 0,
      withoutProductGroup: 0,
      lastCheckedAt: null,
    };
    renderPanel();

    expect(await screen.findByText(/ещё не было|no checks yet/i)).toBeDefined();
  });

  it("hides the stuck-codes line when withoutProductGroup is zero", async () => {
    summaryFixture = {
      total: 10,
      refreshedLastDay: 10,
      withoutProductGroup: 0,
      lastCheckedAt: "2026-08-29T10:00:00.000Z",
    };
    renderPanel();

    await screen.findByText(/10/);
    expect(screen.queryByText(/товарной группы|product group/i)).toBeNull();
  });

  it("shows the stuck-codes line only when withoutProductGroup is above zero", async () => {
    summaryFixture = {
      total: 10,
      refreshedLastDay: 3,
      withoutProductGroup: 4,
      lastCheckedAt: "2026-08-29T10:00:00.000Z",
    };
    renderPanel();

    expect(await screen.findByText(/товарной группы|product group/i)).toBeDefined();
    expect(screen.getByText(/4/)).toBeDefined();
  });
});
