import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { usCurrentTraceResultSchema, type UsCurrentTraceResult } from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { TraceGraph } from "../src/us/trace/graph.js";
import { TraceTable } from "../src/us/trace/table.js";
import {
  edgeTarget,
  historyTarget,
  initialTraceTab,
  traceRows,
} from "../src/us/trace/projection.js";

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lot = (n: number): UsCurrentTraceResult["nodes"][number] => ({
  id: `lot:${uuid(n)}`,
  kind: "lot",
  lotId: uuid(n),
  tlc: `LOT-${n}`,
});
const event = (n: number, type: "receiving" | "transformation" | "shipping") => ({
  id: uuid(n),
  rootId: uuid(n + 100),
  type,
  eventNumber: `EVENT-${n}`,
  revision: 2,
  eventDate: "2026-09-15",
  timeZone: "America/Los_Angeles",
});
function fixture(material = false): UsCurrentTraceResult {
  const transformation = event(20, "transformation");
  const receiving = event(21, "receiving");
  const shipping = event(22, "shipping");
  const edge = (
    e: ReturnType<typeof event>,
    kind: UsCurrentTraceResult["edges"][number]["kind"],
    from: string,
    to: string,
    lineNo: number,
    quantity: string,
  ) => ({
    id: `${e.id}:${kind === "transformation_input" ? "input" : kind === "transformation_output" ? "output" : kind}:${lineNo}`,
    kind,
    from,
    to,
    eventId: e.id,
    eventNumber: e.eventNumber,
    revision: e.revision,
    eventDate: e.eventDate,
    timeZone: e.timeZone,
    lineNo,
    quantity,
    unitOfMeasure: "kg",
    ...(kind === "receiving" || kind === "shipping"
      ? { locationDisplay: kind === "receiving" ? "Supplier" : "Customer" }
      : {}),
  });
  const edges = [
    edge(receiving, "receiving", `location:${uuid(30)}`, `lot:${uuid(1)}`, 1, "12.500"),
    edge(
      transformation,
      "transformation_input",
      `lot:${uuid(1)}`,
      `transformation:${uuid(20)}`,
      1,
      "10",
    ),
    edge(
      transformation,
      "transformation_input",
      material ? `material:${uuid(20)}:2` : `lot:${uuid(2)}`,
      `transformation:${uuid(20)}`,
      2,
      "20",
    ),
    edge(
      transformation,
      "transformation_output",
      `transformation:${uuid(20)}`,
      `lot:${uuid(3)}`,
      1,
      "11",
    ),
    edge(
      transformation,
      "transformation_output",
      `transformation:${uuid(20)}`,
      `lot:${uuid(4)}`,
      2,
      "19",
    ),
    edge(shipping, "shipping", `lot:${uuid(4)}`, `location:${uuid(31)}`, 1, "7"),
  ];
  return usCurrentTraceResultSchema.parse({
    rootLotId: uuid(1),
    direction: "both",
    nodes: [
      lot(1),
      material
        ? {
            id: `material:${uuid(20)}:2`,
            kind: "material",
            eventId: uuid(20),
            lineNo: 2,
            display: "Non-FTL salt",
          }
        : lot(2),
      lot(3),
      lot(4),
      {
        id: `transformation:${uuid(20)}`,
        kind: "transformation",
        eventId: uuid(20),
        display: "EVENT-20",
      },
      {
        id: `location:${uuid(30)}`,
        kind: "location",
        locationId: uuid(30),
        display: "Supplier",
        displayEdgeId: edges[0]?.id,
      },
      {
        id: `location:${uuid(31)}`,
        kind: "location",
        locationId: uuid(31),
        display: "Customer",
        displayEdgeId: edges[5]?.id,
      },
    ],
    edges,
    currentEvents: [receiving, transformation, shipping],
    excludedSummary: { count: 2 },
    findings: [],
    completion: { state: "complete", returnedNodes: 7, returnedEdges: 6 },
  });
}
async function setup(
  Component: typeof TraceGraph | typeof TraceTable,
  result = fixture(),
  language = "en-US",
) {
  const instance = i18next.createInstance();
  await instance.init({ lng: language, resources: {}, initAsync: false });
  const onOpenLot = vi.fn();
  const onOpenEvent = vi.fn();
  const rendered = render(
    <I18nextProvider i18n={instance}>
      <ThemeProvider>
        <Component result={result} onOpenLot={onOpenLot} onOpenEvent={onOpenEvent} />
      </ThemeProvider>
    </I18nextProvider>,
  );
  return { ...rendered, onOpenLot, onOpenEvent, user: userEvent.setup() };
}
afterEach(cleanup);

it("separates quantities globally across distinct pairs in a two-transformation branch", async () => {
  const first = event(20, "transformation");
  const second = event(23, "transformation");
  const edge = (
    e: ReturnType<typeof event>,
    kind: "transformation_input" | "transformation_output",
    quantity: string,
  ) => ({
    id: `${e.id}:${kind === "transformation_input" ? "input" : "output"}:1`,
    kind,
    from: kind === "transformation_input" ? `lot:${uuid(1)}` : `transformation:${e.id}`,
    to: kind === "transformation_input" ? `transformation:${e.id}` : `lot:${uuid(2)}`,
    eventId: e.id,
    eventNumber: e.eventNumber,
    revision: e.revision,
    lineNo: 1,
    eventDate: e.eventDate,
    timeZone: e.timeZone,
    quantity,
    unitOfMeasure: "kg",
  });
  const result = usCurrentTraceResultSchema.parse({
    rootLotId: uuid(1),
    direction: "both",
    nodes: [
      lot(1),
      lot(2),
      ...[first, second].map((item) => ({
        id: `transformation:${item.id}`,
        kind: "transformation",
        eventId: item.id,
        display: item.eventNumber,
      })),
    ],
    edges: [
      edge(first, "transformation_input", "10"),
      edge(first, "transformation_output", "9"),
      edge(second, "transformation_input", "5"),
    ],
    currentEvents: [first, second],
    excludedSummary: { count: 0 },
    findings: [],
    completion: { state: "complete", returnedNodes: 4, returnedEdges: 3 },
  });
  const { unmount } = await setup(TraceGraph, result);
  function geometry() {
    const graph = screen.getByRole("img");
    return result.edges.map((item) => {
      const label = graph.querySelector(`[data-label-edge-id="${item.id}"]`);
      const path = graph.querySelector(`[data-edge-id="${item.id}"] path`);
      if (!label || !path) throw new Error("Missing branch edge");
      return {
        id: item.id,
        x: Number(label.getAttribute("x")),
        y: Number(label.getAttribute("y")),
        text: label.textContent,
        path: path.getAttribute("d"),
      };
    });
  }
  const before = geometry();
  // Branches must not visually merge into the same vertical trunk below the source.
  expect(new Set(before.map((item) => item.path?.match(/H([^ ]+) V/)?.[1])).size).toBe(3);
  for (const [index, label] of before.entries()) {
    for (const other of before.slice(index + 1)) {
      expect(Math.abs(label.y - other.y)).toBeGreaterThanOrEqual(24);
    }
  }
  expect(before.map((item) => item.text)).toEqual(["10 kg", "9 kg", "5 kg"]);
  expect(screen.getByRole("img").querySelectorAll("[data-edge-id]")).toHaveLength(3);
  unmount();
  await setup(TraceGraph, structuredClone(result));
  expect(geometry()).toEqual(before);
});

it.each(["receiving", "shipping", "transformation_input", "transformation_output"] as const)(
  "separates parallel %s paths and quantities deterministically without losing evidence",
  async (kind) => {
    const original = fixture();
    const edge = original.edges.find((item) => item.kind === kind);
    if (!edge) throw new Error("Missing fixture edge");
    const side =
      kind === "transformation_input"
        ? "input"
        : kind === "transformation_output"
          ? "output"
          : kind;
    const extras = [3, 4].map((lineNo) => ({
      ...edge,
      id: `${edge.eventId}:${side}:${lineNo}`,
      lineNo,
      quantity: lineNo === 3 ? "20" : "999999999999999999.123",
    }));
    const result = usCurrentTraceResultSchema.parse({
      ...original,
      edges: [...original.edges, ...extras],
      completion: { ...original.completion, returnedEdges: 8 },
    });
    const expectedIds = [edge.id, ...extras.map((item) => item.id)];
    function geometry() {
      const graph = screen.getByRole("img");
      return expectedIds.map((id) => {
        const rendered = graph.querySelector(`[data-edge-id="${id}"]`);
        const label = graph.querySelector(`[data-label-edge-id="${id}"]`);
        if (!rendered || !label) throw new Error("Missing parallel edge");
        const lastPath = [...graph.querySelectorAll(".us-trace-edge path")].at(-1);
        if (!lastPath) throw new Error("Missing edge paths");
        expect(
          label.compareDocumentPosition(lastPath) & Node.DOCUMENT_POSITION_PRECEDING,
        ).toBeTruthy();
        const y = Number(label.getAttribute("y"));
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(Number(graph.getAttribute("height")));
        return {
          id,
          path: rendered.querySelector("path")?.getAttribute("d"),
          x: label.getAttribute("x"),
          y,
          text: label.textContent,
        };
      });
    }
    const { unmount } = await setup(TraceGraph, result);
    const first = geometry();
    expect(new Set(first.map((item) => item.path)).size).toBe(3);
    for (let i = 1; i < first.length; i++) {
      expect(Math.abs((first[i]?.y ?? 0) - (first[i - 1]?.y ?? 0))).toBeGreaterThanOrEqual(24);
    }
    expect(first.map((item) => item.text)).toEqual([
      `${edge.quantity} kg`,
      "20 kg",
      "999999999999999999.123 kg",
    ]);
    expect(screen.getByRole("img").querySelectorAll("[data-edge-id]")).toHaveLength(8);
    unmount();
    await setup(TraceGraph, structuredClone(result));
    expect(geometry()).toEqual(first);
  },
);

it("separates opposite-direction input/output edges sharing the same lot and event", async () => {
  const original = fixture();
  const input = original.edges[1];
  if (!input) throw new Error("Missing input");
  const output = {
    ...input,
    id: `${input.eventId}:output:3`,
    kind: "transformation_output",
    lineNo: 3,
    from: input.to,
    to: input.from,
    quantity: "4",
  };
  const result = usCurrentTraceResultSchema.parse({
    ...original,
    edges: [...original.edges, output],
    completion: { ...original.completion, returnedEdges: 7 },
  });
  await setup(TraceGraph, result);
  const graph = screen.getByRole("img");
  const inputY = Number(
    graph.querySelector(`[data-label-edge-id="${input.id}"]`)?.getAttribute("y"),
  );
  const outputY = Number(
    graph.querySelector(`[data-label-edge-id="${output.id}"]`)?.getAttribute("y"),
  );
  expect(Math.abs(inputY - outputY)).toBeGreaterThanOrEqual(24);
});

it("preserves server order and renders exactly four transformation line edges, without lot-pair allocation", async () => {
  const result = fixture();
  expect(traceRows(result)).toEqual(result.edges);
  const { unmount } = await setup(TraceGraph, result);
  const graph = screen.getByRole("img", { name: "Current trace: 7 nodes, 6 edges" });
  const graphEdges = [...graph.querySelectorAll("[data-edge-id]")];
  expect(graphEdges.map((el) => el.getAttribute("data-edge-id"))).toEqual(
    result.edges.map((edge) => edge.id),
  );
  expect(
    graphEdges.filter((el) => el.getAttribute("data-edge-kind")?.startsWith("transformation_")),
  ).toHaveLength(4);
  for (const [index, edge] of result.edges.entries()) {
    expect(graphEdges[index]?.getAttribute("data-from")).toBe(edge.from);
    expect(graphEdges[index]?.getAttribute("data-to")).toBe(edge.to);
    expect(graph.querySelector(`[data-label-edge-id="${edge.id}"]`)?.textContent).toBe(
      `${edge.quantity} ${edge.unitOfMeasure}`,
    );
  }
  unmount();
  const { container } = await setup(TraceTable, result);
  const tableEdges = [...container.querySelectorAll("table [data-edge-id]")];
  expect(tableEdges.map((el) => el.getAttribute("data-edge-id"))).toEqual(
    result.edges.map((edge) => edge.id),
  );
  expect(screen.getAllByRole("row")).toHaveLength(7);
});

it.each([TraceGraph, TraceTable])(
  "opens every frozen event at its exact revision and line",
  async (Component) => {
    const result = fixture();
    const { user, onOpenEvent } = await setup(Component, result);
    const wanted = [
      { type: "receiving", eventId: uuid(21), revision: 2, lineSide: "items", lineNo: 1 },
      { type: "transformation", eventId: uuid(20), revision: 2, lineSide: "inputs", lineNo: 1 },
      { type: "transformation", eventId: uuid(20), revision: 2, lineSide: "inputs", lineNo: 2 },
      { type: "transformation", eventId: uuid(20), revision: 2, lineSide: "outputs", lineNo: 1 },
      { type: "transformation", eventId: uuid(20), revision: 2, lineSide: "outputs", lineNo: 2 },
      { type: "shipping", eventId: uuid(22), revision: 2, lineSide: "items", lineNo: 1 },
    ];
    const buttons = screen.getAllByRole("button", { name: /EVENT-/ });
    for (const [index, button] of buttons.entries()) {
      await user.click(button);
      expect(onOpenEvent).toHaveBeenLastCalledWith(wanted[index]);
      const edge = result.edges[index];
      if (!edge) throw new Error("Missing fixture edge");
      expect(edgeTarget(edge)).toEqual(wanted[index]);
    }
    expect(screen.getAllByText("Sep 15, 2026").length).toBeGreaterThan(0);
  },
);

it("only exposes real lots as lot actions, keeping material and location identities visible", async () => {
  const { user, onOpenLot } = await setup(TraceTable, fixture(true));
  const actions = within(screen.getByRole("group", { name: "Lots in this trace" })).getAllByRole(
    "button",
  );
  expect(actions).toHaveLength(3);
  for (const action of actions) await user.click(action);
  expect(onOpenLot.mock.calls).toEqual([[uuid(1)], [uuid(3)], [uuid(4)]]);
  expect(screen.getByRole("table").textContent).toContain("Non-FTL salt");
  expect(screen.getByRole("table").textContent).toContain("Customer");
  expect(screen.queryByRole("button", { name: /Non-FTL salt|Customer|Supplier/ })).toBeNull();
});

it("keeps non-FTL quantity labels outside the intervening lot shape", async () => {
  await setup(TraceGraph, fixture(true));
  const graph = screen.getByRole("img");
  const label = graph.querySelector(`[data-label-edge-id="${uuid(20)}:input:2"]`);
  const root = graph.querySelector(`[data-node-id="lot:${uuid(1)}"] rect`);
  if (!label || !root) throw new Error("Missing material label or root shape");
  const bottom = Number(root.getAttribute("y")) + Number(root.getAttribute("height"));
  expect(Number(label.getAttribute("y"))).toBeGreaterThan(bottom);
});

it.each([TraceGraph, TraceTable])(
  "keeps an isolated root accessible by keyboard with no current edges",
  async (Component) => {
    const result: UsCurrentTraceResult = {
      ...fixture(),
      nodes: [lot(1)],
      edges: [],
      currentEvents: [],
      completion: { state: "complete", returnedNodes: 1, returnedEdges: 0 },
    };
    const { user, onOpenLot } = await setup(Component, result);
    expect(screen.getByText("No current chain yet.")).toBeTruthy();
    const action = screen.getByRole("button", { name: `Open lot LOT-1 · ${uuid(1)}` });
    action.focus();
    await user.keyboard("{Enter}");
    expect(onOpenLot).toHaveBeenCalledWith(uuid(1));
  },
);

it("chooses table above 50 nodes without dropping nodes or edges", async () => {
  const result = fixture();
  expect(
    initialTraceTab({ ...result, nodes: Array.from({ length: 50 }, (_, i) => lot(i + 1)) }),
  ).toBe("graph");
  expect(
    initialTraceTab({ ...result, nodes: Array.from({ length: 51 }, (_, i) => lot(i + 1)) }),
  ).toBe("table");
  const large = usCurrentTraceResultSchema.parse({
    ...result,
    nodes: [...result.nodes, ...Array.from({ length: 44 }, (_, i) => lot(i + 50))],
    completion: { state: "complete", returnedNodes: 51, returnedEdges: 6 },
  });
  const { unmount } = await setup(TraceGraph, large);
  const graph = screen.getByRole("img", { name: "Current trace: 51 nodes, 6 edges" });
  expect(graph.querySelectorAll("[data-node-id]")).toHaveLength(51);
  expect(graph.querySelectorAll("[data-edge-id]")).toHaveLength(6);
  unmount();
  await setup(TraceTable, large);
  expect(screen.getAllByRole("row")).toHaveLength(7);
});

it("preserves two-to-one lines and absent quantities without allocating or converting units", async () => {
  const original = fixture();
  const result = usCurrentTraceResultSchema.parse({
    ...original,
    nodes: original.nodes.filter(
      (node) => ["lot", "transformation"].includes(node.kind) && node.id !== `lot:${uuid(4)}`,
    ),
    edges: original.edges.slice(1, 4).map((edge, index) => {
      if (index !== 2) return { ...edge, unitOfMeasure: index === 0 ? "lb" : "kg" };
      const withoutQuantity = { ...edge };
      delete withoutQuantity.quantity;
      delete withoutQuantity.unitOfMeasure;
      return withoutQuantity;
    }),
    currentEvents: original.currentEvents.filter((item) => item.type === "transformation"),
    completion: { state: "complete", returnedNodes: 4, returnedEdges: 3 },
  });
  const { unmount } = await setup(TraceGraph, result);
  const graph = screen.getByRole("img");
  expect(graph.querySelectorAll("[data-edge-id]")).toHaveLength(3);
  expect(
    [...graph.querySelectorAll(".us-trace-edge text")].map((text) => text.textContent),
  ).toEqual(["10 lb", "20 kg"]);
  unmount();
  await setup(TraceTable, result);
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain("10 lb");
  expect(rows[1]?.textContent).toContain("20 kg");
  expect(rows[2]?.textContent).toContain("—");
});

it("history opens the historical ID and exact revision without inventing a line", () => {
  expect(
    historyTarget({
      eventId: uuid(41),
      rootId: uuid(40),
      type: "shipping",
      eventNumber: "OLD",
      revision: 3,
      status: "void",
      reason: "Correction",
      previousRevisionId: uuid(42),
      nextRevisionId: null,
      eventDate: null,
      createdAt: "2026-09-15T12:00:00Z",
    }),
  ).toEqual({ type: "shipping", eventId: uuid(41), revision: 3, lineSide: null, lineNo: null });
});

it("provides Spanish node/line labels and preserves saved values", async () => {
  const { unmount } = await setup(TraceGraph, fixture(true), "es-US");
  expect(
    screen.getByRole("img", { name: "Trazabilidad actual: 7 nodos, 6 conexiones" }),
  ).toBeTruthy();
  unmount();
  await setup(TraceTable, fixture(true), "es-US");
  expect(screen.getByRole("table").textContent).toContain("Entrada de transformación");
  expect(screen.getByRole("table").textContent).toContain("Salida de transformación");
  expect(screen.getByRole("table").textContent).toContain("15 sept 2026");
  expect(screen.getByRole("table").textContent).toContain("12.500 kg");
});
