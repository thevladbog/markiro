import { describe, expect, it } from "vitest";

import settings from "../../../content/home-map.json";
import { HOME_MAP_FRAME, projectHomeMap } from "./home-map";

describe("home map projection", () => {
  const points = projectHomeMap();
  const at = (id: string) => {
    const point = points.find((candidate) => candidate.id === id);
    if (point === undefined) throw new Error(`missing ${id}`);
    return point;
  };

  it("renders the still at the recorded film moment and frame", () => {
    expect(settings.filmTime).toBe(0.8);
    expect(HOME_MAP_FRAME).toEqual({ width: 1440, height: 900 });
  });

  it("keeps every hotspot on the image and right of the text column", () => {
    expect(points.map((point) => point.id)).toEqual([
      "line",
      "packing",
      "warehouse",
      "kiosk",
      "office",
    ]);
    for (const point of points) {
      expect(point.x, point.id).toBeGreaterThan(0.42);
      expect(point.x, point.id).toBeLessThan(0.97);
      expect(point.y, point.id).toBeGreaterThan(0.08);
      expect(point.y, point.id).toBeLessThan(0.92);
    }
  });

  it("keeps the plant's layout: office behind, kiosk in front, line to warehouse left to right", () => {
    expect(at("office").y).toBeLessThan(at("packing").y);
    expect(at("packing").y).toBeLessThan(at("kiosk").y);
    expect(at("line").y).toBeLessThan(at("kiosk").y);
    expect(at("line").x).toBeLessThan(at("packing").x);
    expect(at("packing").x).toBeLessThan(at("warehouse").x);
  });

  it("leaves room between the dots for their labels", () => {
    for (const a of points) {
      for (const b of points) {
        if (a.id >= b.id) continue;
        const gap = Math.hypot(
          (a.x - b.x) * HOME_MAP_FRAME.width,
          (a.y - b.y) * HOME_MAP_FRAME.height,
        );
        expect(gap, `${a.id}–${b.id}`).toBeGreaterThan(64);
      }
    }
  });
});
