import { createHash, webcrypto } from "node:crypto";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode, useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  receivingLiveRecordSchema,
  saveReceivingAmendmentSchema,
  type ReceivingDraftItem,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingEditor } from "../src/us/receiving/editor.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import { ReceivingRetainedLineEditor } from "../src/us/receiving/retained-line-editor.js";
import {
  exemptionFinalized,
  exemptionRecord,
  secondLotId,
} from "./support/us-receiving-exemption-fixture.js";
import { amendment, predecessor } from "./support/us-receiving-revision-command-fixture.js";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(
  options: {
    qa?: boolean;
    asView?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  if (amendment.content.kind !== "draft" || predecessor.content.kind !== "finalized")
    throw new Error("Expected amendment/frozen fixture");
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
            lineCount: content.draft.items.length,
            documentCount: 0,
          },
        ],
        limit: 50,
        offset: 0,
      });
    }
    if (String(url).endsWith(`/receiving/${predecessor.id}`))
      return Response.json({
        ...predecessor,
        lifecycle: { ...predecessor.lifecycle, lifecycleVersion: 5, pendingDraftId: amendment.id },
      });
    if (init?.method === "PUT") {
      const input = saveReceivingAmendmentSchema.parse(JSON.parse(String(init.body)));
      current = receivingLiveRecordSchema.parse({
        ...amendment,
        draftVersion: 2,
        content: { kind: "draft", draft: input.draft },
      });
      return Response.json({
        receiptVersion: 2,
        command: "receiving.save",
        operationKey: input.operationKey,
        eventId: amendment.id,
        record: current,
        inputDigest: createHash("sha256")
          .update(
            JSON.stringify({
              commandVersion: 2,
              command: "receiving.save",
              eventId: amendment.id,
              input,
            }),
          )
          .digest("hex"),
      });
    }
    if (String(url).endsWith(`/receiving/${amendment.id}`)) return Response.json(current);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const props = {
    client: createUsBrowserClient(send),
    initial: { ...amendment, content: amendment.content },
    predecessor: { ...predecessor, content: predecessor.content },
    canWrite: true,
    mutationPending: false,
    beginMutation: () => () => {},
    onDirtyChange: vi.fn(),
    onForbidden: vi.fn(async () => {}),
    onSessionLost: vi.fn(),
    onNotice: vi.fn(),
    onClientFailure: vi.fn(),
    onClose: vi.fn(),
    onOpenRecord: vi.fn(),
    timeZone: amendment.timeZone,
  };
  const { predecessor: unusedPredecessor, initial: unusedInitial, ...viewProps } = props;
  void unusedPredecessor;
  void unusedInitial;
  const tree = (qa: boolean) => (
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          {options.asView ? (
            <ReceivingView {...viewProps} canManageQa={qa} />
          ) : (
            <ReceivingEditor {...props} canManageQa={qa} />
          )}
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const rendered = render(tree(options.qa ?? true));
  return {
    send,
    user: userEvent.setup(),
    rerenderQa: (qa: boolean) => rendered.rerender(tree(qa)),
  };
}

describe("Bound amendment editor", () => {
  it("keeps unsaved input and locked-identity context until an explicit successful reload", async () => {
    const { user, send } = await setup({
      handle: (_url, init) =>
        init?.method === "PUT"
          ? Response.json(
              {
                code: "lot_identity_locked",
                lines: [{ lineNo: 2, fields: ["productId", "tlc", "source"] }],
              },
              { status: 409 },
            )
          : undefined,
    });
    await user.type(
      screen.getByRole("textbox", { name: "Receiving notes" }),
      "Unsubmitted correction",
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Line 2: Product, Lot code (TLC), TLC source")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Receiving notes" })).toHaveProperty(
      "value",
      expect.stringContaining("Unsubmitted correction"),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const callsBefore = send.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Reload saved draft" }));
    expect(send.mock.calls).toHaveLength(callsBefore);
    expect(screen.getByRole("textbox", { name: "Receiving notes" })).toHaveProperty(
      "value",
      expect.stringContaining("Unsubmitted correction"),
    );
    expect(screen.getByText(/Retained lot identity cannot be changed/)).toBeTruthy();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Reload saved draft" }));
    expect(screen.queryByText(/Retained lot identity cannot be changed/)).toBeNull();
    expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("retains exempt own-assignment identity while allowing fresh documentary evidence", async () => {
    const original = exemptionFinalized.snapshot.items[1];
    const input = exemptionRecord.draft.items[1];
    if (!original || !input) throw new Error("Expected own-assignment fixture");
    const changed = vi.fn();
    const initial = { ...input, lotId: secondLotId };
    const frozen = original;
    function Harness() {
      const [value, setValue] = useState<ReceivingDraftItem>(initial);
      return (
        <ReceivingRetainedLineEditor
          value={value}
          original={frozen}
          number={2}
          disabled={false}
          onRemove={() => {}}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
      );
    }
    const instance = i18next.createInstance();
    await instance.init({
      resources: { "en-US": { translation: masterDataCopy["en-US"] } },
      lng: "en-US",
      initAsync: false,
    });
    render(
      <ThemeProvider>
        <I18nextProvider i18n={instance}>
          <Harness />
        </I18nextProvider>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole("textbox", { name: "Lot code (TLC)" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "Exemption reason" }));
    await user.type(
      screen.getByRole("textbox", { name: "Exemption reason" }),
      "Corrected evidence reason",
    );
    await user.clear(screen.getByRole("textbox", { name: "Supporting evidence URL" }));
    await user.type(
      screen.getByRole("textbox", { name: "Supporting evidence URL" }),
      "https://supplier.example.test/corrected",
    );
    expect(changed.mock.lastCall?.[0]).toEqual({
      ...initial,
      exemptReason: "Corrected evidence reason",
      exemptReceipt: {
        ...initial.exemptReceipt,
        evidenceUrl: "https://supplier.example.test/corrected",
      },
    });
    expect(
      screen.getByText("This line will require a new QA review before finalization."),
    ).toBeTruthy();
  });
  it("discards local edits across QA loss and reloads saved state before QA restoration", async () => {
    const { user, rerenderQa, send } = await setup({ asView: true });
    await user.click(await screen.findByRole("button", { name: amendment.eventNumber }));
    await user.type(await screen.findByRole("textbox", { name: "Line notes" }), "Unsaved QA note");
    rerenderQa(false);
    expect(await screen.findByRole("textbox", { name: "Line notes" })).toHaveProperty("value", "");
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    rerenderQa(true);
    expect(await screen.findByRole("textbox", { name: "Line notes" })).toHaveProperty("value", "");
    expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });
  it("replays an unknown save with the exact captured operation and draft", async () => {
    let writes = 0;
    const { user, send } = await setup({
      handle: (_url, init) =>
        init?.method === "PUT" && ++writes === 1 ? Response.json({}, { status: 503 }) : undefined,
    });
    await user.type(screen.getByRole("textbox", { name: "Line notes" }), "Retry this correction");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(await screen.findByRole("button", { name: "Retry same save" }));
    await screen.findByText("Draft saved.");
    const attempts = send.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.[1]?.body).toBe(attempts[1]?.[1]?.body);
  });
  it("rejects a frozen predecessor from a different lifecycle root", async () => {
    const { user } = await setup({
      asView: true,
      handle: (url) =>
        url.endsWith(`/receiving/${predecessor.id}`)
          ? Response.json({
              ...predecessor,
              lifecycle: {
                ...predecessor.lifecycle,
                rootId: amendment.id,
                lifecycleVersion: 5,
                pendingDraftId: amendment.id,
              },
            })
          : undefined,
    });
    await user.click(await screen.findByRole("button", { name: amendment.eventNumber }));
    await screen.findByText(
      "The previous revision could not be verified. Editing remains unavailable.",
    );
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
  it("loads and verifies the immediate frozen predecessor before enabling registry-opened editing", async () => {
    const { user } = await setup({ asView: true });
    await user.click(await screen.findByRole("button", { name: amendment.eventNumber }));
    await screen.findByRole("region", { name: "Previous revision" });
    expect(screen.getByRole("textbox", { name: "Quantity" }).closest("fieldset")).toHaveProperty(
      "disabled",
      false,
    );
  });
  it("does not expose an editable amendment when the predecessor read fails", async () => {
    const { user } = await setup({
      asView: true,
      handle: (url) =>
        url.endsWith(`/receiving/${predecessor.id}`)
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await user.click(await screen.findByRole("button", { name: amendment.eventNumber }));
    await screen.findByText(
      "The previous revision could not be verified. Editing remains unavailable.",
    );
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
  it("keeps retained identity as frozen summaries and saves editable facts with L/D context", async () => {
    const { user, send } = await setup();
    expect(screen.queryByRole("combobox", { name: "Product" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Lot code (TLC)" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "TLC source" })).toBeNull();
    expect(screen.getByText("Lot identity is retained from the previous revision.")).toBeTruthy();
    const quantity = screen.getByRole("textbox", { name: "Quantity" });
    await user.clear(quantity);
    await user.type(quantity, "42.000");
    await user.clear(screen.getByRole("textbox", { name: "Supplier lot reference" }));
    await user.type(
      screen.getByRole("textbox", { name: "Supplier lot reference" }),
      "Corrected reference",
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const writes = send.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(writes).toHaveLength(1);
    const input = JSON.parse(String(writes[0]?.[1]?.body));
    expect(input).toMatchObject({
      commandVersion: 2,
      expectedLifecycleVersion: 5,
      expectedDraftVersion: 1,
    });
    expect(input.draft.items[0]).toMatchObject({
      previousLineNo: 1,
      quantity: "42.000",
      supplierLotReference: "Corrected reference",
    });
    expect(input.draft.items[0].lotId).toBe(
      amendment.content.kind === "draft" ? amendment.content.draft.items[0]?.lotId : null,
    );
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveProperty("value", "42.000");
  });
  it("preserves predecessor bindings on reorder/remove and gives added lines no binding", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Move line down" }));
    await user.click(screen.getByRole("button", { name: "Remove line" }));
    const comparison = screen.getByRole("region", { name: "Previous revision" });
    expect(within(comparison).getByText("Removed from correction")).toBeTruthy();
    expect(within(comparison).getByText("Supplier-0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add line" }));
    expect(screen.getByRole("textbox", { name: "Lot code (TLC)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const write = send.mock.calls.find(([, init]) => init?.method === "PUT");
    const input = JSON.parse(String(write?.[1]?.body));
    expect(
      input.draft.items.map((line: { previousLineNo: number | null }) => line.previousLineNo),
    ).toEqual([2, 3, null]);
  });
  it("does not grant amendment editing from receiving-write permission without QA", async () => {
    const { user, rerenderQa, send } = await setup({ qa: false });
    expect(screen.getByRole("textbox", { name: "Quantity" }).closest("fieldset")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    rerenderQa(true);
    await user.clear(screen.getByRole("textbox", { name: "Quantity" }));
    await user.type(screen.getByRole("textbox", { name: "Quantity" }), "3");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("retries only the current read after an acknowledged amendment save", async () => {
    let reads = 0;
    const { user, send } = await setup({
      handle: (url, init) =>
        url.endsWith(`/receiving/${amendment.id}`) && init?.method === "GET" && ++reads === 1
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await user.type(screen.getByRole("textbox", { name: "Line notes" }), "Documentary correction");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.click(await screen.findByRole("button", { name: "Retry current state" }));
    await screen.findByText("Draft saved.");
    expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(reads).toBe(2);
  });
});
