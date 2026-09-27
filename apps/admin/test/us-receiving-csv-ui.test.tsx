import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { ReceivingCsvImport } from "../src/us/receiving/csv-import.js";
import { ReceivingCsvPreviewDetails } from "../src/us/receiving/csv-preview.js";
import { ReceivingCsvExport } from "../src/us/receiving/csv-export.js";
import { decodeReceivingCsvExport, encodeReceivingCsvExport } from "@markiro/platform-contracts";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { csvText, csvPreview, csvAck } from "./support/us-receiving-csv-fixture.js";
import { liveDraft } from "./support/us-receiving-command-fixture.js";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saved Receiving CSV export action", () => {
  async function mount(
    options: {
      locale?: "en-US" | "es-US";
      canExport?: boolean;
      dirty?: boolean;
      response?: Promise<Response>;
    } = {},
  ) {
    const bytes = encodeReceivingCsvExport(liveDraft, "2026-09-26T10:00:00.000Z");
    const filename = `markiro-receiving-${liveDraft.id}-r${liveDraft.revision}-d${liveDraft.draftVersion}-l${liveDraft.lifecycle.lifecycleVersion}.csv`;
    const good = new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Markiro-Export-SHA256": createHash("sha256").update(bytes).digest("hex"),
      },
    });
    const send = vi.fn<typeof fetch>().mockImplementation(async () => options.response ?? good);
    const downloaded: Blob[] = [];
    const createUrl = vi.fn((blob: Blob) => {
      downloaded.push(blob);
      return "blob:receiving-test";
    });
    const revokeUrl = vi.fn();
    class DownloadUrl extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    }
    vi.stubGlobal("URL", DownloadUrl);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const instance = i18next.createInstance();
    await instance.init({
      lng: options.locale ?? "en-US",
      resources: Object.fromEntries(
        Object.entries(masterDataCopy).map(([key, value]) => [key, { translation: value }]),
      ),
    });
    const element = (dirty: boolean) => (
      <I18nextProvider i18n={instance}>
        <ReceivingCsvExport
          client={createUsBrowserClient(send)}
          record={liveDraft}
          canExport={options.canExport ?? true}
          disabled={dirty}
          dirty={dirty}
          onReload={() => {}}
          onForbidden={async () => {}}
          onSessionLost={() => {}}
        />
      </I18nextProvider>
    );
    const rendered = render(element(options.dirty ?? false));
    return {
      user: userEvent.setup(),
      send,
      downloaded,
      createUrl,
      revokeUrl,
      click,
      updateDirty: (dirty: boolean) => rendered.rerender(element(dirty)),
      ...rendered,
    };
  }
  it("downloads the exact verified bytes once, then revokes the object URL", async () => {
    const ctx = await mount();
    await ctx.user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(ctx.downloaded).toHaveLength(1));
    const blob = ctx.downloaded[0];
    if (!blob) throw new Error("Missing download");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(decodeReceivingCsvExport(bytes).record).toEqual(liveDraft);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.click).toHaveBeenCalledTimes(1);
    expect(ctx.revokeUrl).toHaveBeenCalledWith("blob:receiving-test");
    expect(screen.getByRole("status").textContent).toContain("Download ready");
  });
  it("hides export without capability and blocks unsaved changes", async () => {
    await mount({ canExport: false });
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    cleanup();
    const ctx = await mount({ dirty: true });
    expect(screen.getByRole("button", { name: "Export CSV" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Save or discard changes/)).toBeTruthy();
    expect(ctx.send).not.toHaveBeenCalled();
  });
  it("shows stale state with reload and permits explicit retry after integrity failure", async () => {
    const stale = await mount({
      response: Promise.resolve(Response.json({ code: "receiving_export_stale" }, { status: 409 })),
    });
    await stale.user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reload");
    expect(stale.downloaded).toHaveLength(0);
    cleanup();
    const wrong = await mount({
      response: Promise.resolve(
        new Response("bad", { headers: { "Content-Type": "text/csv; charset=utf-8" } }),
      ),
    });
    await wrong.user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be verified");
    await wrong.user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(wrong.send).toHaveBeenCalledTimes(2));
    expect(wrong.downloaded).toHaveLength(0);
  });
  it("uses Spanish copy", async () => {
    await mount({ locale: "es-US", dirty: true });
    expect(screen.getByRole("button", { name: "Exportar CSV" })).toBeTruthy();
    expect(screen.getByText(/Guarde o descarte/)).toBeTruthy();
  });
  it("blocks duplicate clicks and discards an in-flight result after form context changes", async () => {
    let finish: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const ctx = await mount({ response: delayed });
    await ctx.user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(screen.getByRole("button", { name: "Preparing CSV…" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(ctx.send).toHaveBeenCalledTimes(1);
    ctx.updateDirty(true);
    await act(async () => {
      if (!finish) throw new Error("Missing export resolver");
      finish(Response.json({ code: "receiving_export_stale" }, { status: 409 }));
    });
    expect(ctx.downloaded).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Export CSV" }).hasAttribute("disabled")).toBe(true);
  });
});
async function setup(
  options: {
    locale?: "en-US" | "es-US";
    lostApply?: boolean;
    lostRead?: boolean;
    denied?: number;
    canWrite?: boolean;
    retryError?: string;
    readResponse?: Promise<Response>;
  } = {},
) {
  let applies = 0,
    reads = 0;
  const bodies: unknown[] = [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/imports/preview")) return Response.json(csvPreview, { status: 201 });
    if (String(url).endsWith("/apply")) {
      applies++;
      bodies.push(JSON.parse(String(init?.body)));
      if (options.denied)
        return Response.json({ code: "insufficient_permission" }, { status: options.denied });
      if (options.lostApply && applies === 1) throw new Error("lost synthetic response");
      if (options.retryError) return Response.json({ code: options.retryError }, { status: 409 });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...csvAck,
        request: { ...csvAck.request, operationKey: body.operationKey },
        receipt: { ...csvAck.receipt, operationKey: body.operationKey },
      });
    }
    if (url === `/api/us/traceability/receiving/${csvAck.receipt.eventId}`) {
      reads++;
      if (options.readResponse) return options.readResponse;
      if (options.lostRead && reads === 1) throw new Error("lost synthetic read");
      return Response.json({
        ...csvAck.receipt.record,
        draftVersion: 2,
        content: {
          kind: "draft",
          draft: {
            ...(csvAck.receipt.record.content.kind === "draft"
              ? csvAck.receipt.record.content.draft
              : {}),
            notes: "Current record",
          },
        },
      });
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const locale = options.locale ?? "en-US";
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: "en-US",
    resources: Object.fromEntries(
      Object.entries(masterDataCopy).map(([key, value]) => [key, { translation: value }]),
    ),
  });
  const onOpenRecord = vi.fn(),
    onForbidden = vi.fn(async () => {}),
    onSessionLost = vi.fn(),
    onClose = vi.fn();
  const rendered = render(
    <StrictMode>
      <ThemeProvider>
        <I18nextProvider i18n={instance}>
          <ReceivingCsvImport
            client={createUsBrowserClient(send)}
            canWrite={options.canWrite ?? true}
            mutationPending={false}
            beginMutation={() => () => {}}
            onDirtyChange={() => {}}
            onNotice={() => {}}
            onForbidden={onForbidden}
            onSessionLost={onSessionLost}
            onClientFailure={() => {}}
            onClose={onClose}
            onOpenRecord={onOpenRecord}
            timeZone="America/Chicago"
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  return {
    user: userEvent.setup(),
    send,
    bodies,
    onOpenRecord,
    onForbidden,
    onSessionLost,
    onClose,
    unmount: rendered.unmount,
    counts: () => ({ applies, reads }),
  };
}
async function previewAndConfirm(ctx: Awaited<ReturnType<typeof setup>>) {
  await ctx.user.upload(
    screen.getByLabelText("CSV file"),
    new File([csvText], "delivery.csv", { type: "text/csv" }),
  );
  await ctx.user.click(screen.getByRole("button", { name: "Preview file" }));
  await screen.findByRole("button", { name: "Continue to confirmation" });
  expect(screen.queryByRole("heading", { name: "1 row" })).toBeTruthy();
  expect(ctx.counts().applies).toBe(0);
  await ctx.user.click(screen.getByRole("button", { name: "Continue to confirmation" }));
  expect(
    screen.getByRole("button", { name: "Create receiving draft" }).hasAttribute("disabled"),
  ).toBe(true);
  await ctx.user.click(
    screen.getByRole("checkbox", { name: "I reviewed the file and common receiving data." }),
  );
  await ctx.user.click(screen.getByRole("button", { name: "Create receiving draft" }));
}
describe("Receiving CSV grouped import", () => {
  it("requires preview and explicit confirmation, then opens only a live GET", async () => {
    const ctx = await setup();
    await previewAndConfirm(ctx);
    await waitFor(() =>
      expect(ctx.onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ draftVersion: 2 })),
    );
    expect(ctx.counts()).toEqual({ applies: 1, reads: 1 });
  });
  it("ignores a late live read after the authenticated import flow unmounts", async () => {
    let release: ((value: Response) => void) | undefined;
    const readResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const ctx = await setup({ readResponse });
    await previewAndConfirm(ctx);
    await waitFor(() => expect(ctx.counts().reads).toBe(1));
    ctx.unmount();
    await act(async () => {
      if (!release) throw new Error("Missing response resolver");
      release(Response.json(csvAck.receipt.record));
    });
    expect(ctx.onOpenRecord).not.toHaveBeenCalled();
    expect(ctx.counts()).toEqual({ applies: 1, reads: 1 });
  });
  it("retains the same command for an explicit retry after an unknown result", async () => {
    const ctx = await setup({ lostApply: true });
    await previewAndConfirm(ctx);
    await screen.findByRole("button", { name: "Retry same operation" });
    expect(ctx.counts()).toEqual({ applies: 1, reads: 0 });
    await ctx.user.click(screen.getByRole("button", { name: "Retry same operation" }));
    await waitFor(() => expect(ctx.onOpenRecord).toHaveBeenCalled());
    expect(ctx.bodies[1]).toEqual(ctx.bodies[0]);
  });
  it("never reapplies after acknowledgement if the live GET fails", async () => {
    const ctx = await setup({ lostRead: true });
    await previewAndConfirm(ctx);
    await ctx.user.click(await screen.findByRole("button", { name: "Load current record" }));
    await waitFor(() => expect(ctx.onOpenRecord).toHaveBeenCalled());
    expect(ctx.counts()).toEqual({ applies: 1, reads: 2 });
    expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
  });
  it.each([
    "receiving_csv_preview_expired",
    "receiving_csv_preview_stale",
    "receiving_csv_preview_conflict",
  ])(
    "stops uncertain recovery after definitive %s without generating a new command",
    async (retryError) => {
      const ctx = await setup({ lostApply: true, retryError });
      await previewAndConfirm(ctx);
      await ctx.user.click(await screen.findByRole("button", { name: "Retry same operation" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull(),
      );
      expect(
        screen.getByRole("button", { name: "Create receiving draft" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(ctx.bodies[1]).toEqual(ctx.bodies[0]);
      expect(ctx.counts()).toEqual({ applies: 2, reads: 0 });
    },
  );
  it("identifies the retained file when returning from preview", async () => {
    const ctx = await setup();
    await ctx.user.upload(
      screen.getByLabelText("CSV file"),
      new File([csvText], "delivery.csv", { type: "text/csv" }),
    );
    await ctx.user.click(screen.getByRole("button", { name: "Preview file" }));
    await ctx.user.click(await screen.findByRole("button", { name: "Back to file" }));
    expect(screen.queryByText("Selected file: delivery.csv")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview file" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  it("bounds malformed wide-row rendering and explicitly reports the omitted cells", async () => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: "en-US",
      resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    });
    const row = csvPreview.rows[0];
    if (!row) throw new Error("Missing fixture row");
    const preview = {
      ...csvPreview,
      proposedDraft: null,
      previewDigest: null,
      rows: [
        {
          ...row,
          cells: Array.from({ length: 1000 }, () => "cell"),
          issues: [{ column: null, code: "column_count" as const }],
        },
      ],
    };
    const { container } = render(
      <I18nextProvider i18n={instance}>
        <ReceivingCsvPreviewDetails preview={preview} />
      </I18nextProvider>,
    );
    expect(container.querySelectorAll("details dd")).toHaveLength(18);
    expect(
      screen.queryByText(
        "Showing the first 18 of 1000 cells. Correct the column count in the original file.",
      ),
    ).toBeTruthy();
  });
  it.each([401, 403])("clears sensitive state and cannot retry after HTTP %s", async (denied) => {
    const ctx = await setup({ denied });
    await previewAndConfirm(ctx);
    await waitFor(() =>
      expect(denied === 401 ? ctx.onSessionLost : ctx.onForbidden).toHaveBeenCalled(),
    );
    expect(screen.queryByText("delivery.csv")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
    expect(screen.queryByLabelText("CSV file")).toBeNull();
  });
  it("rejects oversize files before contacting the server", async () => {
    const ctx = await setup();
    await ctx.user.upload(
      screen.getByLabelText("CSV file"),
      new File([new Uint8Array(262145)], "large.csv", { type: "text/csv" }),
    );
    await ctx.user.click(screen.getByRole("button", { name: "Preview file" }));
    expect((await screen.findByRole("alert")).textContent).toContain("256 KiB");
    expect(ctx.send.mock.calls.some(([url]) => String(url).endsWith("/imports/preview"))).toBe(
      false,
    );
  });
  it("shows Spanish controls without adding Russian UI", async () => {
    await setup({ locale: "es-US" });
    expect(screen.getByRole("heading", { name: "Importar CSV" })).toBeTruthy();
    expect(screen.getByLabelText("Archivo CSV")).toBeTruthy();
  });
  it("never exposes import input to a read-only user", async () => {
    await setup({ canWrite: false });
    expect(screen.queryByLabelText("CSV file")).toBeNull();
  });
});
