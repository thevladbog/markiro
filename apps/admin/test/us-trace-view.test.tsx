import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type { UsCurrentTraceResult, UsTraceHistoryPage } from "@markiro/platform-contracts";
import { useState } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsClientError } from "../src/us/client.js";
import { TraceView, type TraceEntry } from "../src/us/trace/view.js";

const id = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
function result(count = 1): UsCurrentTraceResult {
  return {
    rootLotId: id,
    direction: "both",
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `lot:10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      kind: "lot",
      lotId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      tlc: `LOT-${i}`,
    })),
    edges: [],
    currentEvents: [],
    findings: [],
    excludedSummary: { count: 3 },
    completion: { state: "complete", returnedNodes: count, returnedEdges: 0 },
  };
}
async function setup(
  initial: TraceEntry | null = { lotId: id, direction: "both" },
  locale = "en-US",
) {
  const instance = i18next.createInstance();
  await instance.init({ lng: locale, initAsync: false, resources: {} });
  const client = createUsBrowserClient();
  const read = vi.spyOn(client, "readCurrentTrace").mockResolvedValue(result());
  const history = vi
    .spyOn(client, "listTraceHistory")
    .mockResolvedValue({ items: [], nextCursor: null });
  const search = vi.spyOn(client, "searchTraceLots").mockResolvedValue({
    items: [
      {
        lotId: id,
        tlc: "NRF-260915",
        productId: other,
        source: { kind: "location", locationId: other },
        status: "active",
        matchedBy: ["tlc"],
        currentCteCount: 0,
        firstEventDate: null,
        lastEventDate: null,
        ssccLinks: [],
        moreCaseHistory: false,
      },
    ],
    nextCursor: null,
    appliedFilters: { limit: 50, tlcList: null },
    rangeOrder: "lexical_c",
  });
  const onOpenEvent = vi.fn();
  const onForbidden = vi.fn(async () => {});
  const onSessionLost = vi.fn();
  function Harness() {
    const [entry, setEntry] = useState(initial);
    return (
      <>
        <button onClick={() => setEntry(null)}>Sidebar Trace</button>
        <button onClick={() => setEntry({ lotId: other, direction: "backward" })}>Other lot</button>
        <TraceView
          client={client}
          entry={entry}
          onEntryChange={setEntry}
          onOpenLot={vi.fn()}
          onOpenEvent={onOpenEvent}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
        />
      </>
    );
  }
  return {
    client,
    read,
    history,
    search,
    onOpenEvent,
    onForbidden,
    onSessionLost,
    mount: () =>
      render(
        <ThemeProvider defaultTheme="light">
          <I18nextProvider i18n={instance}>
            <Harness />
          </I18nextProvider>
        </ThemeProvider>,
      ),
    user: userEvent.setup(),
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("requires bounded explicit lot search and selection, and resets on sidebar entry", async () => {
  const { mount, read, search, user } = await setup(null);
  mount();
  expect(read).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Search lots"), "NRF-260915");
  await user.click(screen.getByRole("button", { name: "Search lots" }));
  expect(search).toHaveBeenCalledWith({ q: "NRF-260915", limit: "50" });
  await user.selectOptions(screen.getByLabelText("Lot"), id);
  await screen.findByRole("img");
  expect(read).toHaveBeenCalledExactlyOnceWith(id, { direction: "both", maxDepth: "16" });
  await user.click(screen.getByRole("button", { name: "Sidebar Trace" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

it("shares one response across tabs and shows no-current-chain without an error", async () => {
  const { mount, read, user } = await setup();
  mount();
  await screen.findByRole("img");
  expect(screen.getByText("No current chain yet.")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Table" }));
  expect(screen.getByRole("table")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("defaults above 50 nodes to Table and retains limited counts and origin gap on both tabs", async () => {
  const { mount, read, user } = await setup();
  read.mockResolvedValue({
    ...result(51),
    completion: { state: "limited", limit: "nodes", returnedNodes: 51, returnedEdges: 0 },
    findings: [{ code: "origin_gap", lotId: id }],
  });
  mount();
  await screen.findByRole("table");
  expect(screen.getByRole("tab", { name: "Table" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("51 nodes, 0 edges");
  expect(screen.getByText(/Origin gap/).textContent).toContain(id);
  await user.click(screen.getByRole("tab", { name: "Graph" }));
  expect(screen.getByRole("alert").textContent).toContain("nodes");
  expect(read).toHaveBeenCalledTimes(1);
});

it("invalidates direction and depth reads, including late failures", async () => {
  const { mount, read, user, onSessionLost } = await setup();
  let rejectOld: (reason: unknown) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
  );
  mount();
  await user.selectOptions(screen.getByLabelText("Direction"), "forward");
  await screen.findByRole("img");
  await user.selectOptions(screen.getByLabelText("Maximum depth"), "0");
  expect(read).toHaveBeenLastCalledWith(id, { direction: "forward", maxDepth: "0" });
  await act(async () => rejectOld(new UsClientError("session_required")));
  expect(onSessionLost).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getAllByRole("option").some((option) => option.getAttribute("value") === "21"),
  ).toBe(false);
});

it("shows unavailable as retryable failure with no success graph", async () => {
  const { mount, read, user } = await setup();
  read.mockRejectedValueOnce(new UsClientError("unavailable"));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("img")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry trace" }));
  await screen.findByRole("img");
  expect(read).toHaveBeenCalledTimes(2);
});

it("pages excluded history independently and opens exact historical revisions", async () => {
  const { mount, history, read, user, onOpenEvent } = await setup();
  const item: UsTraceHistoryPage["items"][number] = {
    eventId: other,
    rootId: id,
    type: "shipping",
    eventNumber: "OLD-1",
    revision: 3,
    status: "void",
    reason: "Corrected",
    previousRevisionId: id,
    nextRevisionId: null,
    eventDate: "2026-09-15",
    createdAt: "2026-09-15T12:00:00Z",
  };
  history
    .mockResolvedValueOnce({ items: [item], nextCursor: "next-page" })
    .mockResolvedValueOnce({ items: [], nextCursor: null })
    .mockResolvedValueOnce({ items: [item], nextCursor: "next-page" });
  mount();
  const section = await screen.findByRole("region", { name: "Excluded history" });
  await screen.findByRole("button", { name: /OLD-1/ });
  expect(section.textContent).toContain("Corrected");
  expect(section.textContent).toContain(id);
  await user.click(within(section).getByRole("button", { name: /OLD-1/ }));
  expect(onOpenEvent).toHaveBeenCalledWith({
    type: "shipping",
    eventId: other,
    revision: 3,
    lineSide: null,
    lineNo: null,
  });
  await user.click(within(section).getByRole("button", { name: "Next" }));
  expect(history).toHaveBeenLastCalledWith(id, { limit: "50", cursor: "next-page" });
  await user.click(within(section).getByRole("button", { name: "Previous" }));
  expect(history).toHaveBeenLastCalledWith(id, { limit: "50" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Excluded in this trace scope: 3")).toBeTruthy();
});

it("provides Spanish controls and states", async () => {
  const { mount } = await setup(null, "es-US");
  mount();
  expect(screen.getByLabelText("Buscar lotes")).toBeTruthy();
  expect(screen.getByLabelText("Dirección")).toBeTruthy();
  expect(screen.getByText("Seleccione un lote para iniciar la trazabilidad.")).toBeTruthy();
});

it("accepts lots with no source in the bounded selector", async () => {
  const { mount, search, user } = await setup(null);
  const page = await search();
  search.mockResolvedValue({
    ...page,
    items: page.items.map((item) => ({ ...item, source: null })),
  });
  mount();
  await user.type(screen.getByLabelText("Search lots"), "NRF");
  await user.click(screen.getByRole("button", { name: "Search lots" }));
  expect(await screen.findByRole("option", { name: /Source missing/ })).toBeTruthy();
});

it("ignores successful old-scope results and resets history cursors for another lot", async () => {
  const { mount, read, history, user } = await setup();
  let resolveOld: (value: UsCurrentTraceResult) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  history.mockResolvedValueOnce({ items: [], nextCursor: "old-cursor" });
  mount();
  const section = await screen.findByRole("region", { name: "Excluded history" });
  await user.click(within(section).getByRole("button", { name: "Next" }));
  expect(history).toHaveBeenLastCalledWith(id, { limit: "50", cursor: "old-cursor" });
  await user.click(screen.getByRole("button", { name: "Other lot" }));
  await screen.findByRole("img");
  expect(read).toHaveBeenLastCalledWith(other, { direction: "backward", maxDepth: "16" });
  expect(history).toHaveBeenLastCalledWith(other, { limit: "50" });
  await act(async () => resolveOld(result(51)));
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "Current trace: 1 nodes, 0 edges",
  );
});

it("supports keyboard tab switching without fetching again", async () => {
  const { mount, read, user } = await setup();
  mount();
  await screen.findByRole("img");
  screen.getByRole("tab", { name: "Graph" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Table" }));
  expect(screen.getByRole("table")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
});

it.each(["session_required", "forbidden", "trace_lot_not_found"] as const)(
  "keeps %s distinct from a successful current trace",
  async (code) => {
    const { mount, read, onForbidden, onSessionLost } = await setup();
    read.mockRejectedValueOnce(new UsClientError(code));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      code === "session_required"
        ? "session has ended"
        : code === "forbidden"
          ? "Access is no longer available"
          : "Lot not found",
    );
    expect(onForbidden).toHaveBeenCalledTimes(code === "forbidden" ? 1 : 0);
    expect(onSessionLost).toHaveBeenCalledTimes(code === "session_required" ? 1 : 0);
    expect(screen.queryByRole("img")).toBeNull();
  },
);

it("keeps a history failure separate from the current trace and retries only history", async () => {
  const { mount, history, read, user } = await setup();
  history.mockRejectedValueOnce(new UsClientError("unavailable"));
  mount();
  await screen.findByRole("img");
  expect(screen.getByRole("alert").textContent).toContain("History unavailable");
  expect(screen.queryByText("No excluded history.")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry history" }));
  await screen.findByText("No excluded history.");
  expect(history).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "en-US",
    "invalid_input",
    "Check the trace or search input.",
    "Retry history",
    "No excluded history.",
  ],
  [
    "en-US",
    "trace_lot_not_found",
    "Lot not found or unavailable to this organization.",
    "Retry history",
    "No excluded history.",
  ],
  [
    "es-US",
    "invalid_input",
    "Revise los datos de trazabilidad o búsqueda.",
    "Reintentar historial",
    "Sin historial excluido.",
  ],
  [
    "es-US",
    "trace_lot_not_found",
    "Lote no encontrado o no disponible para esta organización.",
    "Reintentar historial",
    "Sin historial excluido.",
  ],
] as const)(
  "distinguishes %s history %s without retry or empty success",
  async (locale, code, message, retry, empty) => {
    const { mount, history, read } = await setup({ lotId: id, direction: "both" }, locale);
    history.mockRejectedValueOnce(new UsClientError(code));
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.queryByRole("button", { name: retry })).toBeNull();
    expect(screen.queryByText(empty)).toBeNull();
    expect(screen.getByRole("img")).toBeTruthy();
    expect(history).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it.each(["session_required", "forbidden"] as const)(
  "preserves history %s callbacks without offering retry",
  async (code) => {
    const { mount, history, onForbidden, onSessionLost } = await setup();
    history.mockRejectedValueOnce(new UsClientError(code));
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe(
      code === "forbidden" ? "Access is no longer available." : "Your session has ended.",
    );
    expect(onForbidden).toHaveBeenCalledTimes(code === "forbidden" ? 1 : 0);
    expect(onSessionLost).toHaveBeenCalledTimes(code === "session_required" ? 1 : 0);
    expect(screen.queryByRole("button", { name: "Retry history" })).toBeNull();
    expect(screen.queryByText("No excluded history.")).toBeNull();
  },
);

it("keeps search cursors with the applied lookup and resets them for a new lookup", async () => {
  const { mount, search, read, user } = await setup(null);
  const first = await search();
  search.mockClear();
  search.mockResolvedValueOnce({ ...first, nextCursor: "search-next" }).mockResolvedValue(first);
  mount();
  await user.type(screen.getByLabelText("Search lots"), "NRF");
  await user.click(screen.getByRole("button", { name: "Search lots" }));
  const pages = screen.getByRole("navigation", { name: "Lot search pages" });
  await user.click(within(pages).getByRole("button", { name: "Next" }));
  expect(search).toHaveBeenLastCalledWith({ q: "NRF", limit: "50", cursor: "search-next" });
  await user.clear(screen.getByLabelText("Search lots"));
  await user.type(screen.getByLabelText("Search lots"), "OTHER");
  await user.click(screen.getByRole("button", { name: "Search lots" }));
  expect(search).toHaveBeenLastCalledWith({ q: "OTHER", limit: "50" });
  expect(within(pages).getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(read).not.toHaveBeenCalled();
});
