import { ThemeProvider } from "@markiro/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";

import i18n from "../src/i18n/index.js";
import { OfflineGrantReadinessPanel } from "../src/pages/catalog/OfflineGrantReadinessPanel.js";
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
    vi.fn<typeof fetch>(async (_input, init) =>
      jsonResponse(200, init?.method === "POST" ? readinessPreview : readinessList),
    ),
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
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
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

it("retries an uncertain preview with the original request identity", async () => {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementationOnce(async () => jsonResponse(200, readinessList));
  fetchMock.mockImplementationOnce(async () => jsonResponse(502, { code: "UPSTREAM_FAILURE" }));
  fetchMock.mockImplementationOnce(async () => jsonResponse(200, readinessPreview));
  setup();

  fireEvent.click(await screen.findByRole("checkbox", { name: "Select Line station" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  await screen.findByText(/outcome could not be confirmed/i);
  const firstBody = String(fetchMock.mock.calls[1]?.[1]?.body);

  fireEvent.click(screen.getByRole("button", { name: "Preview pilot cohort" }));
  await screen.findByText(/1 eligible, 0 blocked/);
  expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toBe(firstBody);
});

it("replaces a successful preview with a fresh snapshot and request identity", async () => {
  const secondRequestId = "99999999-9999-4999-8999-999999999999";
  const secondAsOf = "2026-09-14T13:00:00.000Z";
  const secondDigest = "c".repeat(64);
  const randomUUID = vi.fn().mockReturnValueOnce(requestId).mockReturnValueOnce(secondRequestId);
  vi.stubGlobal("crypto", { randomUUID });
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementation(async (_input, init) => {
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
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
    requestId: secondRequestId,
  });
});
