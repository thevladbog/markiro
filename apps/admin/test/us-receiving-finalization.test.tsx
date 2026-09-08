import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import { receivingQuantityTotals } from "../src/us/receiving/quantity-totals.js";
import { liveFinalized } from "./support/us-receiving-command-fixture.js";
import { liveFixture, liveReadFixtureResponse } from "./support/us-receiving-live-fixture.js";
import { receivingRecordSchema, type ReceivingRecord } from "@markiro/platform-contracts";
import {
  complete,
  finalized,
  id,
  lotId,
  path,
  record,
} from "./support/us-receiving-finalization-fixture.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function setup(
  options: {
    qa?: boolean;
    finalized?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current: ReceivingRecord = options.finalized ? finalized : record;
  const source: typeof fetch = async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (String(url).startsWith(`${path}?`)) {
      const { draft, ...header } = record;
      return Response.json({
        items: [
          {
            ...header,
            status: options.finalized ? "finalized" : "draft",
            dateReceived: draft.dateReceived,
            locationId: draft.locationId,
            previousSourceLocationId: draft.previousSourceLocationId,
            lineCount: 3,
            documentCount: 0,
          },
        ],
        limit: 50,
        offset: 0,
      });
    }
    if (url === `${path}/${id}`) return Response.json(current);
    if (String(url).includes("/readiness")) return Response.json(complete);
    if (String(url).endsWith("/finalize")) return Response.json(finalized);
    return Response.json({ items: [], limit: 50, offset: 0 });
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const response = await source(url, init);
    if (init?.method !== "GET" && response.ok) {
      const parsed = receivingRecordSchema.safeParse(await response.clone().json());
      if (parsed.success) current = parsed.data;
    }
    return liveReadFixtureResponse(String(url), init, response);
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onSessionLost = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const onOpenLot = vi.fn();
  const props = {
    client: createUsBrowserClient(send),
    canWrite: true,
    canManageQa: options.qa ?? true,
    mutationPending: false,
    beginMutation: () => () => {},
    onDirtyChange: vi.fn(),
    onForbidden,
    onSessionLost,
    onNotice: vi.fn(),
    onClientFailure: vi.fn(),
    timeZone: "America/Chicago",
    onOpenLot,
  };
  const tree = (qa = props.canManageQa) => (
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <ReceivingView {...props} canManageQa={qa} />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const view = render(tree());
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: record.eventNumber }));
  await screen.findByRole("heading", { name: record.eventNumber });
  return { user, send, onSessionLost, onForbidden, onOpenLot, ...view, tree };
}
const finalizeCalls = (send: ReturnType<typeof vi.fn<typeof fetch>>) =>
  send.mock.calls.filter(([url]) => String(url).endsWith("/finalize"));
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Check saved draft" }));
  await user.click(await screen.findByRole("button", { name: "Finalize" }));
  return screen.findByRole("dialog");
}

describe("ordinary receiving confirmation", () => {
  it("labels v3 predecessor lot bindings as retained, never newly created", async () => {
    if (
      liveFinalized.content.kind !== "finalized" ||
      liveFinalized.content.snapshot.snapshotVersion !== 3
    )
      throw new Error("Expected frozen v3 specimen");
    const predecessor = "c0000000-0000-4000-8000-000000000001";
    const current = {
      ...liveFinalized,
      revision: 2,
      lifecycle: {
        ...liveFinalized.lifecycle,
        rootId: predecessor,
        lifecycleVersion: 4,
        previousRevisionId: predecessor,
        amendmentReason: "Correct quantity",
      },
      content: {
        ...liveFinalized.content,
        snapshot: {
          ...liveFinalized.content.snapshot,
          items: liveFinalized.content.snapshot.items.map((item) => ({
            ...item,
            lotBinding: {
              kind: "retained",
              previousEventId: predecessor,
              previousLineNo: item.lineNo,
            },
          })),
        },
      },
    };
    await setup({
      finalized: true,
      handle: (url, init) =>
        url === `${path}/${id}` && init?.method === "GET" ? Response.json(current) : undefined,
    });
    expect(await screen.findAllByText("Retained from previous revision")).toHaveLength(3);
    expect(screen.queryByText("Created at finalization")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
  it("reads current lifecycle after a historical finalize acknowledgement and renders Void", async () => {
    let acknowledged = false;
    const current = {
      ...liveFinalized,
      status: "void",
      lifecycle: {
        ...liveFinalized.lifecycle,
        lifecycleVersion: 3,
        currentEventId: null,
        voidReason: "Duplicate receipt",
        voidedAt: "2026-09-08T10:00:00.000Z",
        voidedBy: "qa-user",
      },
    };
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url.endsWith("/finalize")) {
          acknowledged = true;
          return Response.json(finalized);
        }
        if (url === `${path}/${id}` && init?.method === "GET" && acknowledged)
          return Response.json(current);
        return undefined;
      },
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await screen.findByText("Void", { exact: true });
    expect(screen.getByText("Duplicate receipt")).toBeTruthy();
    expect(screen.getAllByText("Frozen apples")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(finalizeCalls(send)).toHaveLength(1);
  });
  it("retries only the current read when finalization succeeded but its recovery read failed", async () => {
    let acknowledged = false;
    let reads = 0;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url.endsWith("/finalize")) {
          acknowledged = true;
          return Response.json(finalized);
        }
        if (url === `${path}/${id}` && init?.method === "GET" && acknowledged)
          return reads++ === 0 ? Response.json({}, { status: 503 }) : Response.json(liveFinalized);
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    const retry = await screen.findByRole("button", { name: "Retry current state" });
    expect(screen.queryByText("Draft saved.")).toBeNull();
    expect(screen.getAllByText(/Current state not confirmed/)).toHaveLength(2);
    await user.click(retry);
    await screen.findByText("qa-user");
    expect(finalizeCalls(send)).toHaveLength(1);
    expect(reads).toBe(2);
  });
  it("cannot make a fresh attempt when current-record recovery fails", async () => {
    let gets = 0;
    const { user } = await setup({
      handle: (url, init) => {
        if (url.endsWith("/finalize")) return Promise.reject(new TypeError("unknown"));
        if (url === `${path}/${id}` && init?.method === "GET" && gets++ > 0)
          return Promise.reject(new TypeError("reload failed"));
        return undefined;
      },
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await user.click(await screen.findByRole("button", { name: "Reload current record" }));
    await screen.findByText(/saved draft could not be loaded/);
    expect(screen.getByRole("button", { name: "Check saved draft" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
  });
  it("adds large mixed-scale decimals exactly without combining different units", () => {
    expect(
      receivingQuantityTotals([
        { quantity: "999999999999999.999", unitOfMeasure: "lb" },
        { quantity: "0.001", unitOfMeasure: "lb" },
        { quantity: "2", unitOfMeasure: "kg" },
        { quantity: "0.25", unitOfMeasure: "kg" },
      ]),
    ).toEqual([
      { unit: "lb", quantity: "1000000000000000.000" },
      { unit: "kg", quantity: "2.25" },
    ]);
    expect(() => receivingQuantityTotals([{ quantity: null, unitOfMeasure: "lb" }])).toThrow();
  });
  it("refreshes a historical save replay before allowing any more editing", async () => {
    let saves = 0;
    let gets = 0;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url !== `${path}/${id}`) return undefined;
        if (init?.method === "PUT")
          return saves++ === 0
            ? Promise.reject(new TypeError("lost save response"))
            : Response.json(record);
        if (init?.method === "GET" && gets++ > 0) return Response.json(finalized);
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(await screen.findByRole("button", { name: "Retry same save" }));
    await screen.findByText("qa-user");
    expect(screen.queryByLabelText("Quantity")).toBeNull();
    expect(
      send.mock.calls.filter(([url, init]) => url === `${path}/${id}` && init?.method === "GET"),
    ).toHaveLength(2);
  });
  it("invalidates a complete check when document metadata becomes dirty", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByRole("button", { name: "Finalize" });
    await user.click(screen.getByText("Create document metadata", { exact: true }));
    await user.type(screen.getByLabelText("Document number"), "unsaved");
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });
  it("requires a current saved check, shows exact per-unit totals and mixed lot counts, and cancels without saving", async () => {
    const { user, send } = await setup();
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
    const dialog = await confirm(user);
    expect(within(dialog).getByText("500.250 lb")).toBeTruthy();
    expect(within(dialog).getByText("999999999999999.999 kg")).toBeTruthy();
    expect(within(dialog).getByText(/New lots: 2 · Linked lots: 1/)).toBeTruthy();
    expect(within(dialog).getByText("2026-09-07 · America/Chicago")).toBeTruthy();
    expect(
      within(dialog).getByText(/Consider linking at least one reference document/),
    ).toBeTruthy();
    await user.click(within(dialog).getAllByRole("button", { name: "Cancel" })[1]!);
    expect(finalizeCalls(send)).toHaveLength(0);
    expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "500.000");
  });
  it("never offers finalization to a non-QA reader and invalidates when QA is lost", async () => {
    const { user, rerender, tree } = await setup({ qa: false });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText(/Complete — no blockers/);
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
    rerender(tree(true));
    await confirm(user);
    rerender(tree(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(tree(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });
  it("shows strictly typed server blockers with their line context", async () => {
    const { user } = await setup({
      handle: (url) =>
        url.endsWith("/finalize")
          ? Response.json(
              {
                code: "event_incomplete",
                issues: [
                  {
                    severity: "error",
                    group: "lines",
                    line: 2,
                    field: "lot",
                    code: "inactive",
                    detail: null,
                  },
                ],
              },
              { status: 409 },
            )
          : undefined,
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await screen.findByText(/Saved data or references have changed/);
    expect(
      screen.getAllByRole("alert").some((element) => element.textContent?.includes("Line 2")),
    ).toBe(true);
  });
  it("invalidates after editing and rejects a late readiness response", async () => {
    let release: ((response: Response) => void) | undefined;
    const { user } = await setup({
      handle: (url) =>
        url.includes("/readiness")
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.type(screen.getByLabelText("Receiving notes"), "Changed");
    await act(async () => release?.(Response.json(complete)));
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });
  it("blocks duplicate sends and dismissal while pending, then displays frozen history and explicit lot navigation", async () => {
    let release: ((response: Response) => void) | undefined;
    const { user, send, onOpenLot } = await setup({
      handle: (url) =>
        url.endsWith("/finalize")
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    const dialog = await confirm(user);
    const button = within(dialog).getByRole("button", { name: "Confirm finalization" });
    await user.dblClick(button);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(finalizeCalls(send)).toHaveLength(1);
    await act(async () => release?.(Response.json(finalized)));
    expect(await screen.findByText("qa-user")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.getAllByText("Frozen apples")).toHaveLength(3);
    await user.click(screen.getAllByRole("button", { name: "Open current lot" })[0]!);
    expect(onOpenLot).toHaveBeenCalledWith(lotId, liveFixture(finalized));
    expect(screen.getByRole("button", { name: "Correct receipt" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Void receipt" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });
  it("retries an unknown result with exactly the same key and body", async () => {
    let attempts = 0;
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/finalize") && attempts++ === 0
          ? Promise.reject(new TypeError("network"))
          : undefined,
    });
    const dialog = await confirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Confirm finalization" }));
    await user.click(await screen.findByRole("button", { name: "Retry same finalization" }));
    await screen.findByText("qa-user");
    const calls = finalizeCalls(send);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
  });
  it("keeps a mismatched acknowledgement uncertain and reloads current state before a fresh attempt", async () => {
    let gets = 0;
    const { user, send } = await setup({
      handle: (url, init) =>
        url.endsWith("/finalize")
          ? Response.json({ ...finalized, draftVersion: 8 })
          : url === `${path}/${id}` && init?.method === "GET" && gets++ > 0
            ? Response.json(finalized)
            : undefined,
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await screen.findByRole("button", { name: "Retry same finalization" });
    await user.click(screen.getByRole("button", { name: "Reload current record" }));
    await screen.findByText("qa-user");
    expect(finalizeCalls(send)).toHaveLength(1);
  });
  it.each([401, 403, 409])("handles HTTP %i without discarding saved context", async (status) => {
    const { user, onSessionLost, onForbidden } = await setup({
      handle: (url) =>
        url.endsWith("/finalize")
          ? Response.json({ code: "receiving_readiness_changed" }, { status })
          : undefined,
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    if (status === 401) await waitFor(() => expect(onSessionLost).toHaveBeenCalledOnce());
    else if (status === 403) await waitFor(() => expect(onForbidden).toHaveBeenCalledOnce());
    else {
      await screen.findByText(/Saved data or references have changed/);
      expect(screen.queryByRole("button", { name: "Confirm finalization" })).toBeNull();
      expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "500.000");
    }
  });
  it("opens finalized records directly using frozen labels without reference requests", async () => {
    const { send, user } = await setup({ finalized: true });
    expect(screen.getAllByText("Frozen apples")).toHaveLength(3);
    expect(send.mock.calls.every(([url]) => String(url).startsWith(path))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    expect(await screen.findByRole("button", { name: record.eventNumber })).toBeTruthy();
  });
});
