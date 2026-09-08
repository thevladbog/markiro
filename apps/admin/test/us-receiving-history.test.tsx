import { webcrypto } from "node:crypto";
import { act, cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode, useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { receivingLiveRecordSchema, type ReceivingLiveRecord } from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReceivingView } from "../src/us/receiving/view.js";
import {
  predecessor,
  amendment,
  amendmentFinalized,
} from "./support/us-receiving-revision-command-fixture.js";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const old = receivingLiveRecordSchema.parse({
  ...predecessor,
  status: "amended",
  lifecycle: {
    ...predecessor.lifecycle,
    lifecycleVersion: 6,
    currentEventId: amendmentFinalized.id,
    supersededByEventId: amendmentFinalized.id,
    supersededAt: predecessor.updatedAt,
    supersededBy: predecessor.updatedBy,
  },
});
function summary(record: ReceivingLiveRecord) {
  const { content, ...header } = record;
  const data = content.kind === "draft" ? content.draft : content.snapshot;
  return {
    ...header,
    dateReceived: data.dateReceived,
    locationId: data.locationId,
    previousSourceLocationId: data.previousSourceLocationId,
    lineCount: data.items.length,
    documentCount:
      content.kind === "draft"
        ? content.draft.documentIds.length
        : content.snapshot.documents.length,
  };
}
async function setup(
  options: {
    initial?: ReceivingLiveRecord;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const records = [old, amendmentFinalized];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (String(url).includes("/revisions?"))
      return Response.json({
        items: records.map(summary),
        limit: 50,
        offset: 0,
        lifecycleVersion: 6,
      });
    if (String(url).includes("/receiving?"))
      return Response.json({ items: records.map(summary), limit: 50, offset: 0 });
    const record = records.find((value) => String(url).endsWith(`/receiving/${value.id}`));
    if (record) return Response.json(record);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
  });
  const onSessionLost = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const client = createUsBrowserClient(send);
  function Harness() {
    const [locked, setLocked] = useState(false);
    const initial = options.initial ?? amendmentFinalized;
    if (initial.content.kind !== "finalized") throw new Error("Frozen initial required");
    return (
      <ReceivingView
        client={client}
        canWrite
        canManageQa
        timeZone={initial.timeZone}
        initialRecord={{ ...initial, content: initial.content }}
        mutationPending={locked}
        beginMutation={() => {
          setLocked(true);
          return () => setLocked(false);
        }}
        onDirtyChange={() => {}}
        onNotice={() => {}}
        onClientFailure={() => {}}
        onSessionLost={onSessionLost}
        onForbidden={onForbidden}
      />
    );
  }
  const rendered = render(
    <StrictMode>
      <ThemeProvider>
        <I18nextProvider i18n={instance}>
          <Harness />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  return { ...rendered, user: userEvent.setup(), send, onSessionLost, onForbidden };
}

describe("Receiving exact revision navigation", () => {
  it("pages bounded history and distinguishes an empty later page from failure", async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      ...summary(amendmentFinalized),
      id: `f1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      revision: index + 2,
      status: "void",
      lifecycle: {
        ...amendmentFinalized.lifecycle,
        voidedAt: predecessor.updatedAt,
        voidedBy: predecessor.updatedBy,
        voidReason: "Abandoned draft",
      },
    }));
    const { user, send } = await setup({
      handle: (url) => {
        if (!url.includes("/revisions?")) return undefined;
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
        return Response.json({
          items: offset === 0 ? items : [],
          limit: 50,
          offset,
          lifecycleVersion: 6,
        });
      },
    });
    await user.click(screen.getByRole("button", { name: "Show revision history" }));
    const history = await screen.findByRole("region", { name: "Revision history" });
    await user.click(await within(history).findByRole("button", { name: "Next page" }));
    expect(await within(history).findByText("No revisions on this page.")).toBeTruthy();
    expect(within(history).queryByRole("alert")).toBeNull();
    expect(
      (within(history).getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(history).getByRole("button", { name: "Previous page" }));
    expect(await within(history).findByRole("button", { name: "Open revision 51" })).toBeTruthy();
    expect(
      send.mock.calls
        .filter(([url]) => String(url).includes("/revisions?"))
        .map(([url]) => String(url).split("?")[1]),
    ).toEqual(["limit=50&offset=0", "limit=50&offset=50", "limit=50&offset=0"]);
  });
  it.each([401, 403])(
    "delegates %s history read denial without displaying protected rows",
    async (status) => {
      const { user, onSessionLost, onForbidden } = await setup({
        handle: (url) => (url.includes("/revisions?") ? Response.json({}, { status }) : undefined),
      });
      await user.click(screen.getByRole("button", { name: "Show revision history" }));
      await waitFor(() =>
        expect(status === 401 ? onSessionLost : onForbidden).toHaveBeenCalledOnce(),
      );
      expect(screen.queryByRole("button", { name: "Open revision 1" })).toBeNull();
    },
  );
  it("opens the selected historical revision without redirecting to current", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Show revision history" }));
    const history = await screen.findByRole("region", { name: "Revision history" });
    await user.click(await within(history).findByRole("button", { name: "Open revision 1" }));
    expect(
      await screen.findByText(
        "This revision has been replaced. The frozen content below is historical, not the current receiving basis.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Correct receipt" })).toBeNull();
    expect(
      send.mock.calls.filter(([url]) => String(url).endsWith(`/receiving/${old.id}`)),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Open current receipt" }));
    expect(await screen.findByRole("button", { name: "Correct receipt" })).toBeTruthy();
  });
  it("retains the selected record on failed navigation and retries only its GET", async () => {
    let fail = true;
    const { user, send } = await setup({
      handle: (url) =>
        url.endsWith(`/receiving/${old.id}`) && fail
          ? Response.json({}, { status: 503 })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Open previous revision" }));
    expect(
      await screen.findByText(
        "The selected revision could not be loaded. Your current view is unchanged.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Correct receipt" })).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry selected revision" }));
    expect(await screen.findByRole("button", { name: "Open current receipt" })).toBeTruthy();
    expect(send.mock.calls.filter(([, init]) => init?.method !== "GET")).toHaveLength(0);
  });
  it("rejects a valid but unrelated history page rather than exposing its links", async () => {
    const other = summary({
      ...predecessor,
      id: "f0000000-0000-4000-8000-000000000001",
      eventNumber: "REC-OTHER",
      lifecycle: {
        ...predecessor.lifecycle,
        rootId: "f0000000-0000-4000-8000-000000000001",
        currentEventId: "f0000000-0000-4000-8000-000000000001",
      },
    });
    const { user } = await setup({
      handle: (url) =>
        url.includes("/revisions?")
          ? Response.json({ items: [other], limit: 50, offset: 0, lifecycleVersion: 4 })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Show revision history" }));
    expect(
      await screen.findByText("Revision history could not be verified. Retry the read."),
    ).toBeTruthy();
    expect(screen.queryByText("REC-OTHER")).toBeNull();
  });
  it("keeps dirty correction input when navigation is declined or fails", async () => {
    const live = receivingLiveRecordSchema.parse({
      ...predecessor,
      lifecycle: { ...predecessor.lifecycle, lifecycleVersion: 5, pendingDraftId: amendment.id },
    });
    let fail = false;
    const { user } = await setup({
      initial: live,
      handle: (url) => {
        if (url.endsWith(`/receiving/${amendment.id}`)) return Response.json(amendment);
        if (url.endsWith(`/receiving/${predecessor.id}`))
          return fail ? Response.json({}, { status: 503 }) : Response.json(live);
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Open pending correction" }));
    const notes = await screen.findByRole("textbox", { name: "Receiving notes" });
    await user.clear(notes);
    await user.type(notes, "Unsaved local note");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Open current receipt" }));
    expect(confirm).toHaveBeenCalled();
    expect((notes as HTMLTextAreaElement).value).toBe("Unsaved local note");
    confirm.mockReturnValue(true);
    fail = true;
    await user.click(screen.getByRole("button", { name: "Open current receipt" }));
    expect(
      await screen.findByText(
        "The selected revision could not be loaded. Your current view is unchanged.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Receiving notes" }) as HTMLTextAreaElement).value,
    ).toBe("Unsaved local note");
  });
  it("uses all history explicitly for amended status and retains that choice on return", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Amended" }));
    await waitFor(() =>
      expect(
        send.mock.calls.some(
          ([url]) => String(url).includes("status=amended") && String(url).includes("history=all"),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("combobox", { name: "History selection" }).textContent).toBe(
      "All revisions",
    );
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Void" }));
    await waitFor(() =>
      expect(
        send.mock.calls.some(
          ([url]) => String(url).includes("status=void") && String(url).includes("history=all"),
        ),
      ).toBe(true),
    );
  });
  it("discards an in-flight history response after leaving the record", async () => {
    let resolve: ((value: Response) => void) | undefined;
    const { user } = await setup({
      handle: (url) =>
        url.includes("/revisions?")
          ? new Promise((done) => {
              resolve = done;
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Show revision history" }));
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    await act(async () =>
      resolve?.(
        Response.json({ items: [summary(old)], limit: 50, offset: 0, lifecycleVersion: 6 }),
      ),
    );
    expect(screen.queryByRole("region", { name: "Revision history" })).toBeNull();
  });
});
