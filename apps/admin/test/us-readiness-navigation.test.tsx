import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type { UsReadinessFinding, UsReadinessResult } from "@markiro/platform-contracts";
import {
  receivingLiveRecordSchema,
  transformationHttpRecordSchema,
  shippingHistoricalRecordSchema,
} from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { liveDraft, liveFinalized } from "./support/us-receiving-command-fixture.js";
import {
  finalizedRecord as transformation,
  draftRecord as transformationDraft,
} from "./support/us-transformation-ui-fixture.js";
import {
  finalizedRecord as shipping,
  draftRecord as shippingDraft,
} from "./support/us-shipping-ui-fixture.js";

const exactId = "90000000-0000-4000-8000-000000000002";
const rootId = "90000000-0000-4000-8000-000000000001";
const lotId = "90000000-0000-4000-8000-000000000003";
const currentId = "90000000-0000-4000-8000-000000000004";
function finding(
  type: "receiving" | "transformation" | "shipping",
  patch: Partial<UsReadinessFinding> = {},
): UsReadinessFinding {
  return {
    key: "finding",
    ruleVersion: "us-readiness-v1",
    code: "required_kde",
    severity: "error",
    cte: type,
    field: "quantity",
    message: { key: "readiness.required_kde", params: {} },
    lotId: null,
    productId: null,
    eventId: exactId,
    rootId,
    eventNumber: `${type === "receiving" ? "REC" : type === "transformation" ? "TRN" : "SHP"}-26-0002`,
    revision: 2,
    eventDate: "2026-09-20",
    lineSide: type === "transformation" ? "inputs" : "items",
    lineNo: 1,
    relatedEventId: null,
    relatedEvent: null,
    links: { lotHref: null, eventHref: "/traceability/do-not-follow", relatedEventHref: null },
    ...patch,
  };
}
function assessment(
  source: UsReadinessFinding,
  draftType: "receiving" | "transformation" | "shipping" = "receiving",
): UsReadinessResult {
  const draft =
    draftType === "receiving"
      ? { ...liveDraft, eventNumber: "REC-26-9999" }
      : draftType === "transformation"
        ? transformationDraft()
        : shippingDraft();
  return {
    scope: {
      eventDateFrom: "2024-10-01",
      eventDateTo: "2026-09-28",
      productId: null,
      lotId: null,
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      defaulted: true,
    },
    assessedAt: "2026-09-28T10:00:00.000Z",
    state: "assessed",
    recordsChecked: { events: 1, lots: 0 },
    dependenciesChecked: 0,
    counts: { error: 1, warning: 0, info: 0 },
    groups: {
      byCte: [{ cte: source.cte, count: 1 }],
      byProduct: [{ productId: null, count: 1 }],
      bySeverity: [{ severity: "error", count: 1 }],
    },
    findings: [source],
    draftWork: {
      total: 1,
      items: [
        {
          eventId: draft.id,
          rootId: draft.id,
          cte: draftType,
          eventNumber: draft.eventNumber,
          revision: 1,
          eventDate: null,
          eventHref: "/traceability/do-not-follow",
          readinessHref: "/traceability/do-not-follow",
        },
      ],
      hasMore: false,
      eventsHref: "/traceability/do-not-follow",
    },
  };
}
async function setup(
  type: "receiving" | "transformation" | "shipping" = "receiving",
  options: {
    patch?: Partial<UsReadinessFinding>;
    mismatch?: boolean;
    denied?: boolean;
    nonFtl?: boolean;
    draftType?: "receiving" | "transformation" | "shipping";
  } = {},
) {
  vi.stubGlobal("crypto", webcrypto);
  const revision = options.mismatch ? 3 : 2;
  const eventNumber = `${type === "receiving" ? "REC" : type === "transformation" ? "TRN" : "SHP"}-26-0002`;
  const identity = { id: exactId, revision, eventNumber, status: "amended" };
  const history = {
    rootId,
    currentEventId: currentId,
    previousRevisionId: rootId,
    amendmentReason: "Corrected source",
    supersededByEventId: currentId,
    supersededAt: "2026-09-28T00:00:00.000Z",
    supersededBy: "qa",
  };
  let record: unknown;
  if (type === "receiving") {
    record = receivingLiveRecordSchema.parse({
      ...liveFinalized,
      ...identity,
      lifecycle: { ...liveFinalized.lifecycle, ...history },
    });
  } else if (type === "transformation") {
    const base = transformation();
    record = transformationHttpRecordSchema.parse({
      ...base,
      ...identity,
      lifecycle: { ...base.lifecycle, ...history },
      snapshot: {
        ...base.snapshot,
        inputs: options.nonFtl
          ? base.snapshot.inputs.map((row) => ({
              kind: "non_ftl",
              lineNo: 2,
              product: {
                ...row.product,
                coverage: { ...row.product.coverage, coverageStatus: "not_covered" },
              },
              source: row.source,
              reference: "External apples",
              quantity: row.quantity,
              unitOfMeasure: row.unitOfMeasure,
            }))
          : base.snapshot.inputs,
        eventId: exactId,
        revision,
        eventNumber,
        previousRevisionId: rootId,
      },
    });
  } else {
    const base = shipping();
    if (!("snapshot" in base)) throw new Error("Expected frozen shipping fixture");
    record = shippingHistoricalRecordSchema.parse({
      ...base,
      ...identity,
      lifecycle: { ...base.lifecycle, ...history },
      snapshot: { ...base.snapshot, eventId: exactId, revision, eventNumber },
    });
  }
  let denied = false;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/access"))
      return Response.json({
        capabilities: denied ? [] : ["traceability.read", "traceability.receiving.write"],
      });
    if (url.includes("/readiness"))
      return Response.json(assessment(finding(type, options.patch), options.draftType));
    if (url.endsWith(`/${exactId}`)) {
      if (options.denied) {
        denied = true;
        return Response.json({ code: "forbidden" }, { status: 403 });
      }
      return Response.json(record);
    }
    if (url.endsWith(`/${liveDraft.id}`))
      return Response.json({ ...liveDraft, eventNumber: "REC-26-9999" });
    if (url === `/api/us/traceability/transformation/${transformationDraft().id}`)
      return Response.json(transformationDraft());
    if (url === `/api/us/traceability/shipments/${shippingDraft().id}`)
      return Response.json(shippingDraft());
    if (url.endsWith(`/${lotId}`))
      return Response.json({
        id: lotId,
        productId: rootId,
        tlc: "EXACT-LOT",
        source: { kind: "location", locationId: rootId },
        assignmentBasis: "imported",
        sourceLockedAt: null,
        status: "active",
        revision: 1,
        createdBy: "qa",
        updatedBy: "qa",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      });
    if (url.includes("?")) return Response.json({ items: [], limit: 50, offset: 0 });
    return Response.json({}, { status: 503 });
  });
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={i18n}>
        <MasterDataWorkspace
          client={createUsBrowserClient(send)}
          organization={{ id: rootId, name: "Office" }}
          profile={{
            code: "US_GENERIC_LOT_TRACEABILITY",
            timeZone: "America/Chicago",
            retentionYears: 5,
            baselineVersion: "US-REG-2026-09-03",
            effectiveAt: "2026-09-20T00:00:00.000Z",
          }}
          onBack={vi.fn()}
          onSessionLost={vi.fn()}
        />
      </I18nextProvider>
    </ThemeProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Data readiness" }));
  await screen.findAllByRole("button", { name: /-26-0002|Open lot/ });
  return { user, send };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["receiving", "receiving", "items"],
  ["transformation", "transformation", "inputs"],
  ["shipping", "shipments", "items"],
] as const)(
  "opens exact historical %s revision and focuses its source line",
  async (type, route, side) => {
    const { user, send } = await setup(type);
    await user.click(screen.getByRole("button", { name: /-26-0002/ }));
    expect(await screen.findByRole("heading", { name: /-26-0002/ })).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      `/api/us/traceability/${route}/${exactId}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(send.mock.calls.some(([url]) => String(url).endsWith(`/${currentId}`))).toBe(false);
    expect(await screen.findByText(new RegExp(`${side}.*line 1`, "i"))).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-readiness-line")).toBe(`${side}:1`),
    );
    await user.click(screen.getByRole("button", { name: "Back to data readiness" }));
    await screen.findByRole("heading", { name: "Data readiness" });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Data readiness" }));
    expect(
      send.mock.calls.filter(([url]) => String(url).includes("/readiness")).length,
    ).toBeGreaterThan(1);
    expect(send.mock.calls.some(([url]) => String(url).includes("do-not-follow"))).toBe(false);
  },
);
it.each([
  ["receiving", { mismatch: true }],
  ["receiving", { patch: { lineNo: 99 } }],
  ["transformation", { mismatch: true }],
  ["transformation", { patch: { lineNo: 99 } }],
  ["shipping", { mismatch: true }],
  ["shipping", { patch: { lineNo: 99 } }],
] as const)(
  "rejects %s changed revision or missing line with retry/back",
  async (type, options) => {
    const { user } = await setup(type, options);
    await user.click(screen.getByRole("button", { name: /-26-0002/ }));
    expect(await screen.findByText(/source context no longer matches/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /-26-0002/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to data readiness" })).toBeTruthy();
  },
);
it("preserves applied scope, opens exact drafts and guards dirty departure", async () => {
  const { user, send } = await setup();
  fireEvent.change(screen.getByLabelText("Event date from"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Event date to"), { target: { value: "2026-09-01" } });
  await user.click(screen.getByRole("button", { name: "Check scope" }));
  await user.click(await screen.findByRole("button", { name: /REC-26-9999/ }));
  await screen.findByRole("heading", { name: "REC-26-9999" });
  expect(send).toHaveBeenCalledWith(
    `/api/us/traceability/receiving/${liveDraft.id}`,
    expect.objectContaining({ method: "GET" }),
  );
  await user.type(screen.getByLabelText("Receiving notes"), " changed");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Data readiness" }));
  expect(screen.getByRole("heading", { name: "REC-26-9999" })).toBeTruthy();
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Data readiness" }));
  await screen.findByRole("heading", { name: "Data readiness" });
  expect(screen.getByLabelText("Event date from")).toHaveProperty("value", "2026-01-01");
  await user.click(screen.getByRole("button", { name: "View events" }));
  expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
});

it("keeps focus on initial navigation and scope controls rather than moving it on each assessment", async () => {
  const { user } = await setup();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Data readiness" }));
  await user.click(screen.getByRole("button", { name: /-26-0002/ }));
  await user.click(await screen.findByRole("button", { name: "Back to data readiness" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Data readiness" })),
  );
  fireEvent.change(screen.getByLabelText("Event date from"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Event date to"), { target: { value: "2026-09-01" } });
  const apply = screen.getByRole("button", { name: "Check scope" });
  await user.click(apply);
  await screen.findByRole("button", { name: /-26-0002/ });
  expect(document.activeElement).toBe(apply);
});

it.each([
  ["receiving", "receiving", "REC-26-9999"],
  ["transformation", "transformation", "TRN-26-0001"],
  ["shipping", "shipments", "SHP-26-0001"],
] as const)(
  "opens the exact %s draft preview and returns focus to readiness",
  async (type, route, number) => {
    const { user, send } = await setup(type, { draftType: type });
    const draftId =
      type === "receiving"
        ? liveDraft.id
        : type === "transformation"
          ? transformationDraft().id
          : shippingDraft().id;
    await user.click(
      within(screen.getByRole("region", { name: "Draft work" })).getByRole("button", {
        name: new RegExp(number),
      }),
    );
    expect(await screen.findByRole("heading", { name: number })).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      `/api/us/traceability/${route}/${draftId}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(screen.getByText("Source revision 1")).toBeTruthy();
    expect(screen.queryByText(/(?:Items|Inputs|Outputs) · line/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to data readiness" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Data readiness" })),
    );
  },
);

it("asks only once when the dirty source editor confirms its Back action", async () => {
  const { user } = await setup();
  await user.click(screen.getByRole("button", { name: /REC-26-9999/ }));
  await user.type(await screen.findByLabelText("Receiving notes"), " changed");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Back to data readiness" }));
  expect(screen.getByRole("heading", { name: "REC-26-9999" })).toBeTruthy();
  confirm.mockClear().mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Back to data readiness" }));
  await screen.findByRole("heading", { name: "Data readiness" });
  expect(confirm).toHaveBeenCalledOnce();
});

it("blocks source departure while an existing editor mutation is in flight", async () => {
  const { user, send } = await setup();
  await user.click(screen.getByRole("button", { name: /REC-26-9999/ }));
  await user.type(await screen.findByLabelText("Receiving notes"), " changed");
  const transport = send.getMockImplementation();
  if (!transport) throw new Error("Missing fixture transport");
  send.mockImplementation((input, init) =>
    init?.method === "PUT" ? new Promise<Response>(() => {}) : transport(input, init),
  );
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Data readiness" })).toHaveProperty("disabled", true),
  );
  expect(screen.getByRole("button", { name: "Back to data readiness" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("heading", { name: "REC-26-9999" })).toBeTruthy();
});
it("opens lot-only IDs without inventing an event", async () => {
  const { user, send } = await setup("receiving", {
    patch: {
      cte: null,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      lotId,
      links: { lotHref: `/traceability/lots/${lotId}`, eventHref: null, relatedEventHref: null },
    },
  });
  await user.click(screen.getByRole("button", { name: /Open lot/ }));
  expect(await screen.findByRole("heading", { name: "EXACT-LOT" })).toBeTruthy();
  expect(send).toHaveBeenCalledWith(
    `/api/us/traceability/lots/${lotId}`,
    expect.objectContaining({ method: "GET" }),
  );
});
it("opens the exact excluded origin revision from a retained lot gap", async () => {
  const { user, send } = await setup("transformation", {
    patch: {
      code: "origin_gap",
      cte: null,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      lotId,
      relatedEventId: exactId,
      relatedEvent: { type: "transformation", eventNumber: "TRN-26-0002", revision: 2 },
      links: {
        lotHref: `/traceability/lots/${lotId}`,
        eventHref: null,
        relatedEventHref: "/traceability/do-not-follow",
      },
    },
  });
  await user.click(screen.getByRole("button", { name: /Origin event TRN-26-0002.*rev 2/ }));
  expect(await screen.findByRole("heading", { name: "TRN-26-0002" })).toBeTruthy();
  expect(send).toHaveBeenCalledWith(
    `/api/us/traceability/transformation/${exactId}`,
    expect.objectContaining({ method: "GET" }),
  );
  expect(send.mock.calls.some(([url]) => String(url).includes("do-not-follow"))).toBe(false);
  expect(send.mock.calls.some(([url]) => String(url).endsWith(`/${currentId}`))).toBe(false);
});
it("does not replace a foreign related origin with a current or root event", async () => {
  const foreignId = "90000000-0000-4000-8000-000000000099";
  const { user, send } = await setup("transformation", {
    patch: {
      code: "origin_gap",
      cte: null,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      lotId,
      relatedEventId: foreignId,
      relatedEvent: { type: "transformation", eventNumber: "TRN-26-0099", revision: 2 },
      links: {
        lotHref: `/traceability/lots/${lotId}`,
        eventHref: null,
        relatedEventHref: "/traceability/do-not-follow",
      },
    },
  });
  const originalSend = send.getMockImplementation();
  if (!originalSend) throw new Error("Missing transport");
  send.mockImplementation((input, init) =>
    String(input).endsWith(`/${foreignId}`)
      ? Promise.resolve(Response.json({ code: "not_found" }, { status: 404 }))
      : originalSend(input, init),
  );
  await user.click(screen.getByRole("button", { name: /Origin event TRN-26-0099.*rev 2/ }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Transformation record could not be loaded.",
  );
  expect(masterDataCopy["es-US"].transformation.loadError).toBe(
    "No se pudo cargar el registro de transformación.",
  );
  expect(send).toHaveBeenCalledWith(
    `/api/us/traceability/transformation/${foreignId}`,
    expect.objectContaining({ method: "GET" }),
  );
  expect(send.mock.calls.some(([url]) => String(url).endsWith(`/${currentId}`))).toBe(false);
  expect(send.mock.calls.some(([url]) => String(url).endsWith(`/${rootId}`))).toBe(false);
});
it("keeps event-wide findings without a line and non-FTL findings without lot actions", async () => {
  const { user } = await setup("receiving", { patch: { lineSide: null, lineNo: null } });
  expect(within(screen.getByRole("table")).queryByRole("button", { name: /Open lot/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: /-26-0002/ }));
  await screen.findByRole("heading", { name: /-26-0002/ });
  expect(screen.queryByText(/items.*line/i)).toBeNull();
});

it("opens a non-FTL input by its actual line number without inventing a lot", async () => {
  const { user } = await setup("transformation", { nonFtl: true, patch: { lineNo: 2 } });
  expect(within(screen.getByRole("table")).queryByRole("button", { name: /Open lot/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: /-26-0002.*input 2/ }));
  await screen.findByText("External apples");
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-readiness-line")).toBe("inputs:2"),
  );
  expect(document.activeElement?.textContent).toContain("External apples");
});

it("revalidates the exact receiving source after a lot round trip instead of displaying its cached record", async () => {
  const { user, send } = await setup();
  await user.click(screen.getByRole("button", { name: /-26-0002/ }));
  await screen.findByRole("heading", { name: /-26-0002/ });
  const [openLot] = screen.getAllByRole("button", { name: "Open current lot" });
  if (!openLot) throw new Error("Missing frozen lot action");
  await user.click(openLot);
  const back = await screen.findByRole("button", { name: "Back to receiving" });
  const transport = send.getMockImplementation();
  if (!transport) throw new Error("Missing fixture transport");
  send.mockImplementation(async (input, init) => {
    const response = await transport(input, init);
    if (!String(input).endsWith(`/${exactId}`)) return response;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) throw new Error("Invalid record fixture");
    return Response.json({ ...body, revision: 3 });
  });
  await user.click(back);
  expect(await screen.findByText(/source context no longer matches/i)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /-26-0002/ })).toBeNull();
});
it("removes source navigation when read capability is lost", async () => {
  const { user } = await setup("receiving", { denied: true });
  await user.click(screen.getByRole("button", { name: /-26-0002/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Data readiness" })).toBeNull());
  expect(screen.queryByRole("heading", { name: /-26-0002/ })).toBeNull();
});

it.each(["receiving", "transformation", "shipping"] as const)(
  "rejects a mismatched %s identity at the client boundary as a source error",
  async (type) => {
    const { user, send } = await setup(type);
    const transport = send.getMockImplementation();
    if (!transport) throw new Error("Missing fixture transport");
    send.mockImplementation(async (input, init) => {
      const response = await transport(input, init);
      if (!String(input).endsWith(`/${exactId}`)) return response;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) throw new Error("Invalid record fixture");
      return Response.json({ ...body, id: currentId });
    });
    await user.click(screen.getByRole("button", { name: /-26-0002/ }));
    expect(await screen.findByText(/source context no longer matches/i)).toBeTruthy();
  },
);
