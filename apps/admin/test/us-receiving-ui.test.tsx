import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { receivingRecordSchema, type ReceivingRecord } from "@markiro/platform-contracts";
import { liveFixture, liveReadFixtureResponse } from "./support/us-receiving-live-fixture.js";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";

const id = "a0000000-0000-4000-8000-000000000001";
const empty = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};
const record = {
  id,
  eventNumber: "REC-26-0001",
  status: "draft",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  draft: empty,
};
const path = "/api/us/traceability/receiving";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function setup(
  options: {
    readOnly?: boolean;
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current: ReceivingRecord = receivingRecordSchema.parse(record);
  const source: typeof fetch = async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (url === "/api/us/traceability/access")
      return Response.json({
        capabilities: [
          "traceability.read",
          ...(options.readOnly ? [] : ["traceability.receiving.write"]),
        ],
      });
    if (String(url).startsWith(`${path}?`)) {
      const header = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "draft"));
      return Response.json({
        items: [
          {
            ...header,
            dateReceived: null,
            locationId: null,
            previousSourceLocationId: null,
            lineCount: 0,
            documentCount: 0,
          },
        ],
        limit: 50,
        offset: 0,
      });
    }
    if (url === `${path}/${id}` && init?.method === "GET") return Response.json(current);
    if ((url === path || url === `${path}/${id}`) && init?.method !== "GET") {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...record,
        draft: body.draft,
        draftVersion: body.expectedDraftVersion ? body.expectedDraftVersion + 1 : 1,
      });
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const response = await source(url, init);
    if (init?.method && init.method !== "GET" && response.ok) {
      const parsed = receivingRecordSchema.safeParse(await response.clone().json());
      if (parsed.success) current = parsed.data;
    }
    return liveReadFixtureResponse(url, init, response);
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onSessionLost = vi.fn();
  render(
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <MasterDataWorkspace
            client={createUsBrowserClient(send)}
            organization={{ id: "synthetic", name: "North River Fresh Foods" }}
            profile={{
              code: "US_FSMA204_PROCESSOR",
              timeZone: "America/Chicago",
              retentionYears: 5,
              baselineVersion: "US-REG-2026-09-03",
              effectiveAt: record.createdAt,
            }}
            onBack={vi.fn()}
            onSessionLost={onSessionLost}
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Receiving" }));
  await screen.findByRole("button", { name: record.eventNumber });
  return { user, send, instance, onSessionLost };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: record.eventNumber }));
  await screen.findByRole("heading", { name: record.eventNumber });
}

it.each(["create", "save"] as const)(
  "recovers %s with GET only after a known acknowledgement and failed current read",
  async (command) => {
    let acknowledged = false;
    let reads = 0;
    const current = liveFixture(
      receivingRecordSchema.parse({
        ...record,
        draft: { ...empty, notes: "Current server notes" },
      }),
    );
    const { user, send } = await setup({
      handle: (url, init) => {
        if (
          url === (command === "create" ? path : `${path}/${id}`) &&
          init?.method === (command === "create" ? "POST" : "PUT")
        ) {
          acknowledged = true;
          return Response.json(record);
        }
        if (url === `${path}/${id}` && init?.method === "GET" && acknowledged)
          return reads++ === 0 ? Response.json({}, { status: 503 }) : Response.json(current);
        return undefined;
      },
    });
    if (command === "create")
      await user.click(screen.getByRole("button", { name: "New receiving" }));
    else await open(user);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const retry = await screen.findByRole("button", { name: "Retry current state" });
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Receiving notes").matches(":disabled")).toBe(true);
    await user.click(retry);
    await waitFor(() =>
      expect(screen.getByLabelText("Receiving notes")).toHaveProperty(
        "value",
        "Current server notes",
      ),
    );
    expect(reads).toBe(2);
    expect(
      send.mock.calls.filter(([, init]) => ["POST", "PUT"].includes(init?.method ?? "")),
    ).toHaveLength(1);
  },
);
describe("connected US receiving drafts", () => {
  it("keeps input and the same command after a well-formed but mismatched acknowledgement", async () => {
    const { user, send } = await setup({
      handle: (url, init) =>
        url === path && init?.method === "POST" ? Response.json(record) : undefined,
    });
    await user.click(screen.getByRole("button", { name: "New receiving" }));
    await user.type(screen.getByLabelText("Receiving notes"), "My delivery");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: "Retry same save" });
    expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
      "My delivery",
    );
    expect(screen.queryByText("Draft saved.")).toBeNull();
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
  });
  it("requires confirmation before discarding an entered TLC source", async () => {
    const { user } = await setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add line" }));
    await user.selectOptions(screen.getByLabelText("TLC source type"), "reference");
    await user.type(
      screen.getByLabelText("Source reference URL"),
      "https://supplier.example.test/Case/A",
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.selectOptions(screen.getByLabelText("TLC source type"), "location");
    expect(confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Source reference URL") as HTMLInputElement).value).toBe(
      "https://supplier.example.test/Case/A",
    );
    confirm.mockReturnValue(true);
    await user.selectOptions(screen.getByLabelText("TLC source type"), "location");
    expect(screen.queryByLabelText("Source reference URL")).toBeNull();
  });
  it("creates an incomplete draft and keeps its identity for subsequent saves", async () => {
    const { user, send } = await setup();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "New receiving" }));
    await user.type(screen.getByLabelText("Receiving notes"), "Delivery started");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(screen.getByRole("heading", { name: record.eventNumber })).toBeTruthy();
    await user.type(screen.getByLabelText("Receiving notes"), " at dock 2");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
    );
    const writes = send.mock.calls.filter(([, init]) =>
      ["POST", "PUT"].includes(init?.method ?? ""),
    );
    expect(writes.map(([url]) => url)).toEqual([path, `${path}/${id}`]);
    expect(JSON.parse(String(writes[1]?.[1]?.body))).toMatchObject({
      expectedDraftVersion: 1,
      draft: { notes: "Delivery started at dock 2" },
    });
    expect(screen.queryByRole("button", { name: /finalize|import|delete/i })).toBeNull();
  });
  it("stores ordered nullable lines, explicit quantity and exempt information without assigning identity", async () => {
    const { user, send } = await setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add line" }));
    await user.type(screen.getByLabelText("Lot code (TLC)"), "0001");
    await user.type(screen.getByLabelText("Quantity"), "500.000");
    await user.selectOptions(screen.getByLabelText("Unit"), "lb");
    await user.click(screen.getByRole("checkbox", { name: "Exempt supplier" }));
    await user.type(screen.getByLabelText("Exemption reason"), "Supplier statement");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const write = send.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(write?.[1]?.body)).draft.items).toEqual([
      {
        productId: null,
        lotLinkMode: "create_on_finalize",
        lotId: null,
        tlc: "0001",
        source: null,
        quantity: "500.000",
        unitOfMeasure: "lb",
        exemptSupplier: true,
        exemptReason: "Supplier statement",
        exemptReceipt: null,
        supplierLotReference: null,
        notes: null,
      },
    ]);
  });
  it.each(["network", "wrong_version"])(
    "retries an uncertain create with the identical key and payload and locks editing meanwhile (%s)",
    async (failure) => {
      let attempts = 0;
      const { user, send } = await setup({
        handle: (url, init) => {
          if (url !== path || init?.method !== "POST") return;
          attempts += 1;
          if (attempts === 1) {
            if (failure === "network") return Promise.reject(new Error("network"));
            return Response.json({
              ...record,
              draftVersion: 2,
              draft: JSON.parse(String(init.body)).draft,
            });
          }
          return Response.json({ ...record, draft: JSON.parse(String(init.body)).draft });
        },
      });
      await user.click(screen.getByRole("button", { name: "New receiving" }));
      await user.type(screen.getByLabelText("Receiving notes"), "Uncertain delivery");
      await user.click(screen.getByRole("button", { name: "Save draft" }));
      const retry = await screen.findByRole("button", { name: "Retry same save" });
      expect(screen.getByLabelText("Receiving notes").closest("fieldset")?.disabled).toBe(true);
      expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
        "Uncertain delivery",
      );
      expect(screen.queryByText("Draft saved.")).toBeNull();
      await user.click(retry);
      await screen.findByText("Draft saved.");
      const writes = send.mock.calls.filter(([url]) => url === path);
      expect(writes).toHaveLength(2);
      expect(writes[0]?.[1]?.body).toBe(writes[1]?.[1]?.body);
    },
  );
  it("preserves local edits after a stale save and requires confirmation before loading server values", async () => {
    let conflict = false;
    const { user, send } = await setup({
      handle: (url, init) => {
        if (url !== `${path}/${id}`) return;
        if (init?.method === "PUT") {
          conflict = true;
          return Response.json({ code: "receiving_draft_conflict" }, { status: 409 });
        }
        if (conflict)
          return Response.json({
            ...record,
            draftVersion: 2,
            draft: { ...empty, notes: "Colleague's delivery" },
          });
      },
    });
    await open(user);
    await user.type(screen.getByLabelText("Receiving notes"), "My delivery");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const reload = await screen.findByRole("button", { name: "Reload saved draft" });
    expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
      "My delivery",
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(reload);
    expect(confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
      "My delivery",
    );
    confirm.mockReturnValue(true);
    await user.click(reload);
    await waitFor(() =>
      expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
        "Colleague's delivery",
      ),
    );
    expect(send.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("allows readers to open drafts but never exposes receiving writes", async () => {
    const { user, send } = await setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "New receiving" })).toBeNull();
    await open(user);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.getByLabelText("Receiving notes").closest("fieldset")?.disabled).toBe(true);
    expect(send.mock.calls.some(([, init]) => init?.method !== "GET")).toBe(false);
  });
  it("keeps a draft across locale changes and names the groups in Spanish", async () => {
    const { user, instance } = await setup();
    await open(user);
    await user.type(screen.getByLabelText("Receiving notes"), "Keep my input");
    const { act } = await import("@testing-library/react");
    await act(() => instance.changeLanguage("es-US"));
    expect((screen.getByLabelText("Notas de recepción") as HTMLTextAreaElement).value).toBe(
      "Keep my input",
    );
    expect(screen.getByRole("heading", { name: "Datos de recepción" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Líneas 0$/ })).toBeTruthy();
  });
  it("rejects invalid quantity locally without sending a partial write", async () => {
    const { user, send } = await setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Add line" }));
    await user.type(screen.getByLabelText("Quantity"), "-1");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Quantity");
    expect(send.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
