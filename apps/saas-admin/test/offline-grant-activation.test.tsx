import { ThemeProvider } from "@markiro/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";

import i18n from "../src/i18n/index.js";
import { OfflineGrantActivationPanel } from "../src/pages/catalog/OfflineGrantActivationPanel.js";
import { activationKeys } from "../src/pages/catalog/offline-grant-activation-state.js";
import { confirmRequestId, preparedActivation } from "./offline-grant-activation-fixtures.js";
import { readinessPreview } from "./offline-grant-readiness-fixtures.js";
import { jsonResponse } from "./render.js";

function setup(
  currentUserId = "user-1",
  options: {
    onDirtyChange?: (dirty: boolean) => void;
    seed?: (client: QueryClient) => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  options.seed?.(client);
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="light">
          <OfflineGrantActivationPanel
            preview={readinessPreview}
            canActivate
            currentUserId={currentUserId}
            {...(options.onDirtyChange ? { onDirtyChange: options.onDirtyChange } : {})}
          />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("crypto", { randomUUID: () => confirmRequestId });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/confirm")) {
        return jsonResponse(200, {
          status: "needs_review",
          requestId: confirmRequestId,
          preparation: { ...preparedActivation, state: "needs_review" },
          reasons: ["client_report_stale"],
        });
      }
      return jsonResponse(200, { items: [preparedActivation], nextCursor: null });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("requires a second platform administrator for confirmation", async () => {
  setup();
  expect(await screen.findByText(/another platform administrator/i)).not.toBeNull();
  expect(screen.getByRole("button", { name: "Confirm strict" }).matches(":disabled")).toBe(true);
});

it("confirms with the saved digest and a stable request identity", async () => {
  setup("user-2");
  fireEvent.click(await screen.findByRole("button", { name: "Confirm strict" }));
  await screen.findByText(/Server facts changed/i);
  const confirmCall = vi
    .mocked(fetch)
    .mock.calls.find(([input]) => String(input).endsWith("/confirm"));
  expect(JSON.parse(String(confirmCall?.[1]?.body))).toEqual({
    protocol: "offline-grants-activation-v1",
    preparationDigest: preparedActivation.preparationDigest,
    requestId: confirmRequestId,
  });
});

it("prepares the exact preview cohort without commercial inputs", async () => {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === "POST" && String(input).endsWith("/activations")) {
      return jsonResponse(200, preparedActivation);
    }
    return jsonResponse(200, { items: [], nextCursor: null });
  });
  setup("user-2");
  fireEvent.change(screen.getByLabelText("Decision reference"), {
    target: { value: "CAB-2026-0914" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prepare pilot" }));
  await waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
    previewRequestId: readinessPreview.requestId,
    previewDigest: readinessPreview.previewDigest,
    policyId: readinessPreview.policyId,
    deviceIds: readinessPreview.items.map((item) => item.deviceId),
  });
});

it("loads and renders every activation page", async () => {
  const older = {
    ...preparedActivation,
    id: "00000000-0000-4000-8000-000000000099",
    decisionReference: "Older prepared cohort",
  };
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), "https://example.invalid");
    if (url.searchParams.get("cursor") === "older-page") {
      return jsonResponse(200, { items: [older], nextCursor: null });
    }
    return jsonResponse(200, {
      items: [],
      nextCursor: "older-page",
    });
  });

  setup("user-2");

  expect(await screen.findByText("Older prepared cohort")).not.toBeNull();
  expect(
    vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("cursor=older-page")),
  ).toBe(true);
});

it.each(["confirm", "cancel"] as const)(
  "keeps the drawer dirty for an uncertain %s attempt",
  async (operation) => {
    const onDirtyChange = vi.fn();
    setup("user-2", {
      onDirtyChange,
      seed: (client) => {
        const key =
          operation === "confirm"
            ? activationKeys.confirm(preparedActivation.id)
            : activationKeys.cancel(preparedActivation.id);
        const request =
          operation === "confirm"
            ? {
                protocol: "offline-grants-activation-v1" as const,
                preparationDigest: preparedActivation.preparationDigest,
                requestId: confirmRequestId,
              }
            : {
                protocol: "offline-grants-activation-v1" as const,
                reason: "Retry cancellation",
                requestId: confirmRequestId,
              };
        client.setQueryData(key, { request, response: null, notice: "uncertain" });
      },
    });

    await screen.findByText(preparedActivation.decisionReference);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  },
);
