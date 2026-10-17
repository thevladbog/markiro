import { describe, expect, it } from "vitest";

import {
  HEADING_PX,
  ROW_PX,
  TABLE_FLOOR_PX,
  fillEngaged,
  tableFloorPx,
} from "../src/office/list/fill-model.js";

describe("the list's fill / shrink decision", () => {
  it("never asks for more than the rows themselves need, so a short list has no empty room under its last row", () => {
    expect(tableFloorPx(0)).toBe(HEADING_PX);
    expect(tableFloorPx(1)).toBe(HEADING_PX + ROW_PX);
    expect(tableFloorPx(2)).toBe(HEADING_PX + 2 * ROW_PX);
  });

  it("caps the floor at a usable table, so a low window scrolls the page instead of crushing the rows", () => {
    expect(tableFloorPx(4)).toBe(TABLE_FLOOR_PX);
    expect(tableFloorPx(3)).toBe(HEADING_PX + 3 * ROW_PX);
    expect(tableFloorPx(10)).toBe(TABLE_FLOOR_PX);
    expect(tableFloorPx(100)).toBe(TABLE_FLOOR_PX);
  });

  it("treats a negative or fractional count as the nearest whole count of rows", () => {
    expect(tableFloorPx(-4)).toBe(HEADING_PX);
    expect(tableFloorPx(1.9)).toBe(HEADING_PX + ROW_PX);
  });

  it("pins the heading and scrolls the rows only when the content is taller than the room", () => {
    expect(fillEngaged(300, 600)).toBe(false);
    expect(fillEngaged(600, 600)).toBe(false);
    expect(fillEngaged(601, 600)).toBe(true);
  });
});
