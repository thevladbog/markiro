import { ThemeProvider } from "@markiro/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";

import i18n from "../src/i18n/index.js";
import { OfflineGrantReadinessPanel } from "../src/pages/catalog/OfflineGrantReadinessPanel.js";
import { OfflineGrantPoliciesPanel } from "../src/pages/catalog/OfflineGrantPoliciesPanel.js";
import {
  approvedPolicy,
  readinessList,
  readinessPreview,
  readyDeviceId,
  requestId,
} from "./offline-grant-readiness-fixtures.js";
import { jsonResponse } from "./render.js";

function setup(onDirtyChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onDirtyChange,
    ...render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThemeProvider defaultTheme="light">
            <OfflineGrantReadinessPanel
              policies={[approvedPolicy]}
              canPreview
              canActivate
              currentUserId="user-1"
              onDirtyChange={onDirtyChange}
            />
          </ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("crypto", { randomUUID: () => requestId });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/offline-grants/activations")) {
        return jsonResponse(200, { items: [], nextCursor: null });
      }
      return jsonResponse(200, init?.method === "POST" ? readinessPreview : readinessList);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("selects only eligible devices and creates a preview without activation", async () => {
  setup();
  const eligible = await screen.findByRole("checkbox", { name: "Select Line station" });
  const blocked = screen.getByRole("checkbox", { name: "Select Packing station" });
  expect(blocked.matches(":disabled")).toBe(true);

  fireEvent.click(eligible);
  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));

  await screen.findByText(/1 eligible, 0 blocked/);
  const fetchMock = vi.mocked(fetch);
  const previewCall = fetchMock.mock.calls.find(
    ([input, init]) => String(input).endsWith("/readiness/preview") && init?.method === "POST",
  );
  expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
    policyId: approvedPolicy.id,
    mode: "strict",
    deviceIds: [readyDeviceId],
    requestId,
  });
  expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
  expect(screen.getAllByText(/Configuration: match/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2 accepted events/).length).toBeGreaterThan(0);
});

it("reports unsaved preview state until it is explicitly cleared", async () => {
  const onDirtyChange = vi.fn();
  setup(onDirtyChange);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Line station" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear preview" }));

  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it("clears the drawer dirty state only when the readiness panel unmounts", async () => {
  const onDirtyChange = vi.fn();
  const view = setup(onDirtyChange);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Line station" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  onDirtyChange.mockClear();

  view.rerender(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider defaultTheme="light">
          <div>gone</div>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(onDirtyChange).toHaveBeenCalledTimes(1);
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it("connects each offline grant tab to its own tab panel", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [approvedPolicy] })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="light">
          <OfflineGrantPoliciesPanel
            canWrite
            canActivate
            currentUserId="user-1"
            onDirtyChange={vi.fn()}
          />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const policiesTab = await screen.findByRole("tab", { name: "Policies" });
  expect(policiesTab.getAttribute("aria-controls")).toBe("offline-grant-policies-panel");
  expect(screen.getByRole("tabpanel").id).toBe("offline-grant-policies-panel");
  fireEvent.click(screen.getByRole("tab", { name: "Pilot readiness" }));
  expect(screen.getByRole("tabpanel").id).toBe("offline-grant-readiness-panel");
});

it("retries an uncertain preview with the original request identity", async () => {
  const fetchMock = vi.mocked(fetch);
  let previewCalls = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/offline-grants/activations")) {
      return jsonResponse(200, { items: [], nextCursor: null });
    }
    if (init?.method !== "POST") return jsonResponse(200, readinessList);
    previewCalls += 1;
    return previewCalls === 1
      ? jsonResponse(502, { code: "UPSTREAM_FAILURE" })
      : jsonResponse(200, readinessPreview);
  });
  setup();

  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Line station" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  await screen.findByText(/outcome could not be confirmed/i);
  const firstBody = String(
    fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body,
  );

  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  await screen.findByText(/1 eligible, 0 blocked/);
  const postBodies = fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => String(init?.body));
  expect(postBodies).toEqual([firstBody, firstBody]);
});

it("replaces a successful preview with a fresh snapshot and request identity", async () => {
  const secondRequestId = "99999999-9999-4999-8999-999999999999";
  const secondAsOf = "2026-09-14T13:00:00.000Z";
  const secondDigest = "c".repeat(64);
  const randomUUID = vi.fn().mockReturnValueOnce(requestId).mockReturnValueOnce(secondRequestId);
  vi.stubGlobal("crypto", { randomUUID });
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementation(async (_input, init) => {
    if (String(_input).includes("/offline-grants/activations")) {
      return jsonResponse(200, { items: [], nextCursor: null });
    }
    if (init?.method !== "POST") return jsonResponse(200, readinessList);
    const body = JSON.parse(String(init.body)) as { requestId: string };
    return jsonResponse(200, {
      ...readinessPreview,
      requestId: body.requestId,
      asOf: body.requestId === requestId ? readinessPreview.asOf : secondAsOf,
      previewDigest: body.requestId === requestId ? readinessPreview.previewDigest : secondDigest,
    });
  });
  setup();

  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Line station" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  await screen.findByText(new RegExp(readinessPreview.previewDigest));
  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));

  await screen.findByText(new RegExp(secondDigest));
  const postBodies = fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as { requestId: string });
  expect(postBodies.at(-1)).toMatchObject({
    requestId: secondRequestId,
  });
});
