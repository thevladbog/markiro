import { describe, expect, it } from "vitest";

import { listViewState } from "../src/office/list/list-state.js";
import { menuMove, nextEnabled } from "../src/office/list/menu-model.js";
import { filterControlKind, segmentKeyMove } from "../src/office/list/segment-model.js";

describe("the menu's keyboard model", () => {
  it("reads the arrows, Home and End as moves, and nothing else", () => {
    expect(menuMove("ArrowDown")).toBe("next");
    expect(menuMove("ArrowUp")).toBe("previous");
    expect(menuMove("Home")).toBe("first");
    expect(menuMove("End")).toBe("last");
    expect(menuMove("Tab")).toBeNull();
    expect(menuMove("Enter")).toBeNull();
    expect(menuMove("a")).toBeNull();
  });

  it("moves to the next enabled entry and wraps at both ends", () => {
    const open = [false, false, false];
    expect(nextEnabled("next", 0, open)).toBe(1);
    expect(nextEnabled("next", 2, open)).toBe(0);
    expect(nextEnabled("previous", 0, open)).toBe(2);
    expect(nextEnabled("previous", 2, open)).toBe(1);
    expect(nextEnabled("first", 2, open)).toBe(0);
    expect(nextEnabled("last", 0, open)).toBe(2);
  });

  it("skips disabled entries", () => {
    const disabled = [false, true, false, true];
    expect(nextEnabled("next", 0, disabled)).toBe(2);
    expect(nextEnabled("next", 2, disabled)).toBe(0);
    expect(nextEnabled("previous", 0, disabled)).toBe(2);
    expect(nextEnabled("last", 0, disabled)).toBe(2);
    expect(nextEnabled("first", 2, [true, false, false])).toBe(1);
  });

  it("starts from the first (or last) entry when none has the focus, and has nowhere to go with no enabled entry", () => {
    expect(nextEnabled("next", -1, [false, false])).toBe(0);
    expect(nextEnabled("previous", -1, [false, false])).toBe(1);
    expect(nextEnabled("next", 0, [true, true])).toBeNull();
    expect(nextEnabled("next", 0, [])).toBeNull();
  });
});

describe("the segmented control's keyboard model", () => {
  it("reads the left and right arrows, Home and End, in both text directions of a row", () => {
    expect(segmentKeyMove("ArrowRight")).toBe("next");
    expect(segmentKeyMove("ArrowDown")).toBe("next");
    expect(segmentKeyMove("ArrowLeft")).toBe("previous");
    expect(segmentKeyMove("ArrowUp")).toBe("previous");
    expect(segmentKeyMove("Home")).toBe("first");
    expect(segmentKeyMove("End")).toBe("last");
    expect(segmentKeyMove("Enter")).toBeNull();
  });
});

describe("which control a filter uses", () => {
  it("is a segmented control for up to three values and a select for four and more", () => {
    expect(filterControlKind(2)).toBe("segments");
    expect(filterControlKind(3)).toBe("segments");
    expect(filterControlKind(4)).toBe("select");
    expect(filterControlKind(9)).toBe("select");
  });
});

describe("the state a list shows", () => {
  const base = { pending: false, failed: false, total: 5, found: 5 };

  it("is loading until the first read ends, and an error when it failed", () => {
    expect(listViewState({ ...base, pending: true, total: 0, found: 0 })).toBe("loading");
    expect(listViewState({ ...base, failed: true, total: 0, found: 0 })).toBe("error");
  });

  it("an error wins over a stale pending flag only when nothing is loading", () => {
    expect(listViewState({ ...base, pending: true, failed: true })).toBe("loading");
  });

  it("is empty when the list has no rows at all, and nothing found when filters hide every row", () => {
    expect(listViewState({ ...base, total: 0, found: 0 })).toBe("empty");
    expect(listViewState({ ...base, total: 12, found: 0 })).toBe("nothing");
  });

  it("shows the rows otherwise", () => {
    expect(listViewState(base)).toBe("rows");
    expect(listViewState({ ...base, total: 12, found: 3 })).toBe("rows");
  });
});
