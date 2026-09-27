import { describe, expect, it } from "vitest";
import { projectTransformationGenealogy } from "../src/traceability/transformation-genealogy.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lot = (n: number, currentOrigin = true) => ({ id: id(n), currentOrigin });
const line = (n: number, quantity: string, unitOfMeasure = "lb") => ({
  lineNo: n,
  lotId: id(n),
  quantity,
  unitOfMeasure,
});
const event = (
  n: number,
  inputs: ReturnType<typeof line>[],
  outputs: ReturnType<typeof line>[],
  status: "finalized" | "amended" | "void" = "finalized",
  revision = 1,
) => ({
  id: id(n),
  rootId: id(90),
  revision,
  status,
  snapshot: {
    eventId: id(n),
    revision,
    inputs: inputs.map((input) => ({ ...input, kind: "ftl_lot" as const })),
    outputs,
  },
});
const edge = (eventId: number, inputLotId: number, outputLotId: number) => ({
  eventId: id(eventId),
  inputLotId: id(inputLotId),
  outputLotId: id(outputLotId),
});
const base = {
  mode: "current" as const,
  direction: "upstream" as const,
  maxDepth: 20,
  maxNodes: 500,
};

describe("pure Transformation genealogy projection", () => {
  const largeEvidence = () => {
    const inputs = Array.from({ length: 46 }, (_, index) => line(index + 1, "1"));
    const outputs = Array.from({ length: 46 }, (_, index) => line(index + 101, "1"));
    return {
      ...base,
      startLotId: id(101),
      lots: [...inputs, ...outputs].map((value) => ({ id: value.lotId, currentOrigin: true })),
      events: [event(9000, inputs, outputs)],
      links: inputs.flatMap((source) =>
        outputs.map((target) => ({
          eventId: id(9000),
          inputLotId: source.lotId,
          outputLotId: target.lotId,
        })),
      ),
    };
  };

  it("diagnoses a known truncated sorted link prefix only as a limit", () => {
    const evidence = largeEvidence();
    const result = projectTransformationGenealogy({
      ...evidence,
      links: evidence.links.slice(0, 2001),
      linksTruncated: true,
    });
    expect(result.complete).toBe(false);
    expect(result.links).toHaveLength(2000);
    expect(result.diagnostics).toEqual([{ code: "limit" }]);
  });

  it("still detects a missing link within a known prefix and unexpected fetched links", () => {
    const evidence = largeEvidence();
    for (const links of [
      evidence.links.slice(1, 2002),
      [...evidence.links.slice(0, 2001), edge(9000, 1, 1)],
    ]) {
      const result = projectTransformationGenealogy({ ...evidence, links, linksTruncated: true });
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual({ code: "limit" });
      expect(result.diagnostics).toContainEqual({
        code: "inconsistent_evidence",
        eventId: id(9000),
      });
    }
  });

  it("does not suppress an absent suffix when the selected link read is complete", () => {
    const evidence = largeEvidence();
    const result = projectTransformationGenealogy({
      ...evidence,
      links: evidence.links.slice(0, 2000),
    });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toContainEqual({ code: "inconsistent_evidence", eventId: id(9000) });
  });

  it("projects 2→2 through four links while counting each frozen line once", () => {
    const e = event(10, [line(1, "2"), line(2, "3")], [line(3, "4"), line(4, "1")]);
    const evidence = {
      ...base,
      startLotId: id(3),
      lots: [lot(4), lot(2), lot(3), lot(1)],
      events: [e],
      links: [edge(10, 2, 4), edge(10, 1, 3), edge(10, 2, 3), edge(10, 1, 4)],
    };
    const result = projectTransformationGenealogy(evidence);
    expect(result.events).toEqual([e]);
    expect(result.links).toEqual([edge(10, 1, 3), edge(10, 1, 4), edge(10, 2, 3), edge(10, 2, 4)]);
    expect(result.balance).toEqual({
      state: "arithmetic",
      unitOfMeasure: "lb",
      inputQuantity: "5",
      outputQuantity: "5",
      deltaQuantity: "0",
    });
    expect(result.complete).toBe(true);
    expect(result.selectedRevisionIds).toEqual([id(10)]);
    expect(result.lots.map((item) => item.id)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("retains a zero-FTL-input origin event and its non-FTL frozen line", () => {
    const e = {
      ...event(10, [], [line(3, "1", "case")]),
      snapshot: {
        eventId: id(10),
        revision: 1,
        inputs: [{ kind: "non_ftl" as const, lineNo: 1, quantity: "2", unitOfMeasure: "lb" }],
        outputs: [line(3, "1", "case")],
      },
    };
    const result = projectTransformationGenealogy({
      ...base,
      startLotId: id(3),
      lots: [lot(3)],
      events: [e],
      links: [],
    });
    expect(result.events).toEqual([e]);
    expect(result.links).toEqual([]);
    expect(result.balance).toEqual({
      state: "unknown",
      values: [
        { side: "input", quantity: "2", unitOfMeasure: "lb" },
        { side: "output", quantity: "1", unitOfMeasure: "case" },
      ],
    });
    expect(result.complete).toBe(true);
  });

  it("traverses upstream and downstream deterministically from shuffled evidence", () => {
    const e1 = event(10, [line(1, "1")], [line(2, "1")]);
    const e2 = event(11, [line(2, "1")], [line(3, "1")]);
    const common = {
      lots: [lot(3), lot(1), lot(2)],
      events: [e2, e1],
      links: [edge(11, 2, 3), edge(10, 1, 2)],
    };
    const upstream = projectTransformationGenealogy({ ...base, ...common, startLotId: id(3) });
    const downstream = projectTransformationGenealogy({
      ...base,
      ...common,
      startLotId: id(1),
      direction: "downstream",
    });
    expect(upstream.lots.map((item) => item.id)).toEqual([id(1), id(2), id(3)]);
    expect(downstream.events.map((item) => item.id)).toEqual([id(10), id(11)]);
    expect(upstream.links).toEqual(downstream.links);
  });

  it("does not expand downstream through a co-input or upstream through a co-output", () => {
    const main = event(10, [line(1, "1"), line(2, "1")], [line(3, "1"), line(4, "1")]);
    const otherConsumer = event(11, [line(2, "1")], [line(5, "1")]);
    const otherProducer = event(12, [line(6, "1")], [line(4, "1")], "amended");
    const common = {
      lots: [lot(1), lot(2), lot(3), lot(4), lot(5), lot(6)],
      events: [main, otherConsumer, otherProducer],
      links: [
        edge(10, 1, 3),
        edge(10, 1, 4),
        edge(10, 2, 3),
        edge(10, 2, 4),
        edge(11, 2, 5),
        edge(12, 6, 4),
      ],
    };
    const downstream = projectTransformationGenealogy({
      ...base,
      ...common,
      startLotId: id(1),
      direction: "downstream",
    });
    expect(downstream.events.map((item) => item.id)).toEqual([id(10)]);
    expect(downstream.lots.map((item) => item.id)).toEqual([id(1), id(2), id(3), id(4)]);
    const upstream = projectTransformationGenealogy({ ...base, ...common, startLotId: id(3) });
    expect(upstream.events.map((item) => item.id)).toEqual([id(10)]);
    expect(upstream.lots.map((item) => item.id)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("marks cycles and depth/node truncation incomplete", () => {
    const common = {
      lots: [lot(1), lot(2)],
      events: [
        event(10, [line(1, "1")], [line(2, "1")]),
        event(11, [line(2, "1")], [line(1, "1")]),
      ],
      links: [edge(10, 1, 2), edge(11, 2, 1)],
    };
    const cycle = projectTransformationGenealogy({ ...base, ...common, startLotId: id(1) });
    expect(cycle.complete).toBe(false);
    expect(cycle.diagnostics).toContainEqual({ code: "cycle", lotId: id(1) });
    const depth = projectTransformationGenealogy({
      ...base,
      ...common,
      startLotId: id(1),
      maxDepth: 0,
    });
    expect(depth.lots).toEqual([lot(1)]);
    expect(depth.diagnostics).toContainEqual({ code: "limit", lotId: id(1) });
    const nodes = projectTransformationGenealogy({
      ...base,
      ...common,
      startLotId: id(1),
      maxNodes: 1,
    });
    expect(nodes.lots).toEqual([lot(1)]);
    expect(nodes.diagnostics).toContainEqual({ code: "limit", eventId: id(11) });
  });

  it("reports absent current origin and contradictory frozen link evidence", () => {
    const gap = projectTransformationGenealogy({
      ...base,
      startLotId: id(1),
      lots: [lot(1, false)],
      events: [],
      links: [],
    });
    expect(gap.complete).toBe(false);
    expect(gap.diagnostics).toContainEqual({ code: "origin_gap", lotId: id(1) });
    const bad = projectTransformationGenealogy({
      ...base,
      startLotId: id(2),
      lots: [lot(1), lot(2)],
      events: [event(10, [line(1, "1")], [line(2, "1")])],
      links: [edge(10, 9, 2)],
    });
    expect(bad.complete).toBe(false);
    expect(bad.diagnostics).toContainEqual({ code: "inconsistent_evidence", eventId: id(10) });
  });

  it("reports a current-origin gap even in a downstream view", () => {
    const result = projectTransformationGenealogy({
      ...base,
      startLotId: id(1),
      direction: "downstream",
      lots: [lot(1, false)],
      events: [],
      links: [],
    });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toContainEqual({ code: "origin_gap", lotId: id(1) });
  });

  it("preserves pinned historical revision provenance and snapshotless void", () => {
    const prior = event(10, [line(1, "2")], [line(2, "2")], "amended", 1);
    const voidDraft = {
      id: id(11),
      rootId: id(90),
      revision: 2,
      status: "void" as const,
      snapshot: null,
    };
    const result = projectTransformationGenealogy({
      ...base,
      mode: "pinned",
      startLotId: id(2),
      lots: [lot(1), lot(2)],
      events: [voidDraft, prior],
      links: [edge(10, 1, 2)],
    });
    expect(result.events).toEqual([prior, voidDraft]);
    expect(result.selectedRevisionIds).toEqual([id(10), id(11)]);
    expect(result.balance).toEqual({
      state: "arithmetic",
      unitOfMeasure: "lb",
      inputQuantity: "2",
      outputQuantity: "2",
      deltaQuantity: "0",
    });
  });

  it("does not silently drop an explicitly selected disconnected pinned revision", () => {
    const connected = event(10, [line(1, "1")], [line(2, "1")], "amended");
    const disconnected = event(11, [line(3, "2")], [line(4, "2")], "void");
    const result = projectTransformationGenealogy({
      ...base,
      mode: "pinned",
      startLotId: id(2),
      lots: [lot(1), lot(2), lot(3), lot(4)],
      events: [disconnected, connected],
      links: [edge(10, 1, 2), edge(11, 3, 4)],
    });
    expect(result.selectedRevisionIds).toEqual([id(10), id(11)]);
    expect(result.events.map((item) => item.id)).toEqual([id(10), id(11)]);
    expect(result.links).toEqual([edge(10, 1, 2), edge(11, 3, 4)]);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toContainEqual({ code: "inconsistent_evidence", eventId: id(11) });
  });

  it("keeps a depth-limited pinned revision identity without expanding beyond the frontier", () => {
    const first = event(10, [line(1, "1")], [line(2, "1")], "amended");
    const second = event(11, [line(2, "1")], [line(3, "1")], "finalized", 2);
    const result = projectTransformationGenealogy({
      ...base,
      mode: "pinned",
      startLotId: id(3),
      maxDepth: 1,
      lots: [lot(1), lot(2), lot(3)],
      events: [first, second],
      links: [edge(10, 1, 2), edge(11, 2, 3)],
    });
    expect(result.selectedRevisionIds).toEqual([id(10), id(11)]);
    expect(result.lots.map((item) => item.id)).toEqual([id(2), id(3)]);
    expect(result.links).toEqual([edge(11, 2, 3)]);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toContainEqual({ code: "limit", eventId: id(10) });
    expect(result.diagnostics).not.toContainEqual({
      code: "inconsistent_evidence",
      eventId: id(10),
    });
  });

  it("classifies every connected pinned revision beyond depth in both directions", () => {
    const events = [
      event(10, [line(1, "1")], [line(2, "1")], "amended"),
      event(11, [line(2, "1")], [line(3, "1")], "amended"),
      event(12, [line(3, "1")], [line(4, "1")], "finalized"),
    ];
    const common = {
      ...base,
      mode: "pinned" as const,
      maxDepth: 1,
      lots: [lot(1), lot(2), lot(3), lot(4)],
      events,
      links: [edge(10, 1, 2), edge(11, 2, 3), edge(12, 3, 4)],
    };
    const upstream = projectTransformationGenealogy({ ...common, startLotId: id(4) });
    expect(upstream.selectedRevisionIds).toEqual([id(10), id(11), id(12)]);
    expect(upstream.lots.map((item) => item.id)).toEqual([id(3), id(4)]);
    expect(upstream.links).toEqual([edge(12, 3, 4)]);
    expect(upstream.diagnostics).toContainEqual({ code: "limit", eventId: id(10) });
    expect(upstream.diagnostics).toContainEqual({ code: "limit", eventId: id(11) });
    expect(upstream.diagnostics).not.toContainEqual({
      code: "inconsistent_evidence",
      eventId: id(10),
    });
    const downstream = projectTransformationGenealogy({
      ...common,
      startLotId: id(1),
      direction: "downstream",
    });
    expect(downstream.selectedRevisionIds).toEqual([id(10), id(11), id(12)]);
    expect(downstream.lots.map((item) => item.id)).toEqual([id(1), id(2)]);
    expect(downstream.links).toEqual([edge(10, 1, 2)]);
    expect(downstream.diagnostics).toContainEqual({ code: "limit", eventId: id(11) });
    expect(downstream.diagnostics).toContainEqual({ code: "limit", eventId: id(12) });
    expect(downstream.diagnostics).not.toContainEqual({
      code: "inconsistent_evidence",
      eventId: id(12),
    });
  });

  it("falls back to exact frozen line values when same-unit totals exceed the result decimal range", () => {
    const inputs = Array.from({ length: 100 }, (_, index) =>
      line(index + 1, "999999999999999.999"),
    );
    const events = Array.from({ length: 11 }, (_, index) =>
      event(301 + index, inputs, [line(201, "1")], "amended", index + 1),
    );
    const links = events.flatMap((item) =>
      inputs.map((source) => ({
        eventId: item.id,
        inputLotId: source.lotId,
        outputLotId: id(201),
      })),
    );
    const result = projectTransformationGenealogy({
      ...base,
      mode: "pinned",
      startLotId: id(201),
      lots: [...inputs.map((source) => ({ id: source.lotId, currentOrigin: true })), lot(201)],
      events,
      links,
    });
    expect(result.balance.state).toBe("unknown");
    if (result.balance.state !== "unknown") throw new Error("Expected unknown balance");
    expect(result.balance.values).toHaveLength(1111);
    expect(result.balance.values[0]).toEqual({
      side: "input",
      quantity: "999999999999999.999",
      unitOfMeasure: "lb",
    });
    expect(result.balance.values.at(-1)).toEqual({
      side: "output",
      quantity: "1",
      unitOfMeasure: "lb",
    });
  });

  it("deduplicates deep-equivalent frozen events but diagnoses changed frozen evidence", () => {
    const original = event(10, [line(1, "2")], [line(2, "2")]);
    const duplicate = structuredClone(original);
    const common = {
      ...base,
      startLotId: id(2),
      lots: [lot(1), lot(2)],
      links: [edge(10, 1, 2)],
    };
    const equivalent = projectTransformationGenealogy({ ...common, events: [original, duplicate] });
    expect(equivalent.events).toEqual([original]);
    expect(equivalent.complete).toBe(true);
    const changed = structuredClone(original);
    changed.snapshot.inputs[0]!.quantity = "3";
    const inconsistent = projectTransformationGenealogy({ ...common, events: [original, changed] });
    expect(inconsistent.complete).toBe(false);
    expect(inconsistent.diagnostics).toContainEqual({
      code: "inconsistent_evidence",
      eventId: id(10),
    });
  });

  it("does not invent balances for snapshotless-only or mixed-unit history", () => {
    const voidDraft = {
      id: id(11),
      rootId: id(90),
      revision: 2,
      status: "void" as const,
      snapshot: null,
    };
    const none = projectTransformationGenealogy({
      ...base,
      mode: "pinned",
      startLotId: id(2),
      lots: [lot(2)],
      events: [voidDraft],
      links: [],
    });
    expect(none.balance).toEqual({ state: "unknown", values: [] });
    const mixed = projectTransformationGenealogy({
      ...base,
      startLotId: id(2),
      lots: [lot(1), lot(2)],
      events: [event(10, [line(1, "2", "lb")], [line(2, "3", "case")])],
      links: [edge(10, 1, 2)],
    });
    expect(mixed.balance).toEqual({
      state: "unknown",
      values: [
        { side: "input", quantity: "2", unitOfMeasure: "lb" },
        { side: "output", quantity: "3", unitOfMeasure: "case" },
      ],
    });
  });
});
