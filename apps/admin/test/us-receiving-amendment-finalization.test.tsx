import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import {
  amendment,
  amendmentFinalized,
  predecessor,
} from "./support/us-receiving-revision-command-fixture.js";
import { complete } from "./support/us-receiving-finalization-fixture.js";
import { ReceivingExemptionReview } from "../src/us/receiving/exemption-review.js";
import {
  exemptionRecord,
  firstLotId,
  secondLotId,
} from "./support/us-receiving-exemption-fixture.js";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const readiness = {
  ...complete,
  eventId: amendment.id,
  draftVersion: 1,
  ruleVersion: "receiving-readiness-v4",
  rootId: amendment.lifecycle.rootId,
  expectedLifecycleVersion: 5,
  previousRevisionId: predecessor.id,
};

async function setup(
  options: {
    qa?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current = amendment;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (String(url).includes("/receiving?")) {
      const { content, ...header } = amendment;
      if (content.kind !== "draft") throw new Error("Expected draft");
      return Response.json({
        items: [
          {
            ...header,
            dateReceived: content.draft.dateReceived,
            locationId: content.draft.locationId,
            previousSourceLocationId: content.draft.previousSourceLocationId,
            lineCount: 3,
            documentCount: 0,
          },
        ],
        limit: 50,
        offset: 0,
      });
    }
    if (String(url).includes("/readiness?")) return Response.json(readiness);
    if (String(url).endsWith("/finalize")) {
      const input = JSON.parse(String(init?.body));
      current = amendmentFinalized;
      return Response.json({
        receiptVersion: 2,
        command: "receiving.finalize",
        eventId: amendment.id,
        operationKey: input.operationKey,
        inputDigest: createHash("sha256")
          .update(
            JSON.stringify({
              commandVersion: 2,
              command: "receiving.finalize",
              eventId: amendment.id,
              input,
            }),
          )
          .digest("hex"),
        record: current,
      });
    }
    if (String(url).endsWith(`/receiving/${amendment.id}`)) return Response.json(current);
    if (String(url).endsWith(`/receiving/${predecessor.id}`))
      return Response.json({
        ...predecessor,
        lifecycle: { ...predecessor.lifecycle, lifecycleVersion: 5, pendingDraftId: amendment.id },
      });
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
  });
  const props = {
    client: createUsBrowserClient(send),
    canWrite: true,
    mutationPending: false,
    beginMutation: () => () => {},
    onDirtyChange: vi.fn(),
    onForbidden: vi.fn(async () => {}),
    onSessionLost: vi.fn(),
    onNotice: vi.fn(),
    onClientFailure: vi.fn(),
    timeZone: amendment.timeZone,
  };
  const tree = (qa: boolean) => (
    <StrictMode>
      <ThemeProvider>
        <I18nextProvider i18n={instance}>
          <ReceivingView {...props} canManageQa={qa} />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const rendered = render(tree(options.qa ?? true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: amendment.eventNumber }));
  await screen.findByRole("region", { name: "Previous revision" });
  return { user, send, rerenderQa: (qa: boolean) => rendered.rerender(tree(qa)), ...props };
}
const writes = (send: ReturnType<typeof vi.fn<typeof fetch>>) =>
  send.mock.calls.filter(([url]) => String(url).endsWith("/finalize"));
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Check saved draft" }));
  await user.click(await screen.findByRole("button", { name: "Finalize" }));
  return screen.findByRole("dialog");
}

describe("Amendment saved check and finalization", () => {
  it("shows a retained own TLC as previously assigned and requires fresh review of every exempt line", async () => {
    const instance = i18next.createInstance();
    await instance.init({
      resources: { "en-US": { translation: masterDataCopy["en-US"] } },
      lng: "en-US",
      initAsync: false,
    });
    const record = {
      ...amendment,
      content: {
        kind: "draft" as const,
        draft: {
          ...exemptionRecord.draft,
          items: exemptionRecord.draft.items.map((item, index) => ({
            ...item,
            lotId: index === 0 ? firstLotId : secondLotId,
            previousLineNo: index + 1,
          })),
        },
      },
    };
    render(
      <ThemeProvider>
        <I18nextProvider i18n={instance}>
          <ReceivingExemptionReview
            record={record}
            requiredLines={[1, 2]}
            reviewedLines={[]}
            disabled={false}
            onChange={() => {}}
            labels={{ products: new Map(), locations: new Map() }}
          />
        </I18nextProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText("Previously assigned TLC")).toBeTruthy();
    expect(screen.queryByText("Proposed TLC for own assignment")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("=OWN/Ä-4001")).toBeTruthy();
  });
  it("keeps a known acknowledgement and retries only current GET", async () => {
    let committed = false;
    let reads = 0;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url.endsWith("/finalize")) committed = true;
        if (
          committed &&
          init?.method === "GET" &&
          url.endsWith(`/receiving/${amendment.id}`) &&
          ++reads === 1
        )
          return Response.json({}, { status: 503 });
        return undefined;
      },
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await user.click(await screen.findByRole("button", { name: "Retry current state" }));
    await screen.findByText("Finalized", { exact: true });
    expect(writes(send)).toHaveLength(1);
    expect(reads).toBe(2);
  });
  it("requires reload after a structured lifecycle conflict, not another finalize attempt", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/finalize")
          ? Response.json(
              { code: "lot_identity_locked", lines: [{ lineNo: 1, fields: ["lotId"] }] },
              { status: 409 },
            )
          : undefined,
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await screen.findByRole("button", { name: "Reload current record" });
    expect(screen.getByText(/Retained lot identity cannot be changed/)).toBeTruthy();
    expect(screen.getByText("Line 1: Lot")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check saved draft" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
    expect(writes(send)).toHaveLength(1);
  });
  it("explains the lifecycle conflict returned by a saved-draft check", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.includes("/readiness?")
          ? Response.json(
              {
                code: "receiving_lifecycle_conflict",
                rootId: amendment.lifecycle.rootId,
                lifecycleVersion: 6,
                currentEventId: amendment.id,
                pendingDraftId: null,
              },
              { status: 409 },
            )
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    expect(await screen.findByText(/The receipt lifecycle has changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check saved draft" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(writes(send)).toHaveLength(0);
  });
  it("checks the exact predecessor and finalizes with captured L/D/digest while distinguishing retained lots", async () => {
    const { user, send } = await setup();
    const dialog = await confirm(user);
    expect(
      within(dialog).getByText("Lines: 3 · Retained lots: 3 · New lots: 0 · Linked lots: 0"),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Confirm finalization" }));
    await screen.findByText("Finalized", { exact: true });
    expect(writes(send)).toHaveLength(1);
    expect(JSON.parse(String(writes(send)[0]?.[1]?.body))).toMatchObject({
      commandVersion: 2,
      expectedLifecycleVersion: 5,
      expectedDraftVersion: 1,
      previousRevisionId: predecessor.id,
      expectedInputDigest: "a".repeat(64),
      reviewedExemptLines: [],
    });
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
  it("cannot use a check from another predecessor", async () => {
    const { user } = await setup({
      handle: (url) =>
        url.includes("/readiness?")
          ? Response.json({
              ...readiness,
              previousRevisionId: "f0000000-0000-4000-8000-000000000001",
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByRole("button", { name: "Reload saved event" });
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
  });
  it("retries an unknown finalize with identical input and operation key", async () => {
    let posts = 0;
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/finalize") && ++posts === 1 ? Response.json({}, { status: 503 }) : undefined,
    });
    await confirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
    await user.click(await screen.findByRole("button", { name: "Retry same finalization" }));
    await screen.findByText("Finalized", { exact: true });
    expect(writes(send)).toHaveLength(2);
    expect(writes(send)[0]?.[1]?.body).toBe(writes(send)[1]?.[1]?.body);
  });
  it("discards pending check responses across QA loss and restoration", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const deferred = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user, rerenderQa, send } = await setup({
      handle: (url) => (url.includes("/readiness?") ? deferred : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    expect(send.mock.calls.some(([url]) => String(url).includes("/readiness?"))).toBe(true);
    rerenderQa(false);
    await screen.findByRole("region", { name: "Previous revision" });
    await act(async () => {
      resolve?.(Response.json(readiness));
    });
    rerenderQa(true);
    await screen.findByRole("region", { name: "Previous revision" });
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
    expect(writes(send)).toHaveLength(0);
  });
});
