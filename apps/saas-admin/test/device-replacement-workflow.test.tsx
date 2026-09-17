import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import { DeviceReplacementPanel } from "../src/pages/tenants/DeviceReplacementPanel.js";
import {
  pool,
  PROJECT,
  SECOND,
  workflowPreparation,
  executionPreview,
  response,
} from "./device-replacement-fixtures.js";
const authRefetch = vi.hoisted(() => vi.fn());
vi.mock("../src/auth/client.js", () => ({
  useAuthClient: () => ({ useSession: () => ({ refetch: authRefetch }) }),
}));
let current = workflowPreparation();
let bodies: Array<{ url: string; body: Record<string, unknown> }>;
let failure: "lost" | "stale" | "auth" | null;
let writable = true;
let failRefresh = false;
function setup(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  canWrite = true,
) {
  return {
    client,
    ...render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThemeProvider defaultTheme="light">
            <DeviceReplacementPanel pool={pool} canWrite={canWrite} />
          </ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  current = workflowPreparation();
  bodies = [];
  failure = null;
  writable = true;
  failRefresh = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST" && failRefresh) throw new TypeError("refresh unavailable");
      if (init?.method !== "POST")
        return response({
          canPrepare: writable,
          items: [{ preparation: current, needsReview: false }],
        });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ url, body });
      if (failure === "lost") {
        failure = null;
        throw new TypeError("connection lost");
      }
      if (failure === "stale") {
        failure = null;
        return response(
          { code: "device_replacement_stale", message: "Stale", requestId: PROJECT },
          409,
        );
      }
      if (failure === "auth") {
        failure = null;
        writable = false;
        return response({ code: "forbidden", message: "Forbidden", requestId: PROJECT }, 403);
      }
      if (url.endsWith("/preview"))
        return response(
          executionPreview(
            String(body.requestId),
            url.includes("emergency") ? "emergency" : "normal",
          ),
        );
      if (url.endsWith("/drain")) current = workflowPreparation("draining");
      if (url.endsWith("/execute"))
        current = workflowPreparation(
          "completed",
          url.includes("emergency") ? "required" : "not_required",
        );
      if (url.endsWith("/close"))
        current = workflowPreparation("completed", "evidence_unavailable");
      if (url.endsWith("/code"))
        return response({
          requestId: body.requestId,
          preparation: current,
          code: "12345678",
          expiresAt: "2026-09-18T13:00:00.000Z",
        });
      return response({ requestId: body.requestId, preparation: current });
    }),
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  authRefetch.mockReset();
  await i18n.changeLanguage("ru");
});
it("renders measured channels without turning unsupported into zero and shows server reasons", async () => {
  setup();
  await screen.findByText("Draining");
  for (const [label, value] of [
    ["Scans", "3"],
    ["Inventories", "2"],
    ["Shift closures", "1"],
    ["Product labels", "4"],
    ["Boxes", "5"],
    ["Exceptions", "Unsupported by client"],
    ["Conflicts", "6"],
    ["Unknown print outcomes", "8"],
    ["Active local tasks", "1"],
    ["Installed grants", "1"],
    ["Journal sequence", "23"],
    ["Storage revision", "19"],
    ["Credential epoch", "4"],
    ["Preparation revision", "3"],
  ]) {
    expect(screen.getByText(label!).closest("div")?.textContent).toContain(value);
  }
  expect(screen.getByText(/Update the source client/)).toBeDefined();
  expect(screen.queryByText(/Execution is not enabled/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview execution" })).toBeNull();
});
it.each(["prepared", "ready", "executing", "completed"] as const)(
  "renders %s with precise available actions",
  async (state) => {
    current = workflowPreparation(state);
    setup();
    await screen.findByText(
      state === "prepared"
        ? "Prepared"
        : state === "ready"
          ? "Ready to replace"
          : state === "executing"
            ? "Executing replacement"
            : "Replacement completed",
    );
    expect(Boolean(screen.queryByRole("button", { name: "Request drain" }))).toBe(
      state === "prepared",
    );
    expect(Boolean(screen.queryByRole("button", { name: "Preview execution" }))).toBe(
      state === "ready",
    );
    expect(Boolean(screen.queryByRole("button", { name: "Issue target pairing code" }))).toBe(
      state === "completed",
    );
    if (state === "executing")
      expect(screen.getByText(/Credential revocation pending/)).toBeDefined();
  },
);
it.each(["required", "draining", "completed", "evidence_unavailable"] as const)(
  "renders emergency boundary and recovery %s",
  async (recovery) => {
    current = workflowPreparation("completed", recovery);
    setup();
    await screen.findByText("Emergency replacement");
    expect(screen.getByText(/New work allowed from/).textContent).toContain("2026");
    expect(screen.getByText(SECOND)).toBeDefined();
    expect(screen.getByText("Execution revision").closest("div")?.textContent).toContain("9");
    expect(Boolean(screen.queryByRole("button", { name: "Issue source recovery code" }))).toBe(
      ["required", "draining"].includes(recovery),
    );
    if (recovery === "evidence_unavailable")
      expect(screen.getByText(/Local evidence is unavailable/)).toBeDefined();
  },
);
it("read-only principals inspect facts with no mutations", async () => {
  current = workflowPreparation("completed", "required");
  setup(undefined, false);
  await screen.findByText("Emergency replacement");
  expect(screen.getAllByRole("button").map((x) => x.textContent)).toEqual([
    "Refresh replacement state",
  ]);
});
it("preserves uncertain drain identity across remount", async () => {
  current = workflowPreparation("prepared");
  failure = "lost";
  const view = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Request drain" }));
  await screen.findByText(/Result is unknown/);
  view.unmount();
  setup(view.client);
  await userEvent.click(await screen.findByRole("button", { name: "Retry same request" }));
  await screen.findByText("Draining");
  expect(bodies[1]?.body).toEqual(bodies[0]?.body);
});
async function previewExecution(emergency = false) {
  await userEvent.click(
    await screen.findByRole("button", {
      name: emergency ? "Emergency replacement" : "Preview execution",
    }),
  );
  if (emergency) {
    fireEvent.change(screen.getByLabelText("Emergency reason"), {
      target: { value: "  Equipment destroyed  " },
    });
    await userEvent.click(screen.getByRole("button", { name: "Calculate emergency boundary" }));
  }
  await screen.findByRole("button", {
    name: emergency ? "Confirm emergency replacement" : "Confirm replacement",
  });
}
it.each([false, true])(
  "keeps exact execution identity and locks emergency intent after uncertain response (emergency=%s)",
  async (emergency) => {
    current = workflowPreparation(emergency ? "prepared" : "ready");
    const view = setup();
    await previewExecution(emergency);
    if (emergency) {
      const confirm = screen.getByRole("button", { name: "Confirm emergency replacement" });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
      expect(bodies[0]?.body.reason).toBe("Equipment destroyed");
    }
    failure = "lost";
    await userEvent.click(
      screen.getByRole("button", {
        name: emergency ? "Confirm emergency replacement" : "Confirm replacement",
      }),
    );
    await screen.findByText(/Result is unknown/);
    view.unmount();
    setup(view.client);
    await userEvent.click(await screen.findByRole("button", { name: "Retry same request" }));
    await screen.findByText("Replacement completed");
    expect(bodies[2]?.body).toEqual(bodies[1]?.body);
    expect(bodies[1]?.body).toMatchObject({
      expectedRevision: 3,
      previewId: "33333333-3333-4333-8333-333333333333",
      mode: emergency ? "emergency" : "normal",
    });
  },
);
it("refreshes stale facts and requires a fresh execution confirmation", async () => {
  current = workflowPreparation("ready");
  setup();
  await previewExecution();
  failure = "stale";
  await userEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
  await screen.findByText(/Facts changed/);
  expect(screen.queryByRole("button", { name: "Confirm replacement" })).toBeNull();
  await previewExecution();
  expect(bodies[2]?.body.requestId).not.toBe(bodies[0]?.body.requestId);
});
it("closes unavailable recovery with locked trimmed reason and same execution revision after lost response", async () => {
  current = workflowPreparation("completed", "required");
  const view = setup();
  await userEvent.click(
    await screen.findByRole("button", { name: "Close as evidence unavailable" }),
  );
  fireEvent.change(screen.getByLabelText("Reason for unavailable evidence"), {
    target: { value: "  Storage lost  " },
  });
  failure = "lost";
  await userEvent.click(screen.getByRole("button", { name: "Confirm evidence unavailable" }));
  await screen.findByText(/Result is unknown/);
  view.unmount();
  setup(view.client);
  await userEvent.click(await screen.findByRole("button", { name: "Retry same request" }));
  await screen.findByText(/Local evidence is unavailable/);
  expect(bodies[1]?.body).toEqual(bodies[0]?.body);
  expect(bodies[0]?.body).toMatchObject({ expectedRevision: 9, reason: "Storage lost" });
});
it.each(["Issue source recovery code", "Issue target pairing code"])(
  "issues a new secret after lost %s response",
  async (label) => {
    current = workflowPreparation("completed", "required");
    failure = "lost";
    setup();
    await userEvent.click(await screen.findByRole("button", { name: label }));
    await screen.findByText(/Issue a new code/);
    expect(screen.queryByText("12345678")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("12345678");
    expect(bodies[1]?.body.requestId).not.toBe(bodies[0]?.body.requestId);
  },
);
it("refetches authorization and removes mutations after permission loss", async () => {
  current = workflowPreparation("prepared");
  failure = "auth";
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Request drain" }));
  await waitFor(() => expect(authRefetch).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Request drain" })).toBeNull();
});

it("locks cancellation while a drain outcome is uncertain", async () => {
  current = workflowPreparation("prepared");
  failure = "lost";
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Request drain" }));
  await screen.findByText(/Result is unknown/);
  expect(screen.getByRole("button", { name: "Cancel preparation" }).hasAttribute("disabled")).toBe(
    true,
  );
});

it("retains a validated execution receipt when the following list refresh fails", async () => {
  current = workflowPreparation("ready");
  setup();
  await previewExecution();
  failRefresh = true;
  await userEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
  await screen.findByText("Replacement completed");
  expect(screen.queryByRole("button", { name: "Preview execution" })).toBeNull();
});

it.each(["draining", "ready"] as const)(
  "allows cancellation before cutover from %s",
  async (state) => {
    current = workflowPreparation(state);
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("source can resume new work");
  },
);

it.each(["en", "ru"])("renders execution field labels as text in %s", async (locale) => {
  await i18n.changeLanguage(locale);
  current = workflowPreparation("executing");
  setup();
  await screen.findByText(locale === "ru" ? "Этап исполнения" : "Execution step");
  expect(document.body.textContent).not.toMatch(/returned an object|deviceReplacement\./);
});

it("locks workflow mutations while cancellation is uncertain across remount", async () => {
  current = workflowPreparation("prepared");
  failure = "lost";
  const view = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText(/Result is unknown/);
  view.unmount();
  setup(view.client);
  await screen.findByText(/Result is unknown/);
  expect(screen.queryByRole("button", { name: "Request drain" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Emergency replacement" })).toBeNull();
});
