import { describe, expect, it } from "vitest";

import {
  clampCrop,
  cropRect,
  initialCrop,
  MAX_ZOOM,
  outputSide,
  panCrop,
  previewLayout,
  zoomCrop,
} from "../src/office/avatar/avatar-crop.js";

describe("avatar crop math", () => {
  it("starts on the largest centred square of a wide picture", () => {
    const crop = initialCrop(1000, 500);
    expect(cropRect(1000, 500, crop)).toEqual({ sx: 250, sy: 0, side: 500 });
  });

  it("starts on the largest centred square of a tall picture", () => {
    expect(cropRect(400, 1000, initialCrop(400, 1000))).toEqual({ sx: 0, sy: 300, side: 400 });
  });

  it("shrinks the square as the zoom grows, around the centre", () => {
    const crop = zoomCrop(1000, 1000, initialCrop(1000, 1000), 2);
    expect(cropRect(1000, 1000, crop)).toEqual({ sx: 250, sy: 250, side: 500 });
  });

  it("clamps the zoom to 1..MAX_ZOOM", () => {
    expect(zoomCrop(800, 800, initialCrop(800, 800), 0.2).zoom).toBe(1);
    expect(zoomCrop(800, 800, initialCrop(800, 800), 99).zoom).toBe(MAX_ZOOM);
  });

  it("keeps the square inside the picture however far it is dragged", () => {
    const zoomed = zoomCrop(1000, 600, initialCrop(1000, 600), 2);
    const far = panCrop(1000, 600, zoomed, -9999, -9999, 260);
    expect(cropRect(1000, 600, far)).toEqual({ sx: 700, sy: 300, side: 300 });
    const back = panCrop(1000, 600, zoomed, 9999, 9999, 260);
    expect(cropRect(1000, 600, back)).toEqual({ sx: 0, sy: 0, side: 300 });
  });

  it("drags the picture, so the crop moves the opposite way, scaled by side over view", () => {
    const zoomed = zoomCrop(1000, 1000, initialCrop(1000, 1000), 2); // side 500, view 250 => 2 px per px
    const moved = panCrop(1000, 1000, zoomed, 25, -50, 250);
    // the picture moved right 25 and up 50: the window sees 50 px more to the left, 100 more below
    expect(cropRect(1000, 1000, moved)).toEqual({ sx: 200, sy: 350, side: 500 });
  });

  it("re-clamps a crop whose zoom was lowered after a drag", () => {
    const zoomed = zoomCrop(1000, 1000, initialCrop(1000, 1000), 4);
    const far = panCrop(1000, 1000, zoomed, -9999, -9999, 260);
    const lowered = zoomCrop(1000, 1000, far, 1);
    expect(cropRect(1000, 1000, lowered)).toEqual({ sx: 0, sy: 0, side: 1000 });
    expect(clampCrop(1000, 1000, lowered)).toEqual(lowered);
  });

  it("writes 128..256 px: never below the host's floor, never larger than stored", () => {
    expect(outputSide(40)).toBe(128);
    expect(outputSide(128)).toBe(128);
    expect(outputSide(200.4)).toBe(200);
    expect(outputSide(3000)).toBe(256);
  });

  it("lays a preview out so the same square fills it", () => {
    // 1000x500 picture, crop square 500 at x=250: a 100 px preview shows it at 0.2x
    expect(previewLayout(1000, 500, { sx: 250, sy: 0, side: 500 }, 100)).toEqual({
      width: 200,
      height: 100,
      left: -50,
      top: 0,
    });
  });
});
