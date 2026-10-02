import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import {
  usReadinessResultSchema,
  type UsReadinessQuery,
  type UsReadinessFinding,
  type UsReadinessResult,
} from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { UsClientError, type UsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReadinessView } from "../src/us/readiness/view.js";

const lotId = "10000000-0000-4000-8000-000000000001";
const productId = "20000000-0000-4000-8000-000000000001";
const eventId = "30000000-0000-4000-8000-000000000001";

function finding(overrides: Partial<UsReadinessFinding> = {}): UsReadinessFinding {
  return {
    key: "finding-1",
    ruleVersion: "us-readiness-v1",
    code: "required_kde",
    severity: "error",
    cte: "receiving",
    field: "tlcSource",
    message: { key: "readiness.required_kde", params: {} },
    lotId,
    productId,
    eventId,
    rootId: eventId,
    eventNumber: "REC-26-0001",
    revision: 2,
    eventDate: "2026-09-20",
    lineSide: "items",
    lineNo: 1,
    relatedEventId: null,
    relatedEvent: null,
    links: {
      lotHref: `/traceability/lots/${lotId}`,
      eventHref: `/traceability/events/${eventId}`,
      relatedEventHref: null,
    },
    ...overrides,
  };
}

function result(overrides: Partial<UsReadinessResult> = {}): UsReadinessResult {
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
    recordsChecked: { events: 3, lots: 2 },
    dependenciesChecked: 7,
    counts: { error: 0, warning: 0, info: 0 },
    groups: { byCte: [], byProduct: [], bySeverity: [] },
    findings: [],
    draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function setup(
  value: UsReadinessResult,
  locale: "en-US" | "es-US" = "en-US",
  overrideClient?: Partial<UsBrowserClient>,
  initialQuery: UsReadinessQuery = {},
) {
  usReadinessResultSchema.parse(value);
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const client = {
    readReadiness: vi.fn().mockResolvedValue(value),
    listProducts: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    listLots: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    getProduct: vi.fn().mockResolvedValue({ id: productId, name: "Selected product" }),
    getLot: vi.fn().mockResolvedValue({ id: lotId, tlc: "Selected TLC" }),
    ...overrideClient,
  } as unknown as UsBrowserClient;
  const onOpenLot = vi.fn();
  const onOpenEvent = vi.fn();
  const onOpenEvents = vi.fn();
  const onQueryChange = vi.fn();
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>
        <ReadinessView
          client={client}
          profileCode="US_GENERIC_LOT_TRACEABILITY"
          initialQuery={initialQuery}
          onQueryChange={onQueryChange}
          onForbidden={vi.fn()}
          onSessionLost={vi.fn()}
          onOpenLot={onOpenLot}
          onOpenEvent={onOpenEvent}
          onOpenEvents={onOpenEvents}
        />
      </I18nextProvider>
    </ThemeProvider>,
  );
  await screen.findByText(
    locale === "en-US"
      ? "General lot traceability only; FTR applicability is not assessed in this profile."
      : "Solo trazabilidad general de lotes; la aplicabilidad de FTR no se evalúa en este perfil.",
  );
  return { client, onOpenLot, onOpenEvent, onOpenEvents, onQueryChange };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("uses the server default, validates paired dates and resets to an empty query", async () => {
  const { client, onQueryChange } = await setup(result());
  await screen.findByText("Last 24 months · 2024-10-01 – 2026-09-28");
  expect(client.readReadiness).toHaveBeenCalledWith({});
  const from = screen.getByLabelText("Event date from");
  const to = screen.getByLabelText("Event date to");
  expect(from).toHaveProperty("type", "date");
  expect(to).toHaveProperty("type", "date");
  fireEvent.change(from, { target: { value: "2026-01-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(screen.getByRole("alert").textContent).toContain("Both event dates");
  expect(onQueryChange).not.toHaveBeenCalled();
  fireEvent.change(to, { target: { value: "2025-12-31" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(screen.getByRole("alert").textContent).toContain("on or after");
  expect(onQueryChange).not.toHaveBeenCalled();
  fireEvent.change(from, { target: { value: "2023-01-01" } });
  fireEvent.change(to, { target: { value: "2025-01-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(screen.getByRole("alert").textContent).toContain("24 months");
  expect(onQueryChange).not.toHaveBeenCalled();
  fireEvent.change(from, { target: { value: "2025-01-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(onQueryChange).toHaveBeenLastCalledWith({
    eventDateFrom: "2025-01-01",
    eventDateTo: "2025-01-01",
  });
  await userEvent.click(screen.getByRole("button", { name: "Reset scope" }));
  expect(onQueryChange).toHaveBeenLastCalledWith({});
  expect(client.readReadiness).toHaveBeenLastCalledWith({});
});

it("searches bounded product and lot lists and applies independent selected IDs", async () => {
  const selected = result({
    scope: {
      eventDateFrom: "2024-10-01",
      eventDateTo: "2026-09-28",
      productId,
      lotId,
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      defaulted: true,
    },
    state: "empty",
    recordsChecked: { events: 0, lots: 0 },
  });
  const { client, onQueryChange } = await setup(selected, "en-US", {
    listProducts: vi.fn().mockResolvedValue({
      items: [{ id: productId, name: "Apples", gtin14: null }],
      limit: 50,
      offset: 0,
    }),
    listLots: vi.fn().mockResolvedValue({
      items: [{ id: lotId, tlc: "TLC-42", productId: "different-product" }],
      limit: 50,
      offset: 0,
    }),
  });
  await userEvent.type(screen.getByLabelText("Search products"), "Apple");
  await userEvent.click(screen.getByRole("button", { name: "Search products" }));
  await waitFor(() =>
    expect(client.listProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "Apple",
        limit: 50,
        offset: 0,
      }),
    ),
  );
  await userEvent.selectOptions(screen.getByLabelText("Product"), productId);
  await userEvent.type(screen.getByLabelText("Search lots"), "TLC-42");
  await userEvent.click(screen.getByRole("button", { name: "Search lots" }));
  await waitFor(() =>
    expect(client.listLots).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "TLC-42",
        limit: 50,
        offset: 0,
      }),
    ),
  );
  expect(client.listLots).not.toHaveBeenCalledWith(expect.objectContaining({ productId }));
  await userEvent.selectOptions(screen.getByLabelText("Lot"), lotId);
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(onQueryChange).toHaveBeenCalledWith({ productId, lotId });
  expect(screen.getByText("Nothing to check yet")).toBeTruthy();
  expect(screen.getByText(/Apples/)).toBeTruthy();
  expect(screen.getByText(/TLC-42/)).toBeTruthy();
});

it("keeps an older response from overwriting a newer applied scope", async () => {
  const first = deferred<UsReadinessResult>();
  const second = deferred<UsReadinessResult>();
  const client = {
    readReadiness: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  };
  const { onQueryChange } = await setup(result(), "en-US", client);
  fireEvent.change(screen.getByLabelText("Event date from"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Event date to"), { target: { value: "2026-09-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(onQueryChange).toHaveBeenCalledWith({
    eventDateFrom: "2026-01-01",
    eventDateTo: "2026-09-01",
  });
  await act(async () =>
    second.resolve(
      result({
        scope: {
          ...result().scope,
          eventDateFrom: "2026-01-01",
          eventDateTo: "2026-09-01",
          defaulted: false,
        },
        recordsChecked: { events: 9, lots: 1 },
      }),
    ),
  );
  expect(screen.getByText("2026-01-01 – 2026-09-01")).toBeTruthy();
  await act(async () => first.resolve(result()));
  expect(screen.getByText("2026-01-01 – 2026-09-01")).toBeTruthy();
  expect(screen.queryByText("Last 24 months · 2024-10-01 – 2026-09-28")).toBeNull();
  expect(screen.getByText("9", { selector: "dd" })).toBeTruthy();
});

it("does not let an older response clear a newer request error", async () => {
  const first = deferred<UsReadinessResult>();
  const second = deferred<UsReadinessResult>();
  await setup(result(), "en-US", {
    readReadiness: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  });
  fireEvent.change(screen.getByLabelText("Event date from"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Event date to"), { target: { value: "2026-09-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  await act(async () => second.reject(new UsClientError("readiness_scope_not_found")));
  expect(screen.getByRole("alert").textContent).toContain(
    "selected product or lot could not be found",
  );
  await act(async () => first.resolve(result()));
  expect(screen.getByRole("alert").textContent).toContain(
    "selected product or lot could not be found",
  );
  expect(screen.queryByText("Last 24 months · 2024-10-01 – 2026-09-28")).toBeNull();
});

it("labels a previous result while refreshing and distinguishes server errors", async () => {
  const pending = deferred<UsReadinessResult>();
  const { client } = await setup(result());
  await screen.findByText("Last 24 months · 2024-10-01 – 2026-09-28");
  vi.mocked(client.readReadiness).mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText("Event date from"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Event date to"), { target: { value: "2026-09-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Check scope" }));
  expect(screen.getByText("Refreshing…")).toBeTruthy();
  expect(screen.getByText("Previous successful scope")).toBeTruthy();
  expect(screen.getByText("Last 24 months · 2024-10-01 – 2026-09-28")).toBeTruthy();
  await act(async () => pending.reject(new UsClientError("readiness_scope_too_large")));
  expect(screen.getByRole("alert").textContent).toContain(
    "Narrow the selected scope and try again",
  );
  expect(screen.getByText("Previous successful scope")).toBeTruthy();
  vi.mocked(client.readReadiness).mockRejectedValueOnce(
    new UsClientError("readiness_scope_not_found"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "selected product or lot could not be found",
    ),
  );
});

it("distinguishes an empty scope from assessed records with no findings", async () => {
  const empty = result({
    state: "empty",
    recordsChecked: { events: 0, lots: 0 },
    dependenciesChecked: 0,
  });
  await setup(empty);
  expect(screen.getByText("Nothing to check yet")).toBeTruthy();
  expect(screen.queryByText("No findings in the displayed scope.")).toBeNull();
  expect(screen.queryByText(/compliant|score|%/i)).toBeNull();
  cleanup();
  await setup(result());
  expect(screen.getByText("No findings in the displayed scope.")).toBeTruthy();
  expect(screen.getByText("Last 24 months · 2024-10-01 – 2026-09-28")).toBeTruthy();
  expect(screen.getByText("7 older origins checked as dependencies")).toBeTruthy();
  expect(screen.getByText("3", { selector: "dd" })).toBeTruthy();
  expect(screen.getByText("2", { selector: "dd" })).toBeTruthy();
});

it("renders exact event-wide, non-FTL input, and lot-only provenance with server groups", async () => {
  const eventWide = finding({
    lotId: null,
    lineSide: null,
    lineNo: null,
    links: { lotHref: null, eventHref: `/traceability/events/${eventId}`, relatedEventHref: null },
  });
  const input = finding({
    key: "finding-2",
    cte: "transformation",
    eventNumber: "TRN-26-0002",
    code: "invalid_quantity",
    field: "inputs.2.quantity",
    lotId: null,
    lineSide: "inputs",
    lineNo: 2,
    links: { lotHref: null, eventHref: `/traceability/events/${eventId}`, relatedEventHref: null },
  });
  const lotOnly = finding({
    key: "finding-3",
    code: "origin_gap",
    eventId: null,
    rootId: null,
    eventNumber: null,
    revision: null,
    eventDate: null,
    cte: null,
    lineSide: null,
    lineNo: null,
    links: { lotHref: `/traceability/lots/${lotId}`, eventHref: null, relatedEventHref: null },
  });
  const { onOpenEvent, onOpenLot } = await setup(
    result({
      counts: { error: 3, warning: 0, info: 0 },
      groups: {
        byCte: [
          { cte: "receiving", count: 1 },
          { cte: "transformation", count: 1 },
          { cte: null, count: 1 },
        ],
        byProduct: [{ productId, count: 3 }],
        bySeverity: [{ severity: "error", count: 3 }],
      },
      findings: [eventWide, input, lotOnly],
    }),
  );
  expect(screen.getAllByText("Error").length).toBeGreaterThanOrEqual(3);
  expect(screen.getByText("Receiving · 1")).toBeTruthy();
  expect(screen.getByText("Transformation · 1")).toBeTruthy();
  expect(screen.getByText("Lot only · 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: /REC-26-0001.*rev 2/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /TRN-26-0002.*rev 2.*input 2/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Open lot/i })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /TRN-26-0002.*rev 2.*input 2/i }));
  expect(onOpenEvent).toHaveBeenCalledWith({
    type: "transformation",
    eventId,
    revision: 2,
    lineSide: "inputs",
    lineNo: 2,
  });
  await userEvent.click(screen.getByRole("button", { name: /Open lot/i }));
  expect(onOpenLot).toHaveBeenCalledWith(lotId);
  await userEvent.selectOptions(screen.getByLabelText("Group by"), "product");
  expect(screen.getByText(`${productId} · 3`)).toBeTruthy();
  await userEvent.selectOptions(screen.getByLabelText("Group by"), "severity");
  expect(screen.getByText("Error · 3")).toBeTruthy();
});

it.each(["en-US", "es-US"] as const)(
  "opens a retained lot and its exact void-origin revision in %s without using server href",
  async (locale) => {
    const historicalId = "40000000-0000-4000-8000-000000000001";
    const gap = finding({
      code: "origin_gap",
      cte: null,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      relatedEventId: historicalId,
      relatedEvent: { type: "transformation", eventNumber: "TRN-26-0007", revision: 3 },
      links: {
        lotHref: `/traceability/lots/${lotId}`,
        eventHref: null,
        relatedEventHref: "/traceability/do-not-follow",
      },
    });
    const { onOpenEvent, onOpenLot } = await setup(
      result({
        recordsChecked: { events: 0, lots: 1 },
        counts: { error: 1, warning: 0, info: 0 },
        groups: {
          byCte: [{ cte: null, count: 1 }],
          byProduct: [{ productId, count: 1 }],
          bySeverity: [{ severity: "error", count: 1 }],
        },
        findings: [gap],
      }),
      locale,
    );
    await userEvent.click(screen.getByRole("button", { name: /TRN-26-0007.*(?:rev|revisi)/i }));
    expect(onOpenEvent).toHaveBeenCalledWith({
      type: "transformation",
      eventId: historicalId,
      revision: 3,
      lineSide: null,
      lineNo: null,
    });
    await userEvent.click(screen.getByRole("button", { name: /(?:Open lot|Abrir lote)/i }));
    expect(onOpenLot).toHaveBeenCalledWith(lotId);
  },
);

it("keeps draft work separate and localizes unknown rules in Spanish", async () => {
  const unknown = finding({
    code: "future_rule",
    field: "source.futureField",
    message: { key: "readiness.future_rule", params: {} },
  });
  const { onOpenEvents } = await setup(
    result({
      counts: { error: 1, warning: 0, info: 0 },
      groups: {
        byCte: [{ cte: "receiving", count: 1 }],
        byProduct: [{ productId, count: 1 }],
        bySeverity: [{ severity: "error", count: 1 }],
      },
      findings: [unknown],
      draftWork: {
        total: 4,
        items: [
          {
            eventId,
            rootId: eventId,
            cte: "receiving",
            eventNumber: "REC-DRAFT",
            revision: 1,
            eventDate: null,
            eventHref: `/traceability/events/${eventId}`,
            readinessHref: `/traceability/events/${eventId}/readiness`,
          },
        ],
        hasMore: true,
        eventsHref: "/traceability/events",
      },
    }),
    "es-US",
  );
  expect(screen.getByText(/Revise el registro de origen/)).toBeTruthy();
  expect(screen.getByText(/future_rule · source.futureField/)).toBeTruthy();
  const drafts = screen.getByRole("region", { name: "Trabajo en borrador" });
  expect(within(drafts).getByText("1 de 4 mostrados")).toBeTruthy();
  await userEvent.click(within(drafts).getByRole("button", { name: "Ver eventos" }));
  expect(onOpenEvents).toHaveBeenCalledOnce();
  expect(screen.queryByText("readiness.future_rule")).toBeNull();
  expect(screen.queryByText(/undefined/i)).toBeNull();
});

it("uses an English source-review fallback without leaking message keys", async () => {
  const unknown = finding({
    code: "future_rule",
    field: "source.futureField",
    message: { key: "readiness.future_rule", params: {} },
  });
  await setup(
    result({
      counts: { error: 1, warning: 0, info: 0 },
      groups: {
        byCte: [{ cte: "receiving", count: 1 }],
        byProduct: [{ productId, count: 1 }],
        bySeverity: [{ severity: "error", count: 1 }],
      },
      findings: [unknown],
    }),
  );
  expect(screen.getByText(/Review source record/)).toBeTruthy();
  expect(screen.getByText(/future_rule · source.futureField/)).toBeTruthy();
  expect(screen.queryByText(/undefined|readiness.future_rule/i)).toBeNull();
});

it("keeps nonzero warning and info counts independent from draft work", async () => {
  const findings = [
    finding({ key: "finding-1" }),
    finding({ key: "finding-2", severity: "warning", code: "invalid_uom" }),
    finding({ key: "finding-3", severity: "info", code: "coverage_unresolved" }),
  ];
  await setup(
    result({
      counts: { error: 1, warning: 1, info: 1 },
      groups: {
        byCte: [{ cte: "receiving", count: 3 }],
        byProduct: [{ productId, count: 3 }],
        bySeverity: [
          { severity: "error", count: 1 },
          { severity: "warning", count: 1 },
          { severity: "info", count: 1 },
        ],
      },
      findings,
      draftWork: {
        total: 3,
        items: [
          {
            eventId,
            rootId: eventId,
            cte: "receiving",
            eventNumber: "REC-DRAFT",
            revision: 1,
            eventDate: null,
            eventHref: `/traceability/events/${eventId}`,
            readinessHref: `/traceability/events/${eventId}/readiness`,
          },
        ],
        hasMore: true,
        eventsHref: "/traceability/events",
      },
    }),
  );
  expect(screen.getByText("Errors").nextElementSibling?.textContent).toBe("1");
  expect(screen.getByText("Warnings").nextElementSibling?.textContent).toBe("1");
  expect(screen.getByText("Infos").nextElementSibling?.textContent).toBe("1");
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(within(screen.getByRole("table")).queryByText(/REC-DRAFT/)).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Draft work" })).getByText("1 of 3 shown"),
  ).toBeTruthy();
});

it("shows draft-only work separately when assessed records have zero findings", async () => {
  await setup(
    result({
      recordsChecked: { events: 1, lots: 0 },
      draftWork: {
        total: 1,
        items: [
          {
            eventId,
            rootId: eventId,
            cte: "receiving",
            eventNumber: "REC-DRAFT",
            revision: 1,
            eventDate: null,
            eventHref: `/traceability/events/${eventId}`,
            readinessHref: `/traceability/events/${eventId}/readiness`,
          },
        ],
        hasMore: false,
        eventsHref: "/traceability/events",
      },
    }),
  );
  expect(screen.getByText("No findings in the displayed scope.")).toBeTruthy();
  expect(screen.getByText("Errors").nextElementSibling?.textContent).toBe("0");
  expect(screen.getByText("Warnings").nextElementSibling?.textContent).toBe("0");
  expect(screen.getByText("Infos").nextElementSibling?.textContent).toBe("0");
  expect(screen.queryByRole("table")).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Draft work" })).getByText("1 of 1 shown"),
  ).toBeTruthy();
});

it("renders at most 100 rows for a valid 10,000-finding response and pages locally", async () => {
  const findings = Array.from({ length: 10000 }, (_, index) =>
    finding({
      key: `finding-${String(index).padStart(5, "0")}`,
      eventNumber: `REC-${String(index).padStart(5, "0")}`,
    }),
  );
  await setup(
    result({
      counts: { error: 10000, warning: 0, info: 0 },
      groups: {
        byCte: [{ cte: "receiving", count: 10000 }],
        byProduct: [{ productId, count: 10000 }],
        bySeverity: [{ severity: "error", count: 10000 }],
      },
      findings,
    }),
  );
  expect(screen.getAllByRole("row")).toHaveLength(101);
  expect(screen.getByText("Findings 1–100 of 10000")).toBeTruthy();
  expect(screen.getByText("Receiving · 10000")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getAllByRole("row")).toHaveLength(101);
  expect(screen.getByText("Findings 101–200 of 10000")).toBeTruthy();
  expect(screen.getByText("Receiving · 10000")).toBeTruthy();
  expect(screen.getByRole("button", { name: /REC-00100/ })).toBeTruthy();
});

it("shows at most 100 of 10,000 valid product groups and pages group totals independently", async () => {
  const ids = Array.from(
    { length: 10000 },
    (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`,
  );
  const findings = ids.map((id, index) =>
    finding({ key: `finding-${String(index).padStart(5, "0")}`, productId: id }),
  );
  await setup(
    result({
      counts: { error: 10000, warning: 0, info: 0 },
      groups: {
        byCte: [{ cte: "receiving", count: 10000 }],
        byProduct: ids.map((id) => ({ productId: id, count: 1 })),
        bySeverity: [{ severity: "error", count: 10000 }],
      },
      findings,
    }),
  );
  await userEvent.selectOptions(screen.getByLabelText("Group by"), "product");
  const groups = screen.getByRole("group", { name: "Finding groups" });
  expect(groups.children).toHaveLength(100);
  expect(screen.getByText("Groups 1–100 of 10000")).toBeTruthy();
  expect(within(groups).getByText(`${ids[0]} · 1`)).toBeTruthy();
  expect(within(groups).queryByText(`${ids[100]} · 1`)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Next groups" }));
  expect(groups.children).toHaveLength(100);
  expect(screen.getByText("Groups 101–200 of 10000")).toBeTruthy();
  expect(within(groups).getByText(`${ids[100]} · 1`)).toBeTruthy();
  expect(screen.getByText("Findings 1–100 of 10000")).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(101);
});
