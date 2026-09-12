import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import { DeviceRetentionPanel } from "../src/pages/tenants/DeviceRetentionPanel.js";
import { inspection, preview, selection, response, id } from "./device-retention-fixtures.js";
import type {
  DeviceRetentionInspection,
  DeviceRetentionPreviewRequest,
  DeviceRetentionConfirm,
  DeviceRetentionPreview,
} from "@markiro/platform-contracts";
let facts: DeviceRetentionInspection;
let latestPreview: DeviceRetentionPreview;
let posts: Array<{ url: string; body: DeviceRetentionPreviewRequest | DeviceRetentionConfirm }>;
let failure: ((url: string) => Response | undefined) | undefined;
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
            <DeviceRetentionPanel tenantId="tenant-a" canWrite={canWrite} />
          </ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  facts = structuredClone(inspection);
  latestPreview = structuredClone(preview);
  posts = [];
  failure = undefined;
  vi.stubGlobal("crypto", { randomUUID: () => id });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST") return response(facts);
      const body = JSON.parse(String(init.body)) as
        DeviceRetentionPreviewRequest | DeviceRetentionConfirm;
      posts.push({ url, body });
      const failed = failure?.(url);
      if (failed) return failed;
      if ("selectedDeviceIds" in body) {
        latestPreview = {
          ...preview,
          requestId: body.requestId,
          expectedRevision: body.expectedRevision,
          selectedDeviceIds: [...body.selectedDeviceIds].sort(),
          observation: structuredClone(facts.observation ?? preview.observation),
        };
        return response(latestPreview);
      }
      return response({
        requestId: body.requestId,
        selection: {
          ...selection,
          revision: latestPreview.expectedRevision + 1,
          selectedDeviceIds: latestPreview.selectedDeviceIds,
          observation: latestPreview.observation,
        },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function choose() {
  const checkbox = await screen.findByRole("checkbox", { name: "Line station" });
  expect(isChecked(checkbox)).toBe(false);
  fireEvent.click(checkbox);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "Keep production" },
  });
  return checkbox;
}
it("starts unchecked and saves the entire explicit set without executing", async () => {
  setup();
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save selection" }));
  await screen.findByText(/Selection saved for/);
  expect(posts[0]?.body).toMatchObject({ selectedDeviceIds: [id], expectedRevision: 0 });
  expect(posts.map((p) => p.url.split("/").pop())).toEqual(["preview", "confirm"]);
  expect(screen.getAllByText(/Execution is not enabled/).length).toBeGreaterThan(0);
});
it("allows an intentional empty set at zero", async () => {
  if (facts.observation)
    facts.observation.future.candidate.quotas.stations = { limit: 0, used: 1, remaining: 0 };
  setup();
  await screen.findByRole("checkbox");
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "No retained devices" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByRole("button", { name: "Save selection" });
  expect(posts[0]?.body).toMatchObject({ selectedDeviceIds: [] });
});
it("server canSelect denies editing even with parent write permission", async () => {
  facts.canSelect = false;
  setup();
  expect((await screen.findByRole("checkbox")).matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Preview selection" })).toBeNull();
});
it("parent permission cannot be bypassed", async () => {
  setup(undefined, false);
  expect((await screen.findByRole("checkbox")).matches(":disabled")).toBe(true);
});
it("explains ineligible devices", async () => {
  const device = facts.observation?.devices[0];
  if (device) {
    device.eligible = false;
    device.reasons = ["handheld_unavailable"];
  }
  setup();
  expect((await screen.findByRole("checkbox")).matches(":disabled")).toBe(true);
  expect(screen.getByText("Handheld work is unavailable under future conditions.")).toBeTruthy();
});
it.each([
  ["preview", 502, true],
  ["confirm", 502, true],
  ["preview", 200, true],
  ["confirm", 200, true],
  ["preview", 502, false],
  ["confirm", 502, false],
] as const)(
  "recovers %s HTTP%i with remount=%s using unchanged body and edit lock",
  async (phase, status, remount) => {
    const view = setup();
    await choose();
    if (phase === "preview") failure = () => response({}, status);
    fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
    if (phase === "confirm") {
      await screen.findByRole("button", { name: "Save selection" });
      failure = () => response({}, status);
      fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    }
    await screen.findByText(/Outcome is unknown/);
    const original = posts.at(-1);
    if (remount) {
      view.unmount();
      if (phase === "confirm") facts.observation = null;
      setup(view.client);
    }
    expect(screen.getByRole("textbox", { name: "Reason" }).matches(":disabled")).toBe(true);
    failure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry unchanged request" }));
    await waitFor(() => expect(posts).toHaveLength(phase === "preview" ? 2 : 3));
    expect(posts.at(-1)).toEqual(original);
    if (phase === "confirm") await screen.findByText(/Selection saved for/);
    else await screen.findByRole("button", { name: "Save selection" });
  },
);
it("shows original saved selection, stale/reached and shadow independently", async () => {
  facts.selections = [{ selection, needsReview: true, boundaryReached: true }];
  facts.observation = null;
  facts.currentShadow = { awaitingSelection: true, affectedDeviceIds: [id], enforced: false };
  setup();
  await screen.findByText(/Needs a new review/);
  expect(screen.getByText(/Boundary has been reached/)).toBeTruthy();
  expect(screen.getByText(/Current shadow calculation/)).toBeTruthy();
  expect(screen.getByText("Line station")).toBeTruthy();
});
it("edits a saved revision only after explicit edit", async () => {
  facts.selections = [{ selection, needsReview: false, boundaryReached: false }];
  setup();
  await screen.findByRole("button", { name: "Edit saved selection" });
  expect(screen.queryByRole("checkbox", { name: "Line station" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit saved selection" }));
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "Reviewed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByRole("button", { name: "Save selection" });
  expect(posts[0]?.body).toMatchObject({ expectedRevision: 1, selectedDeviceIds: [id] });
});

function isChecked(element: HTMLElement) {
  return element.getAttribute("aria-checked") === "true";
}
it("blocks all intent edits while a preview is in flight across remount", async () => {
  let release: (value: Response) => void = () => {
    throw new Error("not started");
  };
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = vi.mocked(globalThis.fetch);
  const normal = fetch.getMockImplementation();
  if (!normal) throw new Error("Missing fetch fixture");
  fetch.mockImplementation((input, init) =>
    init?.method === "POST" ? pending : normal(input, init),
  );
  const view = setup();
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  view.unmount();
  setup(view.client);
  expect(screen.getByRole("textbox", { name: "Reason" }).matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "Wrong intent" },
  });
  expect(inputValue(screen.getByRole("textbox", { name: "Reason" }))).toBe("Keep production");
  release(response(preview));
  await screen.findByRole("button", { name: "Save selection" });
});
it("does not silently reselect after a changed boundary", async () => {
  const view = setup();
  await choose();
  if (facts.observation) facts.observation.boundary.key = "b".repeat(64);
  await view.client.invalidateQueries({ queryKey: ["device-retention", "tenant-a"] });
  await screen.findByText(/Needs a new review/);
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(true);
  expect(screen.getByRole("checkbox", { name: "Line station" }).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Start a new selection" }));
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(false);
});
it("unlimited does not demand a quota selection", async () => {
  if (facts.observation) {
    facts.observation.future.candidate.quotas.stations = { limit: null, used: 1, remaining: null };
    facts.observation.selectionRequired = false;
  }
  setup();
  await screen.findByText(/mandatory quota selection is not required/);
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(false);
});

it("unknown 409 preserves identity and edit lock", async () => {
  setup();
  await choose();
  failure = () => response({ code: "unrecognized" }, 409);
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByText(/Outcome is unknown/);
  expect(screen.getByRole("textbox", { name: "Reason" }).matches(":disabled")).toBe(true);
  failure = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged request" }));
  await screen.findByRole("button", { name: "Save selection" });
  expect(posts[1]).toEqual(posts[0]);
});

it("deterministic stale clears the retry identity and requires explicit new preview", async () => {
  setup();
  await choose();
  failure = () =>
    response({ code: "device_retention_stale", message: "Changed", requestId: id }, 409);
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByText(/Conditions or selection revision changed/);
  expect(screen.queryByRole("button", { name: "Retry unchanged request" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview selection" })).toBeNull();
  failure = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Start a new selection" }));
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(false);
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByRole("button", { name: "Save selection" });
  expect(posts[1]?.body.requestId).not.toBe(posts[0]?.body.requestId);
});

function inputValue(element: HTMLElement) {
  if (!(element instanceof HTMLInputElement)) throw new Error("Expected input");
  return element.value;
}

it.each(["ineligible", "absent", "zero"])(
  "explicit blank draft repairs saved %s membership at its revision",
  async (mode) => {
    facts.selections = [
      { selection: structuredClone(selection), needsReview: true, boundaryReached: false },
    ];
    if (!facts.observation) throw new Error("Missing live observation");
    if (mode === "absent") facts.observation.devices = [];
    else if (mode === "ineligible") {
      const device = facts.observation.devices[0];
      if (!device) throw new Error("Missing device");
      device.eligible = false;
      device.reasons = ["device_released"];
    } else facts.observation.future.candidate.quotas.stations = { limit: 0, used: 1, remaining: 0 };
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit saved selection" }));
    expect(screen.getAllByText("Selected devices: 1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Start a blank selection" }));
    expect(screen.getByText("Selected devices: 0")).toBeTruthy();
    expect(screen.getAllByText("Selected devices: 1").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Explicit empty replacement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
    await screen.findByRole("button", { name: "Save selection" });
    expect(posts[0]?.body).toMatchObject({ expectedRevision: 1, selectedDeviceIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Original confirmation receipt" }).textContent,
      ).toContain("Selected devices: 0"),
    );
    expect(posts[1]?.body).toMatchObject({
      requestId: posts[0]?.body.requestId,
      previewId: preview.id,
    });
    expect(facts.selections[0]?.selection.selectedDeviceIds).toEqual([id]);
  },
);
it("cannot reset a saved-revision draft while outcome is uncertain across remount", async () => {
  facts.selections = [{ selection, needsReview: false, boundaryReached: false }];
  const view = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Edit saved selection" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
    target: { value: "Keep original" },
  });
  failure = () => response({}, 502);
  fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
  await screen.findByText(/Outcome is unknown/);
  const original = posts[0];
  view.unmount();
  setup(view.client);
  const reset = screen.getByRole("button", { name: "Start a blank selection" });
  expect(reset.matches(":disabled")).toBe(true);
  fireEvent.click(reset);
  expect(isChecked(screen.getByRole("checkbox", { name: "Line station" }))).toBe(true);
  failure = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Retry unchanged request" }));
  await screen.findByRole("button", { name: "Save selection" });
  expect(posts[1]).toEqual(original);
});
