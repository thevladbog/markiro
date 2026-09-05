import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

const edge = (inputLotId: string, outputLotId: string, tenantId = "tenant-a") => ({
  tenantId,
  inputLotId,
  outputLotId,
});

describe("directed lot genealogy over a caller-selected revision view", () => {
  const diamond = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];

  it("traces both directions without duplicate lots or the starting lot", () => {
    expect(domain.ancestorsOf(diamond, "tenant-a", "d")).toEqual(["a", "b", "c"]);
    expect(domain.descendantsOf(diamond, "tenant-a", "a")).toEqual(["b", "c", "d"]);
    expect(domain.ancestorsOf(diamond, "tenant-a", "a")).toEqual([]);
    expect(domain.descendantsOf(diamond, "tenant-a", "d")).toEqual([]);
  });
  it("does not confuse disconnected components, adjacent branches or missing lots", () => {
    const edges = [...diamond, edge("x", "y")];
    expect(domain.descendantsOf(edges, "tenant-a", "b")).toEqual(["d"]);
    expect(domain.ancestorsOf(edges, "tenant-a", "c")).toEqual(["a"]);
    expect(domain.ancestorsOf(edges, "tenant-a", "absent")).toEqual([]);
    expect(domain.descendantsOf([], "tenant-a", "absent")).toEqual([]);
  });
  it("ignores foreign-tenant edges even when local lot IDs coincide", () => {
    const edges = [...diamond, edge("d", "secret", "tenant-b"), edge("secret", "a", "tenant-b")];
    expect(domain.descendantsOf(edges, "tenant-a", "a")).toEqual(["b", "c", "d"]);
    expect(domain.ancestorsOf(edges, "tenant-a", "d")).toEqual(["a", "b", "c"]);
    expect(domain.descendantsOf(edges, "tenant-b", "d")).toEqual(["a", "secret"]);
    expect(domain.wouldCreateCycle([edge("a", "b", "tenant-b")], edge("b", "a"))).toBe(false);
  });
  it("produces deterministic ordinal results without modifying the edge set", () => {
    const edges = Object.freeze([edge("root", "z"), edge("root", "A"), edge("root", "é")]);
    expect(domain.descendantsOf(edges, "tenant-a", "root")).toEqual(["A", "z", "é"]);
    expect(domain.descendantsOf([...edges].reverse(), "tenant-a", "root")).toEqual(["A", "z", "é"]);
    expect(edges.map((item) => item.outputLotId)).toEqual(["z", "A", "é"]);
  });
  it("rejects direct and transitive cycles but permits a converging path", () => {
    expect(domain.wouldCreateCycle([], edge("a", "a"))).toBe(true);
    expect(domain.wouldCreateCycle(diamond, edge("d", "a"))).toBe(true);
    expect(domain.wouldCreateCycle(diamond, edge("b", "a"))).toBe(true);
    expect(domain.wouldCreateCycle(diamond, edge("b", "c"))).toBe(false);
    expect(domain.wouldCreateCycle(diamond, edge("d", "new"))).toBe(false);
    expect(domain.wouldCreateCycle(diamond, edge("a", "b"))).toBe(false);
  });
  it("terminates on cyclic or duplicated historical input without returning the starting lot", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "b"), edge("a", "a")];
    expect(domain.ancestorsOf(edges, "tenant-a", "a")).toEqual(["b", "c"]);
    expect(domain.descendantsOf(edges, "tenant-a", "a")).toEqual(["b", "c"]);
    expect(domain.wouldCreateCycle(edges, edge("c", "b"))).toBe(true);
  });
  it("does not silently truncate deep genealogies or depend on the call stack", () => {
    const edges = Array.from({ length: 15000 }, (_, index) =>
      edge(String(index), String(index + 1)),
    );
    const descendants = domain.descendantsOf(edges, "tenant-a", "0");
    expect(descendants).toHaveLength(15000);
    expect(descendants).toContain("15000");
    expect(domain.ancestorsOf(edges, "tenant-a", "15000")).toHaveLength(15000);
    expect(domain.wouldCreateCycle(edges, edge("15000", "0"))).toBe(true);
  });
});
