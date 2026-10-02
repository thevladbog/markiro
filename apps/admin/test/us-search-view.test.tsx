import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type { UsTraceSearchPage } from "@markiro/platform-contracts";
import { useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsClientError } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { SearchView } from "../src/us/search/view.js";
import { emptySearchState, normalizeExactLookup } from "../src/us/search/filters.js";
import { searchCopy } from "../src/us/search/copy.js";
import { LotReferencePicker } from "../src/us/lots/reference-picker.js";

const lotId = "10000000-0000-4000-8000-000000000001";
const secondLotId = "10000000-0000-4000-8000-000000000002";
const productId = "20000000-0000-4000-8000-000000000001";
const locationId = "30000000-0000-4000-8000-000000000001";
const hit: UsTraceSearchPage["items"][number] = {
  lotId,
  productId,
  tlc: "NRF-260915-APL01",
  source: { kind: "location", locationId },
  status: "active",
  matchedBy: ["document_number"],
  currentCteCount: 2,
  firstEventDate: "2026-09-15",
  lastEventDate: "2026-09-16",
  ssccLinks: [],
  moreCaseHistory: false,
};
const page = (items = [hit], nextCursor: string | null = null): UsTraceSearchPage => ({
  items,
  nextCursor,
  appliedFilters: { q: "BOL-0916-H", tlcList: null, limit: 50 },
  rangeOrder: "lexical_c",
});
const forbidden = vi.fn(async () => {});
const sessionLost = vi.fn();
async function setup(locale: "en-US" | "es-US" = "en-US") {
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: locale,
    initAsync: false,
  });
  const client = createUsBrowserClient();
  vi.spyOn(client, "listProducts").mockResolvedValue({ items: [], limit: 50, offset: 0 });
  vi.spyOn(client, "listLocations").mockResolvedValue({ items: [], limit: 50, offset: 0 });
  vi.spyOn(client, "getProduct").mockRejectedValue(new Error("missing"));
  const search = vi.spyOn(client, "searchTraceLots").mockResolvedValue(page());
  const openLot = vi.fn();
  const stateChanged = vi.fn();
  function Harness() {
    const [state, setState] = useState(emptySearchState);
    return (
      <>
        <button onClick={() => setState({ ...emptySearchState })}>Reset from owner</button>
        <SearchView
          client={client}
          state={state}
          onStateChange={(next) => {
            stateChanged(next);
            setState(next);
          }}
          onOpenLot={openLot}
          onForbidden={forbidden}
          onSessionLost={sessionLost}
        />
      </>
    );
  }
  const wrap = (children: React.ReactNode) => (
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>{children}</I18nextProvider>
    </ThemeProvider>
  );
  render(wrap(<Harness />));
  return { client, search, openLot, stateChanged, wrap };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  ["en-US", "Lot ID", "Exact lookup", "Search"],
  ["es-US", "ID de lote", "Búsqueda exacta", "Buscar"],
] as const)(
  "uses exact lookup for lot UUIDs without a raw advanced input in %s",
  async (locale, idLabel, lookupLabel, submit) => {
    const { search } = await setup(locale);
    expect(screen.queryByRole("textbox", { name: idLabel })).toBeNull();
    await userEvent.type(screen.getByLabelText(lookupLabel), lotId);
    await userEvent.click(screen.getByRole("button", { name: submit }));
    await screen.findByText(hit.tlc);
    expect(search).toHaveBeenLastCalledWith({ q: lotId, limit: "50" });
    const result = screen.getByRole("article");
    expect(within(result).getByText(idLabel)).toBeTruthy();
    expect(within(result).getByText(lotId, { exact: true })).toBeTruthy();
  },
);

it("resets a no-hit search, cursor history, invalid draft and result state", async () => {
  const { search, stateChanged } = await setup();
  search.mockResolvedValueOnce(page([hit], "page2")).mockResolvedValueOnce(page([]));
  await userEvent.type(screen.getByLabelText("Exact lookup"), "missing");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText(hit.tlc);
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Search pages" })).getByRole("button", {
      name: "Next",
    }),
  );
  await screen.findByText("No lots match these filters.");
  await userEvent.type(screen.getByLabelText("Event date from"), "invalid");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(stateChanged).toHaveBeenLastCalledWith(emptySearchState);
  expect(screen.getByLabelText("Exact lookup")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Event date from")).toHaveProperty("value", "");
  expect(screen.queryByText("No lots match these filters.")).toBeNull();
  expect(screen.queryByText("Server applied filters")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Search pages" })).toBeNull();
  expect(search).toHaveBeenCalledTimes(2);
});

it("Reset invalidates an outstanding response and clears loading and failure state", async () => {
  const { search } = await setup();
  let finish: (value: UsTraceSearchPage) => void = () => {};
  search.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Loading search results…");
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByText("Loading search results…")).toBeNull();
  await act(async () => finish(page()));
  expect(screen.queryByText(hit.tlc)).toBeNull();
  expect(screen.queryByText("Server applied filters")).toBeNull();
  expect(search).toHaveBeenCalledTimes(2);
});

it.each([
  ["en-US", "Search", "Sep 15, 2026 – Sep 16, 2026"],
  ["es-US", "Buscar", "15 sept 2026 – 16 sept 2026"],
] as const)(
  "formats civil result dates in %s without shifting the date",
  async (locale, submit, dates) => {
    await setup(locale);
    await userEvent.click(screen.getByRole("button", { name: submit }));
    expect(await screen.findByText(dates)).toBeTruthy();
  },
);

it("clears loaded results when the state owner sets applied filters to null", async () => {
  const { search } = await setup();
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText(hit.tlc);
  await userEvent.click(screen.getByRole("button", { name: "Reset from owner" }));
  expect(screen.queryByText(hit.tlc)).toBeNull();
  expect(screen.queryByText("Server applied filters")).toBeNull();
  expect(search).toHaveBeenCalledTimes(1);
});

it.each([
  ["en-US", "Look up an exact TLC, lot ID, document number or SSCC.", "Reset"],
  ["es-US", "Busque un TLC, ID de lote, número de documento o SSCC exacto.", "Restablecer"],
] as const)(
  "explains exact lookup identities and provides localized reset in %s",
  async (locale, help, reset) => {
    const { search } = await setup(locale);
    expect(screen.getByText(help)).toBeTruthy();
    expect(screen.getByRole("button", { name: reset })).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  },
);

it("waits for submission and distinguishes equal TLCs by exact source and ID with historical Case evidence", async () => {
  const { search, openLot } = await setup();
  search.mockResolvedValue(
    page([
      hit,
      {
        ...hit,
        lotId: secondLotId,
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://north-river.example/lot-2",
          resolvedLocationId: locationId,
        },
        matchedBy: ["sscc_historical"],
        ssccLinks: [
          {
            linkId: lotId,
            boxId: secondLotId,
            ssccAtLink: "000123456789012343",
            state: "historical",
            provenance: "synthetic_demo",
            linkedAt: "2026-09-15T00:00:00Z",
            unlinkedAt: "2026-09-16T00:00:00Z",
            unlinkReason: "Incorrect assignment",
          },
        ],
      },
    ]),
  );
  expect(search).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Exact lookup"), "BOL-0916-H");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findAllByText("NRF-260915-APL01")).toHaveLength(2);
  expect(screen.getByText("Incorrect assignment")).toBeTruthy();
  expect(screen.getByText("Synthetic demo")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: new RegExp(secondLotId) }));
  expect(openLot).toHaveBeenCalledWith(secondLotId);
});

it("uses saved page cursors and clears the stack when filters are applied", async () => {
  const { search, stateChanged } = await setup();
  search
    .mockResolvedValueOnce(page([hit], "page2"))
    .mockResolvedValueOnce(page([hit], "page3"))
    .mockResolvedValueOnce(page())
    .mockResolvedValue(page());
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  const nav = () => screen.getByRole("navigation", { name: "Search pages" });
  await screen.findByRole("navigation", { name: "Search pages" });
  await userEvent.click(within(nav()).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(search).toHaveBeenLastCalledWith({ limit: "50", cursor: "page2" }));
  await userEvent.click(within(nav()).getByRole("button", { name: "Next" }));
  await waitFor(() => expect(search).toHaveBeenLastCalledWith({ limit: "50", cursor: "page3" }));
  await userEvent.click(within(nav()).getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(search).toHaveBeenLastCalledWith({ limit: "50", cursor: "page2" }));
  await userEvent.type(screen.getByLabelText("Exact lookup"), "new");
  expect(screen.getByText("Filters have changed. Apply Search to update results.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(stateChanged).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursors: [null], pageIndex: 0 }),
  );
  await waitFor(() => expect(search).toHaveBeenLastCalledWith({ q: "new", limit: "50" }));
});

it("ignores late responses from an older search", async () => {
  const { search } = await setup();
  let resolveOld: (value: UsTraceSearchPage) => void = () => {};
  search
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    )
    .mockResolvedValue(page([{ ...hit, tlc: "NEW" }]));
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.type(screen.getByLabelText("Exact lookup"), "new");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("NEW");
  await act(async () => resolveOld(page()));
  expect(screen.queryByText(hit.tlc)).toBeNull();
});

it.each([
  ["Event date from", "2026-02-30"],
  ["TLC range from", "Z"],
  ["TLC JSON list", '["A","A"]'],
])("rejects invalid %s before requesting", async (label, value) => {
  const { search } = await setup();
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.paste(value);
  if (label === "TLC range from") await userEvent.type(screen.getByLabelText("TLC range to"), "A");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(search).not.toHaveBeenCalled();
});

it("preserves exact non-SSCC values and normalizes valid wrappers", () => {
  expect(normalizeExactLookup(" BOL-0916-H ")).toBe("BOL-0916-H");
  expect(normalizeExactLookup("(00)000123456789012343")).toBe("000123456789012343");
  expect(normalizeExactLookup("(00)bad")).toBe("(00)bad");
  expect(Object.keys(searchCopy["en-US"]).sort()).toEqual(Object.keys(searchCopy["es-US"]).sort());
});

it.each(["product", "location"] as const)(
  "pages archived-inclusive %s references while create pickers stay active-only",
  async (kind) => {
    const { client, wrap } = await setup();
    cleanup();
    const reader = kind === "product" ? client.listProducts : client.listLocations;
    vi.mocked(reader).mockResolvedValue({
      items: Array.from({ length: 50 }, (_, i) => ({
        id: `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        name: `Name ${i}`,
        gtin14: null,
        archived: false,
        createdAt: "2026-09-28T00:00:00Z",
        updatedAt: "2026-09-28T00:00:00Z",
        partyId: locationId,
        descriptionStatus: { exportReady: false, issues: [] },
        roles: [],
        businessName: "Synthetic business",
        phoneNumber: null,
        addressKind: "street" as const,
        streetAddress: null,
        latitude: null,
        longitude: null,
        city: null,
        stateOrRegion: null,
        zipOrPostalCode: null,
        countryCode: null,
      })),
      limit: 50,
      offset: 0,
    });
    const props = {
      client,
      kind,
      label: "Reference",
      value: "",
      disabled: false,
      onChange: vi.fn(),
      onForbidden: forbidden,
      onSessionLost: sessionLost,
    };
    const mounted = render(wrap(<LotReferencePicker {...props} />));
    await waitFor(() =>
      expect(reader).toHaveBeenCalledWith(
        expect.objectContaining({ archived: "false", offset: 0 }),
      ),
    );
    mounted.rerender(wrap(<LotReferencePicker {...props} includeArchived />));
    await waitFor(() =>
      expect(reader).toHaveBeenLastCalledWith({
        archived: "all",
        search: "",
        limit: 50,
        offset: 0,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(reader).toHaveBeenLastCalledWith({
        archived: "all",
        search: "",
        limit: 50,
        offset: 50,
      }),
    );
  },
);

it("resolves each distinct product only once and labels names as current catalog data", async () => {
  const { client, search } = await setup();
  search.mockResolvedValue(page([hit, { ...hit, lotId: secondLotId }]));
  vi.mocked(client.getProduct).mockResolvedValue({
    id: productId,
    name: "Apple cups",
    gtin14: null,
    archived: true,
    createdAt: "2026-09-28T00:00:00Z",
    updatedAt: "2026-09-28T00:00:00Z",
  });
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findAllByText(/Apple cups · Current catalog data/)).toHaveLength(2);
  expect(client.getProduct).toHaveBeenCalledTimes(1);
  expect(client.getProduct).toHaveBeenCalledWith(productId);
  expect(
    within(screen.getByRole("navigation", { name: "Search pages" })).getByRole("button", {
      name: "Next",
    }),
  ).toHaveProperty("disabled", true);
});

it("retains filters after failure, retries and shows no hits", async () => {
  const { search } = await setup();
  search.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page([]));
  await userEvent.type(screen.getByLabelText("Exact lookup"), "saved");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Search could not be loaded. Your filters were kept.");
  expect(screen.getByLabelText("Exact lookup")).toHaveProperty("value", "saved");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("No lots match these filters.");
  expect(search).toHaveBeenLastCalledWith({ q: "saved", limit: "50" });
});

it.each(["forbidden", "session_required"] as const)(
  "propagates %s without exposing error details",
  async (code) => {
    const { search } = await setup();
    forbidden.mockClear();
    sessionLost.mockClear();
    search.mockRejectedValue(new UsClientError(code));
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(code === "forbidden" ? forbidden : sessionLost).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText(code)).toBeNull();
  },
);
