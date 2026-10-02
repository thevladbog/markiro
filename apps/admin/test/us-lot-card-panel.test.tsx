import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type {
  UsLotCard,
  UsLotCardEvidencePage,
  UsReadinessResult,
  UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsClientError } from "../src/us/client.js";
import { lotCopy } from "../src/us/lots/copy.js";
import { LotCardPanels } from "../src/us/lots/card-panels.js";
import { usReadinessCopy } from "../src/us/readiness/copy.js";

const lotId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const eventId = "20000000-0000-4000-8000-000000000001";
const productId = "30000000-0000-4000-8000-000000000001";
const description = {
  snapshotVersion: 1 as const,
  sourceProductId: productId,
  productName: "Frozen origin description",
  brandName: null,
  commodity: null,
  variety: null,
  packagingSize: null,
  packagingStyle: null,
  gtin: null,
};
const card: UsLotCard = {
  lot: {
    id: lotId,
    tlc: "LOT-01",
    productId,
    source: {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example/lot",
      resolvedLocationId: otherId,
    },
    status: "active",
  },
  currentMasterProduct: { id: productId, name: "Current catalog name" },
  currentOriginProducts: [
    {
      kind: "receiving",
      eventId,
      rootId: eventId,
      revision: 2,
      eventDate: "2026-09-15",
      lineNo: 2,
      productId,
      description,
    },
  ],
  currentOriginProductCount: 1,
  moreCurrentOriginProducts: false,
  originState: "current",
  caseSummary: { activeCount: 3, historicalCount: 2 },
  balance: { state: "known", unitOfMeasure: "kg", supply: "20", used: "4", remaining: "16" },
  currentCteCount: 1,
  firstEventDate: "2026-09-15",
  lastEventDate: "2026-09-15",
  links: { cases: "cases", trace: "trace", history: "trace/history" },
};
const evidence: UsLotCardEvidencePage = {
  items: [
    {
      eventId,
      rootId: eventId,
      type: "receiving",
      eventNumber: "REC-26-0001",
      revision: 2,
      eventDate: "2026-09-15",
      timeZone: "America/New_York",
      lines: [
        {
          kind: "receiving",
          lineNo: 2,
          quantity: "20",
          unitOfMeasure: "kg",
          originProduct: { kind: "receiving", productId, description },
        },
      ],
      documents: [{ documentId: otherId, type: "invoice", number: "INV-01" }],
    },
  ],
  nextCursor: "nextPage",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const readiness: UsReadinessResult = {
  scope: {
    eventDateFrom: "2024-10-01",
    eventDateTo: "2026-09-28",
    productId: null,
    lotId,
    profileCode: "US_GENERIC_LOT_TRACEABILITY",
    defaulted: true,
  },
  assessedAt: "2026-09-28T10:00:00.000Z",
  state: "assessed",
  recordsChecked: { events: 1, lots: 1 },
  dependenciesChecked: 0,
  counts: { error: 0, warning: 0, info: 0 },
  groups: { byCte: [], byProduct: [], bySeverity: [] },
  findings: [],
  draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
};
async function setup(withNavigation = true, locale: "en-US" | "es-US" = "en-US") {
  const instance = i18next.createInstance();
  await instance.init({
    lng: locale,
    initAsync: false,
    resources: {
      [locale]: { translation: { lots: lotCopy[locale], usReadiness: usReadinessCopy[locale] } },
    },
  });
  const client = createUsBrowserClient();
  const getCard = vi.spyOn(client, "getLotCard").mockResolvedValue(card);
  const getEvidence = vi.spyOn(client, "listLotCardEvidence").mockResolvedValue(evidence);
  const getReadiness = vi.spyOn(client, "readReadiness").mockResolvedValue(readiness);
  const getHistory = vi
    .spyOn(client, "listTraceHistory")
    .mockResolvedValue({ items: [], nextCursor: null });
  const onOpenLot = vi.fn();
  const onOpenEvent = vi.fn();
  const onOpenTrace = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const onSessionLost = vi.fn();
  const view = (id = lotId, disabled = false) => (
    <ThemeProvider>
      <I18nextProvider i18n={instance}>
        <LotCardPanels
          client={client}
          lotId={id}
          disabled={disabled}
          {...(withNavigation ? { onOpenEvent, onOpenTrace, onOpenLot } : {})}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
        />
      </I18nextProvider>
    </ThemeProvider>
  );
  return {
    getCard,
    getEvidence,
    getReadiness,
    getHistory,
    onOpenLot,
    onOpenEvent,
    onOpenTrace,
    onForbidden,
    onSessionLost,
    view,
    user: userEvent.setup(),
  };
}
it("keeps current master separate from frozen origin and opens exact line/document owners", async () => {
  const s = await setup();
  render(s.view());
  expect(await screen.findByText("Current catalog name")).toBeTruthy();
  expect(s.getEvidence).toHaveBeenCalledWith(lotId, { limit: "20" });
  expect(screen.getAllByText("Frozen origin description").length).toBeGreaterThan(0);
  expect(screen.getByText("16 kg")).toBeTruthy();
  await s.user.click(screen.getByRole("button", { name: /REC-26-0001.*line 2/i }));
  expect(s.onOpenEvent).toHaveBeenLastCalledWith({
    type: "receiving",
    eventId,
    revision: 2,
    lineSide: "items",
    lineNo: 2,
  });
  await s.user.click(screen.getByRole("button", { name: /INV-01/ }));
  expect(s.onOpenEvent).toHaveBeenLastCalledWith({
    type: "receiving",
    eventId,
    revision: 2,
    lineSide: null,
    lineNo: null,
  });
  await s.user.click(screen.getByRole("button", { name: "Trace backward" }));
  expect(s.onOpenTrace).toHaveBeenCalledWith("backward");
  await s.user.click(screen.getByRole("button", { name: "Next evidence page" }));
  await waitFor(() =>
    expect(s.getEvidence).toHaveBeenLastCalledWith(lotId, { limit: "20", cursor: "nextPage" }),
  );
});
it("preserves identity, source and Cases with an origin gap and unknown balance", async () => {
  const s = await setup();
  s.getCard.mockResolvedValue({
    ...card,
    originState: "gap",
    currentOriginProducts: [],
    currentOriginProductCount: 0,
    balance: { state: "unknown", reason: "no_current_origin" },
  });
  render(s.view());
  expect(await screen.findByText("Current origin gap")).toBeTruthy();
  expect(screen.getByText("LOT-01")).toBeTruthy();
  expect(screen.getByText("https://supplier.example/lot")).toBeTruthy();
  expect(screen.getByText("Active Cases: 3 · Historical Cases: 2")).toBeTruthy();
  expect(screen.getByText(/Balance unknown/)).toBeTruthy();
  expect(screen.queryByText("0 kg")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
it("shows bounded origin count and independently retries failed card reads", async () => {
  const s = await setup();
  s.getCard.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
    ...card,
    currentOriginProducts: Array.from({ length: 50 }, (_, index) => ({
      kind: "receiving",
      eventId,
      rootId: eventId,
      revision: 2,
      eventDate: "2026-09-15",
      lineNo: index + 1,
      productId,
      description,
    })),
    currentOriginProductCount: 51,
    moreCurrentOriginProducts: true,
  });
  render(s.view());
  expect(await screen.findByText("The current lot summary could not be loaded.")).toBeTruthy();
  expect(await screen.findByRole("button", { name: /REC-26-0001.*line 2/i })).toBeTruthy();
  await s.user.click(screen.getByRole("button", { name: "Refresh lot summary" }));
  expect(
    await screen.findByText(
      "Showing 50 of 51 current origin lines. More origins are available in evidence and Trace.",
    ),
  ).toBeTruthy();
});
it("keeps card available on evidence failure and handles authorization", async () => {
  const s = await setup();
  s.getEvidence.mockRejectedValueOnce(new UsClientError("forbidden"));
  render(s.view());
  expect(await screen.findByText("Current catalog name")).toBeTruthy();
  expect(await screen.findByText("The frozen evidence could not be loaded.")).toBeTruthy();
  await waitFor(() => expect(s.onForbidden).toHaveBeenCalledOnce());
  await s.user.click(screen.getByRole("button", { name: "Refresh evidence" }));
  expect(await screen.findByRole("button", { name: /INV-01/ })).toBeTruthy();
});
it("ignores old lot responses and resets the evidence cursor when selection changes", async () => {
  const s = await setup();
  const rendered = render(s.view());
  await screen.findByText("Current catalog name");
  let release!: (value: UsLotCardEvidencePage) => void;
  s.getEvidence.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await s.user.click(screen.getByRole("button", { name: "Next evidence page" }));
  s.getCard.mockResolvedValue({ ...card, lot: { ...card.lot, id: otherId, tlc: "LOT-02" } });
  s.getEvidence.mockResolvedValue({ items: [], nextCursor: null });
  rendered.rerender(s.view(otherId));
  await screen.findByText("LOT-02");
  await act(async () => release(evidence));
  expect(screen.queryByText("LOT-01")).toBeNull();
  expect(screen.queryByRole("button", { name: /INV-01/ })).toBeNull();
  expect(s.getEvidence).toHaveBeenLastCalledWith(otherId, { limit: "20" });
});
it.each(["en-US", "es-US"] as const)(
  "labels transformation sides in %s and preserves targets",
  async (locale) => {
    const s = await setup(true, locale);
    const first = evidence.items[0];
    if (!first) throw new Error("Evidence fixture required");
    s.getEvidence.mockResolvedValue({
      items: [
        {
          ...first,
          type: "transformation",
          lines: [
            {
              kind: "transformation_input",
              lineNo: 3,
              quantity: "4",
              unitOfMeasure: "kg",
              originProduct: null,
            },
            {
              kind: "transformation_output",
              lineNo: 4,
              quantity: "3",
              unitOfMeasure: "kg",
              originProduct: { kind: "transformation", productId, description: "Frozen output" },
            },
          ],
        },
      ],
      nextCursor: null,
    });
    const rendered = render(s.view());
    await s.user.click(await screen.findByRole("button", { name: /(?:line|línea) 3/i }));
    expect(screen.getByText(locale === "en-US" ? "Input · 4 kg" : "Entrada · 4 kg")).toBeTruthy();
    expect(screen.getByText(locale === "en-US" ? "Output · 3 kg" : "Salida · 3 kg")).toBeTruthy();
    expect(s.onOpenEvent).toHaveBeenLastCalledWith({
      type: "transformation",
      eventId,
      revision: 2,
      lineSide: "inputs",
      lineNo: 3,
    });
    await s.user.click(screen.getByRole("button", { name: /(?:line|línea) 4/i }));
    expect(s.onOpenEvent).toHaveBeenLastCalledWith({
      type: "transformation",
      eventId,
      revision: 2,
      lineSide: "outputs",
      lineNo: 4,
    });
    rendered.rerender(s.view(lotId, true));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /(?:line|línea) 3/i }).disabled,
    ).toBe(true);
  },
);

it("shows the effective period and limits zero findings to it", async () => {
  const s = await setup();
  render(s.view());
  expect(await screen.findByText("No findings in this period.")).toBeTruthy();
  expect(screen.getByText(/Oct 1, 2024.*Sep 28, 2026/)).toBeTruthy();
  expect(screen.queryByText(/compliant|lifetime/i)).toBeNull();
  expect(s.getReadiness).toHaveBeenCalledWith({ lotId });
  expect(s.getHistory).toHaveBeenCalledWith(lotId, { limit: "50" });
  expect(screen.getByRole("button", { name: "Next history page" })).toHaveProperty(
    "disabled",
    true,
  );
});

it.each([
  ["en-US", "Sep 15, 2026", "Sep 14, 2026", "Oct 1, 2024", "Sep 28, 2026"],
  ["es-US", "15 sept 2026", "14 sept 2026", "1 oct 2024", "28 sept 2026"],
] as const)(
  "formats every lot panel civil date in %s without changing its day",
  async (locale, currentDate, historicalDate, from, to) => {
    const s = await setup(true, locale);
    s.getHistory.mockResolvedValue({
      items: [
        {
          eventId: otherId,
          rootId: eventId,
          type: "receiving",
          eventNumber: "REC-OLD",
          revision: 1,
          status: "amended",
          reason: "Corrected quantity",
          previousRevisionId: null,
          nextRevisionId: eventId,
          eventDate: "2026-09-14",
          createdAt: "2026-09-14T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    render(s.view());
    const copy = lotCopy[locale];
    const summary = within(screen.getByRole("region", { name: copy.cardTitle }));
    expect(await summary.findByText(`1 · ${currentDate} – ${currentDate}`)).toBeTruthy();
    expect(
      summary.getByText(
        `${currentDate} · ${locale === "en-US" ? "Revision 2 · line 2" : "Revisión 2 · línea 2"}`,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: copy.cardEvidence })).getByRole("heading", {
        name: `REC-26-0001 · ${currentDate} · America/New_York`,
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: copy.cardFindings })).getByText(
        `${locale === "en-US" ? "Effective period" : "Período efectivo"} · ${from} – ${to}`,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: copy.cardHistory })).getByText(
        `${copy.cardHistoryStatus.amended} · ${historicalDate}`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/2026-09-15|2026-09-14|2024-10-01|2026-09-28/)).toBeNull();
    expect(s.getReadiness).toHaveBeenCalledWith({ lotId });
    expect(evidence.items[0]?.eventDate).toBe("2026-09-15");
    expect(readiness.scope.eventDateFrom).toBe("2024-10-01");
  },
);

it("filters findings to the selected lot and opens a lot-only source", async () => {
  const s = await setup();
  const finding = {
    key: "gap",
    ruleVersion: "us-readiness-v1" as const,
    code: "origin_gap",
    severity: "error" as const,
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
  };
  s.getReadiness.mockResolvedValue({
    ...readiness,
    findings: [finding, { ...finding, key: "foreign", lotId: otherId, field: "FOREIGN" }],
  });
  render(s.view());
  await s.user.click(await screen.findByRole("button", { name: `Open lot ${lotId}` }));
  expect(s.onOpenLot).toHaveBeenCalledWith(lotId);
  expect(screen.queryByText(/FOREIGN/)).toBeNull();
  expect(s.onOpenEvent).not.toHaveBeenCalled();
});

it("keeps excluded revisions outside current evidence and pages with exact cursor", async () => {
  const s = await setup();
  s.getHistory.mockResolvedValueOnce({
    items: [
      {
        eventId: otherId,
        rootId: eventId,
        type: "receiving",
        eventNumber: "REC-OLD",
        revision: 1,
        status: "amended",
        reason: "Corrected quantity",
        previousRevisionId: null,
        nextRevisionId: eventId,
        eventDate: "2026-09-14",
        createdAt: "2026-09-14T10:00:00.000Z",
      },
    ],
    nextCursor: "historyNext",
  });
  render(s.view());
  await s.user.click(await screen.findByRole("button", { name: /REC-OLD/ }));
  expect(s.onOpenEvent).toHaveBeenCalledWith({
    type: "receiving",
    eventId: otherId,
    revision: 1,
    lineSide: null,
    lineNo: null,
  });
  expect(
    within(screen.getByRole("region", { name: "Frozen event evidence" })).queryByText(/REC-OLD/),
  ).toBeNull();
  expect(screen.getByText("Corrected quantity")).toBeTruthy();
  expect(screen.getByText(`Next revision · ${eventId}`)).toBeTruthy();
  await s.user.click(screen.getByRole("button", { name: "Next history page" }));
  await waitFor(() =>
    expect(s.getHistory).toHaveBeenLastCalledWith(lotId, { limit: "50", cursor: "historyNext" }),
  );
});

it("shows missing or foreign detail errors without false empty findings or history", async () => {
  const s = await setup();
  s.getReadiness.mockRejectedValue(new UsClientError("readiness_scope_not_found"));
  s.getHistory.mockRejectedValue(new UsClientError("trace_lot_not_found"));
  render(s.view());
  expect(await screen.findByText("Lot findings could not be loaded.")).toBeTruthy();
  expect(await screen.findByText("Excluded history could not be loaded.")).toBeTruthy();
  expect(screen.queryByText("No findings in this period.")).toBeNull();
  expect(screen.queryByText("No excluded revisions on this page.")).toBeNull();
  expect(screen.getByText("Current catalog name")).toBeTruthy();
});

it("ignores delayed findings and history when the selected lot changes", async () => {
  const s = await setup();
  let releaseFindings: (value: UsReadinessResult) => void = () => {
    throw new Error("Pending findings required");
  };
  let releaseHistory: (value: UsTraceHistoryPage) => void = () => {
    throw new Error("Pending history required");
  };
  s.getReadiness.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseFindings = resolve;
      }),
  );
  s.getHistory.mockResolvedValueOnce({ items: [], nextCursor: "oldCursor" });
  const rendered = render(s.view());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Next history page" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  s.getHistory.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseHistory = resolve;
      }),
  );
  await s.user.click(screen.getByRole("button", { name: "Next history page" }));
  s.getReadiness.mockResolvedValue({
    ...readiness,
    scope: { ...readiness.scope, lotId: otherId, eventDateFrom: "2026-01-01" },
  });
  rendered.rerender(s.view(otherId));
  await screen.findByText(/Jan 1, 2026.*Sep 28, 2026/);
  await act(async () => {
    releaseFindings(readiness);
    releaseHistory({ items: [], nextCursor: "staleCursor" });
  });
  expect(screen.queryByText(/Oct 1, 2024.*Sep 28, 2026/)).toBeNull();
  expect(s.getHistory).toHaveBeenLastCalledWith(otherId, { limit: "50" });
  expect(s.getReadiness).toHaveBeenLastCalledWith({ lotId: otherId });
  expect(screen.getByRole("button", { name: "Next history page" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("opens exact finding and related origin targets and honors navigation locks", async () => {
  const s = await setup();
  s.getReadiness.mockResolvedValue({
    ...readiness,
    findings: [
      {
        key: "gap",
        ruleVersion: "us-readiness-v1",
        code: "origin_gap",
        severity: "error",
        cte: "transformation",
        field: "origin",
        message: { key: "readiness.origin_gap", params: {} },
        lotId,
        productId,
        eventId: otherId,
        rootId: eventId,
        eventNumber: "TRN-EXACT",
        revision: 2,
        eventDate: "2026-09-28",
        lineSide: "inputs",
        lineNo: 3,
        relatedEventId: eventId,
        relatedEvent: { type: "receiving", eventNumber: "REC-ORIGIN", revision: 1 },
        links: {
          lotHref: `/traceability/lots/${lotId}`,
          eventHref: "/traceability/ignore",
          relatedEventHref: "/traceability/ignore",
        },
      },
    ],
  });
  const rendered = render(s.view());
  await s.user.click(await screen.findByRole("button", { name: /TRN-EXACT/ }));
  expect(s.onOpenEvent).toHaveBeenLastCalledWith({
    type: "transformation",
    eventId: otherId,
    revision: 2,
    lineSide: "inputs",
    lineNo: 3,
  });
  await s.user.click(screen.getByRole("button", { name: /REC-ORIGIN/ }));
  expect(s.onOpenEvent).toHaveBeenLastCalledWith({
    type: "receiving",
    eventId,
    revision: 1,
    lineSide: null,
    lineNo: null,
  });
  rendered.rerender(s.view(lotId, true));
  for (const name of [/TRN-EXACT/, /REC-ORIGIN/, /Open lot/])
    expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
});

it("does not let a delayed card for the previous lot replace the selected lot", async () => {
  const s = await setup();
  let release!: (value: UsLotCard) => void;
  s.getCard.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const rendered = render(s.view());
  s.getCard.mockResolvedValue({ ...card, lot: { ...card.lot, id: otherId, tlc: "LOT-02" } });
  rendered.rerender(s.view(otherId));
  await screen.findByText("LOT-02");
  await act(async () => release(card));
  expect(screen.queryByText("LOT-01")).toBeNull();
  expect(screen.getByText("LOT-02")).toBeTruthy();
});

it("hides navigation controls when callbacks are absent", async () => {
  const s = await setup(false);
  render(s.view());
  await screen.findByText("Current catalog name");
  expect(
    screen.queryByRole("button", { name: /Trace backward|Trace forward|REC-26-0001|INV-01/ }),
  ).toBeNull();
  expect(screen.getByText(/invoice · INV-01/)).toBeTruthy();
});

it("maps shipping lines to items and reports lost sessions", async () => {
  const s = await setup();
  const first = evidence.items[0];
  if (!first) throw new Error("Evidence fixture required");
  s.getEvidence.mockResolvedValue({
    items: [
      {
        ...first,
        type: "shipping",
        lines: [
          { kind: "shipping", lineNo: 1, quantity: "2", unitOfMeasure: "kg", originProduct: null },
        ],
      },
    ],
    nextCursor: null,
  });
  s.getCard.mockRejectedValue(new UsClientError("session_required"));
  render(s.view());
  await s.user.click(await screen.findByRole("button", { name: /line 1/i }));
  expect(s.onOpenEvent).toHaveBeenCalledWith({
    type: "shipping",
    eventId,
    revision: 2,
    lineSide: "items",
    lineNo: 1,
  });
  expect(s.onSessionLost).toHaveBeenCalledOnce();
});
