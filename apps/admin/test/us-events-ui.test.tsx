import { createHash, webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeReceivingCsvExport, receivingRecordSchema } from "@markiro/platform-contracts";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { liveFixture } from "./support/us-receiving-live-fixture.js";
import { liveFinalized } from "./support/us-receiving-command-fixture.js";
import { finalizedRecord } from "./support/us-transformation-ui-fixture.js";

const receivedId = "a0000000-0000-4000-8000-000000000001";
const transformedId = "b0000000-0000-4000-8000-000000000001";
const shippedId = "c0000000-0000-4000-8000-000000000001";
const date = "2026-09-27T00:00:00.000Z";
const receiving = {
  id: receivedId,
  rootId: receivedId,
  type: "receiving",
  eventNumber: "REC-26-0001",
  revision: 1,
  status: "draft",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: receivedId,
  eventDate: "2026-09-26",
  timeZone: "America/Chicago",
  locationId: null,
  locationDisplay: null,
  documentCount: 0,
  lineCount: 0,
  previousSourceLocationId: null,
  updatedAt: date,
} as const;
const transformation = {
  id: transformedId,
  rootId: transformedId,
  type: "transformation",
  eventNumber: "TRN-26-0001",
  revision: 1,
  status: "draft",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: transformedId,
  eventDate: "2026-09-25",
  timeZone: "America/Chicago",
  locationId: null,
  locationDisplay: "Processor north dock, building 12",
  documentCount: 1,
  inputCount: 2,
  outputCount: 1,
  updatedAt: "2026-09-26T00:00:00.000Z",
} as const;
const shipping = {
  id: shippedId,
  rootId: shippedId,
  type: "shipping",
  eventNumber: "SHP-26-0001",
  revision: 1,
  status: "draft",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: shippedId,
  eventDate: "2026-09-27",
  timeZone: "America/Chicago",
  locationId: null,
  locationDisplay: null,
  documentCount: 0,
  lineCount: 0,
  updatedAt: date,
} as const;
const receivingRecord = liveFixture(
  receivingRecordSchema.parse({
    id: receivedId,
    eventNumber: receiving.eventNumber,
    status: "draft",
    revision: 1,
    draftVersion: 1,
    timeZone: receiving.timeZone,
    createdBy: "actor",
    updatedBy: "actor",
    createdAt: date,
    updatedAt: date,
    draft: {
      dateReceived: receiving.eventDate,
      locationId: null,
      previousSourceLocationId: null,
      receivedAtNote: null,
      notes: "Dock receipt",
      items: [],
      documentIds: [],
    },
  }),
);

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    locale?: "en-US" | "es-US";
    auditor?: boolean;
    fullPage?: boolean;
    finalized?: boolean;
    canExport?: boolean;
    failReceivingOnce?: boolean;
    finalizedTransformation?: boolean;
    shipping?: boolean;
  } = {},
) {
  let receivingReads = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/us/traceability/access")
      return Response.json({
        capabilities: [
          "traceability.read",
          ...(options.canExport ? ["traceability.export.read"] : []),
          ...(options.auditor
            ? []
            : [
                "traceability.receiving.write",
                "traceability.transformation.write",
                "traceability.shipping.write",
              ]),
        ],
      });
    if (url.startsWith("/api/us/traceability/events?")) {
      const query = new URL(url, "https://office.test").searchParams;
      const page = options.fullPage
        ? query.get("type") === "transformation"
          ? [transformation]
          : Number(query.get("offset")) === 0
            ? Array.from({ length: 50 }, (_, index) => {
                const rowId = `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`;
                return {
                  ...receiving,
                  id: rowId,
                  rootId: rowId,
                  pendingDraftId: rowId,
                  eventNumber: `REC-26-${String(index + 1).padStart(4, "0")}`,
                };
              })
            : [transformation]
        : [
            options.finalized
              ? {
                  ...receiving,
                  status: "finalized",
                  lifecycleVersion: 2,
                  currentEventId: receivedId,
                  pendingDraftId: null,
                }
              : receiving,
            options.finalizedTransformation
              ? {
                  ...transformation,
                  status: "finalized",
                  lifecycleVersion: 2,
                  currentEventId: transformedId,
                  pendingDraftId: null,
                }
              : transformation,
            ...(options.shipping ? [shipping] : []),
          ];
      const items = page.filter(
        (row) =>
          (query.get("type") === "all" || query.get("type") === row.type) &&
          (!query.get("search") || row.eventNumber.includes(query.get("search") ?? "")) &&
          (!query.get("status") || query.get("status") === row.status),
      );
      return Response.json({ items, limit: 50, offset: Number(query.get("offset")) });
    }
    if (url === `/api/us/traceability/receiving/${receivedId}`) {
      if (options.failReceivingOnce && receivingReads++ === 0)
        return Response.json({}, { status: 503 });
      return Response.json(options.finalized ? liveFinalized : receivingRecord);
    }
    if (
      options.finalizedTransformation &&
      url === `/api/us/traceability/transformation/${transformedId}`
    )
      return Response.json(finalizedRecord());
    if (
      options.finalizedTransformation &&
      url.includes(`/api/us/traceability/transformation/${transformedId}/revisions?`)
    )
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (
      options.finalizedTransformation &&
      url === `/api/us/traceability/lots/${finalizedRecord().snapshot.outputs[0]!.lotId}`
    )
      return Response.json({
        id: finalizedRecord().snapshot.outputs[0]!.lotId,
        productId: finalizedRecord().snapshot.outputs[0]!.product.id,
        tlc: "OUT-2026-001",
        source: null,
        assignmentBasis: "transformation",
        status: "active",
        sourceLockedAt: date,
        revision: 1,
        createdBy: "qa",
        updatedBy: "qa",
        createdAt: date,
        updatedAt: date,
      });
    if (
      options.finalized &&
      url.startsWith(`/api/us/traceability/receiving/${receivedId}/export.csv?`)
    ) {
      const bytes = encodeReceivingCsvExport(liveFinalized, date);
      const filename = `markiro-receiving-${receivedId}-r${liveFinalized.revision}-d${liveFinalized.draftVersion}-l${liveFinalized.lifecycle.lifecycleVersion}.csv`;
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Markiro-Export-SHA256": createHash("sha256").update(bytes).digest("hex"),
        },
      });
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
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
              effectiveAt: date,
            }}
            onBack={vi.fn()}
            onSessionLost={vi.fn()}
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  return { user: userEvent.setup(), send };
}

it("opens Shipping on its own read boundary and reports an unavailable record safely", async () => {
  const { user, send } = await setup({ shipping: true });
  await user.click(await screen.findByRole("button", { name: "Events" }));
  const row = (await screen.findAllByRole("row")).find((candidate) =>
    within(candidate).queryByRole("button", { name: shipping.eventNumber }),
  );
  expect(row).toBeTruthy();
  expect(within(row!).getByText("Shipping")).toBeTruthy();
  await user.click(within(row!).getByRole("button", { name: shipping.eventNumber }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The Shipping record could not be loaded.",
  );
  expect(
    send.mock.calls.some(([url]) => String(url) === `/api/us/traceability/shipments/${shippedId}`),
  ).toBe(true);
  expect(
    send.mock.calls.some(([url]) => String(url).includes(`/transformation/${shippedId}`)),
  ).toBe(false);
  expect(send.mock.calls.some(([url]) => String(url).includes(`/receiving/${shippedId}`))).toBe(
    false,
  );
});

it("dispatches REC/TRN numeric-suffix collisions by type and distinct ID", async () => {
  const { user, send } = await setup();
  expect(receiving.eventNumber.slice(4)).toBe("26-0001");
  expect(transformation.eventNumber.slice(4)).toBe("26-0001");
  expect(receiving.id).not.toBe(transformation.id);
  await user.click(await screen.findByRole("button", { name: "Events" }));
  expect(screen.queryByRole("button", { name: "Receiving" })).toBeNull();
  const rows = await screen.findAllByRole("row");
  expect(within(rows[1]!).getByText("Receiving")).toBeTruthy();
  expect(within(rows[2]!).getByText("Transformation")).toBeTruthy();
  await user.click(within(rows[2]!).getByRole("button", { name: transformation.eventNumber }));
  expect(await screen.findByRole("heading", { name: transformation.eventNumber })).toBeTruthy();
  expect(screen.getByText(transformation.locationDisplay)).toBeTruthy();
  expect(screen.getByText(transformation.timeZone)).toBeTruthy();
  expect(
    send.mock.calls.some(([url]) => url === `/api/us/traceability/receiving/${transformedId}`),
  ).toBe(false);
  expect(
    send.mock.calls.some(([url]) => String(url).includes(`/transformation/${transformedId}`)),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Back to events" }));
  const receivingRow = (await screen.findAllByRole("row"))[1]!;
  await user.click(within(receivingRow).getByRole("button", { name: receiving.eventNumber }));
  expect(await screen.findByRole("heading", { name: receiving.eventNumber })).toBeTruthy();
  expect(screen.getByLabelText("Receiving notes")).toHaveProperty("value", "Dock receipt");
  expect(
    send.mock.calls.some(([url]) => url === `/api/us/traceability/receiving/${receivedId}`),
  ).toBe(true);
  expect(
    send.mock.calls.some(([url]) => url === `/api/us/traceability/transformation/${receivedId}`),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Back to events" }));
  expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
});

it("opens an incomplete Transformation draft from Events without factory controls", async () => {
  const { user } = await setup();
  await user.click(await screen.findByRole("button", { name: "Events" }));
  await user.click(await screen.findByRole("button", { name: "New transformation" }));
  expect(screen.getByLabelText("Completion date")).toBeTruthy();
  expect(screen.getByText("Output TLC source: transformation location")).toBeTruthy();
  expect(screen.queryByLabelText("Closed shift")).toBeNull();
  expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
});

it("opens a Shipping draft from Events for a shipping writer", async () => {
  const { user } = await setup();
  await user.click(await screen.findByRole("button", { name: "Events" }));
  await user.click(await screen.findByRole("button", { name: "New shipment" }));
  expect(screen.getByRole("heading", { name: "Shipping draft", level: 1 })).toBeTruthy();
  expect(screen.getByLabelText("Date shipped")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /create TLC/i })).toBeNull();
  expect(screen.queryByLabelText(/SSCC/i)).toBeNull();
});

it("filters the unified Events ledger to Shipping and hides mutation from auditors", async () => {
  const { user, send } = await setup({ shipping: true, auditor: true, locale: "es-US" });
  await user.click(await screen.findByRole("button", { name: "Eventos" }));
  expect(screen.queryByRole("button", { name: "Nuevo envío" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Tipo de evento" }));
  await user.click(screen.getByRole("option", { name: "Envío" }));
  await waitFor(() =>
    expect(send.mock.calls.some(([url]) => String(url).includes("type=shipping"))).toBe(true),
  );
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.getByRole("button", { name: shipping.eventNumber })).toBeTruthy();
});

it("opens a frozen Transformation output lot through Lots and returns to Events", async () => {
  const { user, send } = await setup({ finalizedTransformation: true });
  await user.click(await screen.findByText("Events", { selector: "button" }));
  await user.click(await screen.findByText(transformation.eventNumber, { selector: "button" }));
  const output = await screen.findByText("OUT-2026-001");
  const outputButton = output.closest("button");
  expect(outputButton).not.toBeNull();
  await user.click(outputButton!);
  expect(await screen.findByText("OUT-2026-001", { selector: "h1" })).toBeTruthy();
  expect(
    send.mock.calls.some(
      ([url]) =>
        url === `/api/us/traceability/lots/${finalizedRecord().snapshot.outputs[0]!.lotId}`,
    ),
  ).toBe(true);
  await user.click(screen.getByText(/Back to events/, { selector: "button" }));
  expect(await screen.findByText("Events", { selector: "h1" })).toBeTruthy();
});

it("clears a failed Receiving open after a successful Transformation selection and return", async () => {
  const { user } = await setup({ failReceivingOnce: true });
  await user.click(await screen.findByRole("button", { name: "Events" }));
  const rows = await screen.findAllByRole("row");
  await user.click(within(rows[1]!).getByRole("button", { name: receiving.eventNumber }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "This event could not be opened. Retry from the ledger.",
  );
  const afterFailure = screen.getAllByRole("row");
  await user.click(
    within(afterFailure[2]!).getByRole("button", { name: transformation.eventNumber }),
  );
  expect(await screen.findByRole("heading", { name: transformation.eventNumber })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to events" }));
  expect(screen.queryByText("This event could not be opened. Retry from the ledger.")).toBeNull();
});

it("keeps finalized Receiving CSV export available from Events", async () => {
  const objectUrl = vi.fn().mockReturnValue("blob:receiving-events");
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: objectUrl,
      revokeObjectURL: revokeUrl,
    }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const { user, send } = await setup({ finalized: true, canExport: true });
  await user.click(await screen.findByRole("button", { name: "Events" }));
  await user.click(await screen.findByRole("button", { name: receiving.eventNumber }));
  expect(await screen.findByRole("heading", { name: receiving.eventNumber })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Export CSV" }));
  await screen.findByText("Download ready.");
  expect(
    send.mock.calls.some(([url]) =>
      String(url).startsWith(`/api/us/traceability/receiving/${receivedId}/export.csv?`),
    ),
  ).toBe(true);
  expect(objectUrl).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  expect(revokeUrl).toHaveBeenCalledWith("blob:receiving-events");
});

it("applies server filters and opens the existing blank Receiving editor", async () => {
  const { user, send } = await setup();
  await user.click(await screen.findByRole("button", { name: "Events" }));
  await screen.findAllByRole("row");
  await user.click(screen.getByRole("combobox", { name: "Event type" }));
  await user.click(screen.getByRole("option", { name: "Transformation" }));
  await waitFor(() =>
    expect(send.mock.calls.some(([url]) => String(url).includes("type=transformation"))).toBe(true),
  );
  expect(screen.getAllByRole("row")).toHaveLength(2);
  await user.click(screen.getByRole("combobox", { name: "Event type" }));
  await user.click(screen.getByRole("option", { name: "All types" }));
  await user.click(screen.getByRole("combobox", { name: "Status" }));
  await user.click(screen.getByRole("option", { name: "Amended" }));
  await waitFor(() =>
    expect(
      send.mock.calls.some(
        ([url]) => String(url).includes("status=amended") && String(url).includes("history=all"),
      ),
    ).toBe(true),
  );
  await user.type(screen.getByLabelText("Search event number"), "REC");
  await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(send.mock.calls.some(([url]) => String(url).includes("search=REC"))).toBe(true),
  );
  await user.click(screen.getByRole("button", { name: "New receiving" }));
  expect(await screen.findByLabelText("Receiving notes")).toHaveProperty("value", "");
  await user.click(screen.getByRole("button", { name: "Back to events" }));
  expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
});

it("returns from the existing CSV import screen to the Events ledger", async () => {
  const { user } = await setup();
  await user.click(await screen.findByRole("button", { name: "Events" }));
  await screen.findAllByRole("row");
  await user.click(screen.getByRole("button", { name: "Import CSV" }));
  expect(await screen.findByRole("heading", { name: "Import CSV" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to events" }));
  expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
});

it("uses the server's global page and resets its offset when filtering", async () => {
  const { user, send } = await setup({ fullPage: true });
  await user.click(await screen.findByRole("button", { name: "Events" }));
  expect(await screen.findAllByRole("row")).toHaveLength(51);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("button", { name: transformation.eventNumber });
  expect(send.mock.calls.some(([url]) => String(url).includes("offset=50"))).toBe(true);
  await user.click(screen.getByRole("combobox", { name: "Event type" }));
  await user.click(screen.getByRole("option", { name: "Transformation" }));
  await waitFor(() =>
    expect(
      send.mock.calls.some(
        ([url]) => String(url).includes("type=transformation") && String(url).includes("offset=0"),
      ),
    ).toBe(true),
  );
  expect(screen.getByText("Page 1")).toBeTruthy();
});

it("keeps auditor controls read-only and translates event types and labels into Spanish", async () => {
  const { user } = await setup({ locale: "es-US", auditor: true });
  await user.click(await screen.findByRole("button", { name: "Eventos" }));
  await screen.findAllByRole("row");
  expect(screen.queryByRole("button", { name: "Nueva recepción" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Nueva transformación" })).toBeNull();
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]!).getByText("Recepción")).toBeTruthy();
  expect(within(rows[2]!).getByText("Transformación")).toBeTruthy();
  expect(screen.getAllByText("Borrador").length).toBeGreaterThan(0);
  expect(screen.getByRole("columnheader", { name: "Evento / revisión" })).toBeTruthy();
});
