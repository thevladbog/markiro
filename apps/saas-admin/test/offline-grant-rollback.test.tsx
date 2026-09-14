import { ThemeProvider } from "@markiro/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import { OfflineGrantRollbackPanel } from "../src/pages/catalog/OfflineGrantRollbackPanel.js";
import { jsonResponse } from "./render.js";

const activationId = "99999999-9999-4999-8999-999999999999";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const candidate = {
  activationId,
  tenantId: "tenant-a",
  tenantName: "Factory A",
  subscriptionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  deviceId: "22222222-2222-4222-8222-222222222222",
  deviceKind: "station",
  deviceName: "Line 1",
  basePolicyId: "11111111-1111-4111-8111-111111111111",
  strictPolicyId: "33333333-3333-4333-8333-333333333333",
  strictDecisionReference: "CAB-ACT",
  activatedAt: "2026-09-14T12:00:00.000Z",
} as const;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("crypto", { randomUUID: () => requestId });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/candidates?"))
        return jsonResponse(200, { items: [candidate], nextCursor: null });
      if (!init?.method) return jsonResponse(200, { items: [], nextCursor: null });
      return jsonResponse(500, { kind: "uncertain" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("prepares only the selected active activation without commercial inputs", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="light">
          <OfflineGrantRollbackPanel canActivate currentUserId="user-2" />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  fireEvent.click(await screen.findByLabelText(/Factory A · Line 1/));
  fireEvent.change(screen.getByLabelText("Rollback decision reference"), {
    target: { value: "CAB-RB" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare rollback" }));
  await waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    protocol: "offline-grants-rollback-v1",
    activationIds: [activationId],
    decisionReference: "CAB-RB",
    requestId,
  });
});
