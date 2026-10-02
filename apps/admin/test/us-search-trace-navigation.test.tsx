import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { liveFinalized } from "./support/us-receiving-command-fixture.js";

const lotId = "10000000-0000-4000-8000-000000000001";
const productId = "10000000-0000-4000-8000-000000000002";
async function setup(
  options: { mismatch?: boolean; denied?: boolean; pendingCases?: boolean; edge?: boolean } = {},
) {
  let denied = false;
  let finishCase = () => {};
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/cases") && init?.method === "POST" && options.pendingCases)
      return new Promise<Response>((resolve) => {
        finishCase = () => resolve(Response.json({ lotId, created: [], unchanged: [] }));
      });
    if (url.endsWith("/access"))
      return Response.json({
        capabilities: denied
          ? []
          : [
              "traceability.read",
              "traceability.master_data.write",
              "traceability.transformation.write",
            ],
      });
    if (url.includes("/search?"))
      return Response.json({
        items: [
          {
            lotId,
            productId,
            tlc: "NRF-260915-APL01",
            source: { kind: "location", locationId: productId },
            status: "active",
            matchedBy: ["tlc"],
            currentCteCount: 0,
            firstEventDate: null,
            lastEventDate: null,
            ssccLinks: [],
            moreCaseHistory: false,
          },
        ],
        nextCursor: url.includes("cursor=") ? null : "page-two",
        appliedFilters: { q: "NRF", tlcList: null, limit: 50 },
        rangeOrder: "lexical_c",
      });
    if (url.endsWith(`/lots/${lotId}`))
      return Response.json({
        id: lotId,
        productId,
        tlc: "NRF-260915-APL01",
        source: null,
        assignmentBasis: "imported",
        sourceLockedAt: null,
        status: "active",
        revision: 1,
        createdBy: "qa",
        updatedBy: "qa",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      });
    if (url.includes("/trace?")) {
      if (options.denied) {
        denied = true;
        return Response.json({ code: "forbidden" }, { status: 403 });
      }
      return Response.json({
        rootLotId: lotId,
        direction: new URL(url, "http://local").searchParams.get("direction"),
        nodes: [
          { id: `lot:${lotId}`, kind: "lot", lotId, tlc: "NRF-260915-APL01" },
          ...(options.edge
            ? [
                {
                  id: `location:${productId}`,
                  kind: "location",
                  locationId: productId,
                  display: "Supplier",
                  displayEdgeId: `${liveFinalized.id}:receiving:1`,
                },
              ]
            : []),
        ],
        edges: options.edge
          ? [
              {
                id: `${liveFinalized.id}:receiving:1`,
                kind: "receiving",
                from: `location:${productId}`,
                to: `lot:${lotId}`,
                eventId: liveFinalized.id,
                eventNumber: liveFinalized.eventNumber,
                revision: liveFinalized.revision,
                lineNo: 1,
                eventDate: "2026-09-20",
                timeZone: "America/Chicago",
                quantity: "10",
                unitOfMeasure: "kg",
                locationDisplay: "Supplier",
              },
            ]
          : [],
        currentEvents: options.edge
          ? [
              {
                id: liveFinalized.id,
                rootId: liveFinalized.id,
                type: "receiving",
                eventNumber: liveFinalized.eventNumber,
                revision: liveFinalized.revision,
                eventDate: "2026-09-20",
                timeZone: "America/Chicago",
              },
            ]
          : [],
        findings: [],
        excludedSummary: { count: 1 },
        completion: {
          state: "complete",
          returnedNodes: options.edge ? 2 : 1,
          returnedEdges: options.edge ? 1 : 0,
        },
      });
    }
    if (url.includes("/trace/history?"))
      return Response.json({
        items: [
          {
            eventId: liveFinalized.id,
            rootId: liveFinalized.id,
            type: "receiving",
            eventNumber: "REC-EXACT",
            revision: options.mismatch ? 99 : liveFinalized.revision,
            status: "void",
            eventDate: "2026-09-20",
            reason: "Historical",
            previousRevisionId: null,
            nextRevisionId: null,
            createdAt: "2026-09-20T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    if (url.endsWith(`/receiving/${liveFinalized.id}`)) return Response.json(liveFinalized);
    if (url.includes("/cases?"))
      return Response.json({
        lotId,
        originState: "current",
        activeCount: 0,
        rows: [],
        nextCursor: null,
      });
    if (url.includes("?")) return Response.json({ items: [], limit: 50, offset: 0 });
    return Response.json({}, { status: 503 });
  });
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { "en-US": { translation: masterDataCopy["en-US"] } },
    lng: "en-US",
    initAsync: false,
  });
  const client = createUsBrowserClient(send);
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={i18n}>
        <MasterDataWorkspace
          client={client}
          organization={{ id: productId, name: "Office" }}
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
  const nav = await screen.findByRole("navigation", { name: "Reference data" });
  await user.click(within(nav).getByRole("button", { name: "Search" }));
  return { user, nav, send, client, finishCase: () => finishCase() };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function openLot(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Exact lookup"), "NRF");
  await user.click(screen.getAllByRole("button", { name: "Search" })[1]!);
  await user.click(await screen.findByRole("button", { name: /Open lot 1/ }));
  await screen.findByRole("heading", { name: "NRF-260915-APL01" });
}
it("keeps separate sidebar entries and starts direct Trace without a selected lot", async () => {
  const { user, nav } = await setup();
  expect(within(nav).getByRole("button", { name: "Search", current: "page" })).toBeTruthy();
  await openLot(user);
  await user.click(screen.getByRole("button", { name: "Trace backward" }));
  await screen.findByRole("heading", { name: "Trace" });
  await user.click(within(nav).getByRole("button", { name: "Trace" }));
  expect(screen.getByLabelText("Lot")).toHaveProperty("value", "");
});
it("returns event to Trace to lot to the applied Search cursor page and row focus", async () => {
  const { user, send } = await setup();
  await user.type(screen.getByLabelText("Exact lookup"), "NRF");
  await user.click(screen.getAllByRole("button", { name: "Search" })[1]!);
  await user.click(await screen.findByRole("button", { name: "Next" }));
  await user.click(await screen.findByRole("button", { name: /Open lot 1/ }));
  await user.click(await screen.findByRole("button", { name: "Trace backward" }));
  await user.click(await screen.findByRole("button", { name: /REC-EXACT/ }));
  await user.click(await screen.findByRole("button", { name: /Back to Trace/ }));
  expect(await screen.findByRole("heading", { name: "Trace" })).toBeTruthy();
  expect(screen.getByLabelText("Direction")).toHaveProperty("value", "backward");
  await user.click(screen.getByRole("button", { name: /Back to lot/ }));
  await user.click(await screen.findByRole("button", { name: /Back to Search/ }));
  const row = await screen.findByRole("button", { name: /Open lot 1/ });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(screen.getByLabelText("Exact lookup")).toHaveProperty("value", "NRF");
  expect(send.mock.calls.filter(([url]) => String(url).includes("/search?")).at(-1)?.[0]).toContain(
    "cursor=page-two",
  );
});
it("closes source navigation when Trace detects lost read capability", async () => {
  const { user } = await setup({ denied: true });
  await openLot(user);
  await user.click(screen.getByRole("button", { name: "Trace backward" }));
  await waitFor(() =>
    expect(screen.queryByRole("navigation", { name: "Reference data" })).toBeNull(),
  );
  expect(screen.getByRole("alert")).toBeTruthy();
});
it.each(["missing", "failed"] as const)(
  "focuses the Search heading on confirmed Back when the refreshed row is %s",
  async (outcome) => {
    const { user, client } = await setup();
    await user.type(screen.getByLabelText("Exact lookup"), "NRF");
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: /Open lot 1/ }));
    await screen.findByRole("heading", { name: "NRF-260915-APL01" });
    const refresh = vi.spyOn(client, "searchTraceLots");
    if (outcome === "failed") refresh.mockRejectedValue(new Error("offline"));
    else
      refresh.mockResolvedValue({
        items: [],
        nextCursor: null,
        appliedFilters: { q: "NRF", tlcList: null, limit: 50 },
        rangeOrder: "lexical_c",
      });
    await user.click(screen.getByRole("button", { name: /Back to Search/ }));
    if (outcome === "failed") await screen.findByRole("alert");
    else await screen.findByText("No lots match these filters.");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Search" })),
    );
    expect(screen.getByLabelText("Exact lookup")).toHaveProperty("value", "NRF");
    expect(refresh).toHaveBeenCalledWith({ q: "NRF", limit: "50", cursor: "page-two" });
    expect(screen.queryByRole("button", { name: /Back to Search/ })).toBeNull();
  },
);
it("retains retry and Trace return when the exact event revision mismatches", async () => {
  const { user } = await setup({ mismatch: true });
  await openLot(user);
  await user.click(screen.getByRole("button", { name: "Trace backward" }));
  await user.click(await screen.findByRole("button", { name: /REC-EXACT/ }));
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Back to Trace/ }));
  expect(await screen.findByRole("heading", { name: "Trace" })).toBeTruthy();
});
it("keeps a dirty Case input and return stack when sidebar navigation is cancelled", async () => {
  const { user, nav } = await setup();
  await openLot(user);
  await user.type(await screen.findByRole("textbox", { name: "Case SSCC" }), "000000000000000000");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(within(nav).getByRole("button", { name: "Trace" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Case SSCC" })).toHaveProperty(
    "value",
    "000000000000000000",
  );
  await user.click(screen.getByRole("button", { name: /Back to Search/ }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("heading", { name: "NRF-260915-APL01" })).toBeTruthy();
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: /Back to Search/ }));
  expect(await screen.findByRole("heading", { name: "Search" })).toBeTruthy();
});
it("blocks Search and Trace navigation while the Case mutation is pending", async () => {
  const { user, nav, finishCase } = await setup({ pendingCases: true });
  await openLot(user);
  await user.type(await screen.findByRole("textbox", { name: "Case SSCC" }), "000000000000000000");
  await user.click(screen.getByRole("button", { name: "Link cases" }));
  expect(within(nav).getByRole("button", { name: "Search" })).toHaveProperty("disabled", true);
  expect(within(nav).getByRole("button", { name: "Trace" })).toHaveProperty("disabled", true);
  await user.click(within(nav).getByRole("button", { name: "Trace" }));
  expect(screen.getByRole("heading", { name: "NRF-260915-APL01" })).toBeTruthy();
  finishCase();
  await waitFor(() =>
    expect(within(nav).getByRole("button", { name: "Trace" })).toHaveProperty("disabled", false),
  );
});
it("opens the exact Trace edge revision and source line and retains direction after lot detail", async () => {
  const { user, send } = await setup({ edge: true });
  await openLot(user);
  await user.click(screen.getByRole("button", { name: "Trace forward" }));
  await user.click(await screen.findByRole("button", { name: /Open lot NRF/ }));
  await user.click(await screen.findByRole("button", { name: /Back to Trace/ }));
  expect(screen.getByLabelText("Direction")).toHaveProperty("value", "forward");
  await user.click(await screen.findByRole("button", { name: /Receiving.*Line 1/i }));
  await screen.findByRole("heading", { name: liveFinalized.eventNumber });
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("data-readiness-line")).toBe("items:1"),
  );
  expect(
    send.mock.calls.some(
      ([url]) => String(url) === `/api/us/traceability/receiving/${liveFinalized.id}`,
    ),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: /Back to Trace/ }));
  expect(screen.getByRole("heading", { name: "Trace" })).toBe(document.activeElement);
});
it("keeps current-lot Findings in the card without adding a self-navigation Back loop", async () => {
  const { user, client } = await setup();
  vi.spyOn(client, "readReadiness").mockResolvedValue({
    scope: {
      eventDateFrom: "2026-09-01",
      eventDateTo: "2026-09-28",
      productId: null,
      lotId,
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      defaulted: false,
    },
    assessedAt: "2026-09-28T10:00:00.000Z",
    state: "assessed",
    recordsChecked: { events: 0, lots: 1 },
    dependenciesChecked: 0,
    counts: { error: 0, warning: 1, info: 0 },
    groups: { byCte: [], byProduct: [], bySeverity: [{ severity: "warning", count: 1 }] },
    findings: [
      {
        key: "same-lot",
        ruleVersion: "us-readiness-v1",
        code: "origin_gap",
        severity: "warning",
        cte: null,
        field: "origin",
        message: { key: "readiness.origin_gap", params: {} },
        lotId,
        productId,
        eventId: null,
        rootId: null,
        eventNumber: null,
        revision: null,
        eventDate: null,
        lineSide: null,
        lineNo: null,
        relatedEventId: null,
        relatedEvent: null,
        links: { lotHref: `/traceability/lots/${lotId}`, eventHref: null, relatedEventHref: null },
      },
    ],
    draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
  });
  await openLot(user);
  const findings = screen.getByRole("region", { name: "Lot findings" });
  await within(findings).findByText(/origin/);
  expect(within(findings).queryByRole("button", { name: /Open lot/ })).toBeNull();
  expect(screen.getByRole("heading", { name: "NRF-260915-APL01" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Back to Search/ }));
  expect(await screen.findByRole("heading", { name: "Search" })).toBeTruthy();
});
