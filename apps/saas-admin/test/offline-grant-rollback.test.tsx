import { ThemeProvider } from "@markiro/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import {
  OfflineGrantRollbackPanel,
  toggleRollbackActivationSelection,
} from "../src/pages/catalog/OfflineGrantRollbackPanel.js";
import { rollbackKeys } from "../src/pages/catalog/offline-grant-rollback-state.js";
import { jsonResponse } from "./render.js";

const activationId = "99999999-9999-4999-8999-999999999999";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
interface Candidate {
  activationId: string;
  tenantId: string;
  tenantName: string;
  subscriptionId: string;
  deviceId: string;
  deviceKind: "station";
  deviceName: string;
  basePolicyId: string;
  strictPolicyId: string;
  strictDecisionReference: string;
  activatedAt: string;
}

const candidate: Candidate = {
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
};
function candidateAt(index: number): Candidate {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    ...candidate,
    activationId: `99999999-9999-4999-8${index.toString(16).padStart(3, "0")}-${suffix}`,
    deviceId: `22222222-2222-4222-8222-${suffix}`,
    deviceName: `Line ${index}`,
  };
}

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

it("caps the exact activation selection at 200 before appending", () => {
  const selected = Array.from({ length: 200 }, (_, index) => candidateAt(index + 1).activationId);
  const extra = candidateAt(201).activationId;

  expect(toggleRollbackActivationSelection(selected, extra)).toEqual(selected);
  expect(toggleRollbackActivationSelection(selected, selected[0]!)).toHaveLength(199);
});

it("does not retain or reuse a locally invalid prepare request", async () => {
  const firstRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const randomUUID = vi
    .fn()
    .mockReturnValueOnce(firstRequestId)
    .mockReturnValueOnce(secondRequestId);
  vi.stubGlobal("crypto", { randomUUID });
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
  const decision = screen.getByLabelText("Rollback decision reference");
  fireEvent.change(decision, { target: { value: "x".repeat(1_001) } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare rollback" }));

  await waitFor(() => expect(client.getQueryData(rollbackKeys.prepare)).toBeUndefined());
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

  fireEvent.change(decision, { target: { value: "CAB-RB" } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare rollback" }));
  await waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(call?.[1]?.body)).requestId).toBe(secondRequestId);
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
