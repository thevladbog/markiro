import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode, useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import {
  amendReceivingSchema,
  voidReceivingSchema,
  receivingLiveRecordSchema,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import {
  predecessor,
  amendment,
  amendmentId,
} from "./support/us-receiving-revision-command-fixture.js";
import { id, lotId } from "./support/us-receiving-finalization-fixture.js";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const path = `/api/us/traceability/receiving/${id}`;
async function setup(
  options: {
    qa?: boolean;
    locale?: "en-US" | "es-US";
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current = predecessor;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (String(url).endsWith("/amend") || String(url).endsWith("/void")) {
      const action = String(url).endsWith("/amend") ? "amend" : "void";
      const input = (action === "amend" ? amendReceivingSchema : voidReceivingSchema).parse(
        JSON.parse(String(init?.body)),
      );
      current = receivingLiveRecordSchema.parse(
        action === "amend"
          ? {
              ...amendment,
              lifecycle: { ...amendment.lifecycle, amendmentReason: input.reason },
            }
          : {
              ...predecessor,
              status: "void",
              lifecycle: {
                ...predecessor.lifecycle,
                lifecycleVersion: 5,
                currentEventId: null,
                voidReason: input.reason,
                voidedBy: predecessor.updatedBy,
                voidedAt: predecessor.updatedAt,
              },
            },
      );
      const command = `receiving.${action}`;
      return Response.json(
        {
          receiptVersion: 2,
          command,
          operationKey: input.operationKey,
          eventId: current.id,
          record: current,
          inputDigest: createHash("sha256")
            .update(JSON.stringify({ commandVersion: 2, command, eventId: id, input }))
            .digest("hex"),
        },
        { status: action === "amend" ? 201 : 200 },
      );
    }
    if (url === path || url === `/api/us/traceability/receiving/${amendmentId}`)
      return Response.json(current);
    if (String(url).includes("/receiving-basis"))
      return Response.json({
        lotId,
        basisVersion: 3,
        state: "present",
        supportCount: 1,
        items: [
          {
            rootId: id,
            eventId: id,
            eventNumber: predecessor.eventNumber,
            revision: 1,
            lineNos: [1],
          },
        ],
        limit: 1,
        offset: 0,
        hasMore: false,
      });
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onSessionLost = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const client = createUsBrowserClient(send);
  function Harness({ qa }: { qa: boolean }) {
    const [locked, setLocked] = useState(false);
    if (predecessor.content.kind !== "finalized") throw new Error("Expected frozen fixture");
    return (
      <>
        <button disabled={locked}>Workspace navigation</button>
        <ReceivingView
          client={client}
          canWrite
          canManageQa={qa}
          timeZone="America/Chicago"
          initialRecord={{ ...predecessor, content: predecessor.content }}
          mutationPending={locked}
          beginMutation={() => {
            setLocked(true);
            return () => setLocked(false);
          }}
          onDirtyChange={() => {}}
          onNotice={() => {}}
          onClientFailure={() => {}}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
        />
      </>
    );
  }
  const tree = (qa: boolean) => (
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <Harness qa={qa} />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const rendered = render(tree(options.qa ?? true));
  return {
    send,
    user: userEvent.setup(),
    onSessionLost,
    onForbidden,
    rerenderQa: (qa: boolean) => rendered.rerender(tree(qa)),
  };
}
describe("Receiving lifecycle dialogs and current-state recovery", () => {
  it("requires a reason and blocks duplicate confirmation and navigation while amendment settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    const { user, send } = await setup({
      handle: (url) => {
        if (url.endsWith("/amend") && ++posts === 1)
          return gate.then(() =>
            Response.json({ code: "us_database_unavailable" }, { status: 503 }),
          );
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Start correction" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "Correct receipt notes",
    );
    act(() => {
      const button = within(dialog).getByRole("button", { name: "Start correction" });
      button.click();
      button.click();
    });
    expect(screen.getByRole("button", { name: "Workspace navigation" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Back to receiving" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => release?.());
    await user.click(await screen.findByRole("button", { name: "Retry same operation" }));
    await screen.findByRole("heading", { name: predecessor.eventNumber });
    expect(screen.queryByRole("dialog")).toBeNull();
    const bodies = send.mock.calls
      .filter(([url]) => String(url).endsWith("/amend"))
      .map(([, init]) => init?.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(
      send.mock.calls.some(
        ([url, init]) =>
          url === `/api/us/traceability/receiving/${amendmentId}` && init?.method === "GET",
      ),
    ).toBe(true);
  });
  it("previews lost-last-basis lots and retries only GET after an acknowledged void", async () => {
    let reads = 0;
    const { user, send } = await setup({
      handle: (url) => {
        if (url === path && ++reads === 1)
          return Response.json({ code: "unavailable" }, { status: 503 });
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Void receipt" }));
    await screen.findByText("Lots losing their last receiving basis");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Receipt withdrawn");
    await user.click(screen.getByRole("button", { name: "Confirm void" }));
    await screen.findByText(/operation was acknowledged/);
    expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry current state" }));
    await screen.findByText(/This receipt is void/);
    expect(send.mock.calls.filter(([url]) => String(url).endsWith("/void"))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Correct receipt" })).toBeNull();
  });
  it("does not permit void while basis preview is unavailable", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.includes("/receiving-basis") ? Response.json({}, { status: 503 }) : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Void receipt" }));
    await screen.findByText("Receiving basis could not be checked. Retry before confirming.");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Withdraw");
    expect(screen.getByRole("button", { name: "Confirm void" })).toHaveProperty("disabled", true);
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("clears the dialog on QA loss and never restores its reason", async () => {
    const { user, rerenderQa } = await setup();
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Private correction");
    rerenderQa(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerenderQa(true);
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "");
  });
  it("ignores a late acknowledged read after QA loss even when a new dialog is open", async () => {
    let releaseRead: ((response: Response) => void) | undefined;
    const heldRead = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    const target = `/api/us/traceability/receiving/${amendmentId}`;
    const { user, send, rerenderQa } = await setup({
      handle: (url) => (url === target ? heldRead : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Old acknowledged correction");
    await user.click(screen.getByRole("button", { name: "Start correction" }));
    await waitFor(() => expect(send.mock.calls.some(([url]) => url === target)).toBe(true));
    rerenderQa(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerenderQa(true);
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "New unsent reason");
    await act(async () => {
      releaseRead?.(Response.json(amendment));
    });
    expect(screen.getByRole("dialog", { name: "Correct receipt" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveProperty(
      "value",
      "New unsent reason",
    );
    expect(screen.getByRole("button", { name: "Workspace navigation" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("region", { name: "Previous revision" })).toBeNull();
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("routes session loss through the existing boundary and clears the protected dialog", async () => {
    const { user, onSessionLost } = await setup({
      handle: (url) => (url.endsWith("/amend") ? Response.json({}, { status: 401 }) : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Correction");
    await user.click(screen.getByRole("button", { name: "Start correction" }));
    expect(onSessionLost).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("refreshes capabilities and releases the dialog lock after a forbidden mutation", async () => {
    const { user, onForbidden } = await setup({
      handle: (url) => (url.endsWith("/amend") ? Response.json({}, { status: 403 }) : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Correction");
    await user.click(screen.getByRole("button", { name: "Start correction" }));
    expect(onForbidden).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace navigation" })).toHaveProperty(
      "disabled",
      false,
    );
  });
  it("reloads current state without resending a rejected operation", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith("/amend")
          ? Response.json({ code: "receiving_draft_conflict" }, { status: 409 })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Correct receipt" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Correction");
    await user.click(screen.getByRole("button", { name: "Start correction" }));
    await user.click(await screen.findByRole("button", { name: "Reload current record" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send.mock.calls.filter(([url]) => String(url).endsWith("/amend"))).toHaveLength(1);
  });
  it.each([
    {
      locale: "en-US" as const,
      open: "Correct receipt",
      reason: "Reason",
      submit: "Start correction",
      reload: "Reload current record",
      explanation: /A correction draft is already pending/,
    },
    {
      locale: "es-US" as const,
      open: "Corregir recepción",
      reason: "Motivo",
      submit: "Iniciar corrección",
      reload: "Recargar registro actual",
      explanation: /Ya hay un borrador de corrección pendiente/,
    },
  ])(
    "explains a pending correction in $locale without repeating the command",
    async ({ locale, open, reason, submit, reload, explanation }) => {
      let rejected = false;
      let failRead = true;
      const { user, send } = await setup({
        locale,
        handle: (url) => {
          if (url.endsWith("/amend")) {
            rejected = true;
            return Response.json(
              { code: "receiving_pending_amendment", pendingDraftId: amendmentId },
              { status: 409 },
            );
          }
          if (rejected && failRead && url === path) return Response.json({}, { status: 503 });
          return undefined;
        },
      });
      await user.click(screen.getByRole("button", { name: open }));
      await user.type(screen.getByRole("textbox", { name: reason }), "Keep this correction reason");
      await user.click(screen.getByRole("button", { name: submit }));
      expect(await screen.findByText(explanation)).toBeTruthy();
      expect(screen.getByRole("textbox", { name: reason })).toHaveProperty(
        "value",
        "Keep this correction reason",
      );
      expect(screen.queryByRole("button", { name: submit })).toBeNull();
      await user.click(screen.getByRole("button", { name: reload }));
      expect(screen.getByText(explanation)).toBeTruthy();
      expect(screen.getByRole("textbox", { name: reason })).toHaveProperty(
        "value",
        "Keep this correction reason",
      );
      failRead = false;
      await user.click(screen.getByRole("button", { name: reload }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(explanation)).toBeNull();
      expect(send.mock.calls.filter(([url]) => String(url).endsWith("/amend"))).toHaveLength(1);
    },
  );
  it("uses Spanish operation copy without enabling actions for a reader", async () => {
    const { user, rerenderQa } = await setup({ locale: "es-US", qa: false });
    expect(screen.queryByRole("button", { name: "Corregir recepción" })).toBeNull();
    rerenderQa(true);
    await user.click(screen.getByRole("button", { name: "Corregir recepción" }));
    expect(screen.getByRole("textbox", { name: "Motivo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Iniciar corrección" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
