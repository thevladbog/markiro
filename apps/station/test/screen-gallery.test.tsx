import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPECTED_GALLERY_STATE_IDS,
  GALLERY_FIXTURES,
  findMissingGalleryStates,
  resolveGalleryRequest,
} from "../src/dev/gallery-fixtures.js";
import { shouldRenderGallery } from "../src/dev/gallery-guard.js";
import { StationScreenGallery } from "../src/dev/StationScreenGallery.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("development screen gallery", () => {
  it("keeps the gallery unreachable outside development even when the query requests it", () => {
    expect(shouldRenderGallery(false, "?gallery=1&state=work-ok&locale=en")).toBe(false);
    expect(shouldRenderGallery(true, "?gallery=0&state=work-ok")).toBe(false);
    expect(shouldRenderGallery(true, "?state=work-ok")).toBe(false);
    expect(shouldRenderGallery(true, "?gallery=1&state=work-ok&locale=en")).toBe(true);

    expect(resolveGalleryRequest(false, "?gallery=1&state=work-ok&locale=en")).toBeNull();

    expect(resolveGalleryRequest(true, "?gallery=1&state=work-ok&locale=en")).toEqual({
      state: "work-ok",
      locale: "en",
    });
  });

  it("falls back deterministically for unknown state and locale values", () => {
    expect(resolveGalleryRequest(true, "?gallery=1&state=not-a-screen&locale=de")).toEqual({
      state: "pairing-waiting",
      locale: "ru",
    });
  });

  it("reports a missing fixture from the independently maintained expected-state list", () => {
    expect(findMissingGalleryStates(GALLERY_FIXTURES)).toEqual([]);

    const withoutPrintVerification = GALLERY_FIXTURES.filter(
      (fixture) => fixture.id !== "print-verification",
    );
    expect(findMissingGalleryStates(withoutPrintVerification)).toEqual(["print-verification"]);
    expect(EXPECTED_GALLERY_STATE_IDS).toContain("print-verification");
  });

  it("renders every expected state through the real fixed station shell without external reads", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("gallery must not use the network")));
    vi.stubGlobal("fetch", fetchSpy);

    for (const state of EXPECTED_GALLERY_STATE_IDS) {
      const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);

      expect(screen.getByTestId("station-screen-gallery").getAttribute("data-gallery-state")).toBe(
        state,
      );
      expect(view.container.querySelector(".station-root")).not.toBeNull();
      expect(view.container.querySelector(".station-screen-slot")).not.toBeNull();

      view.unmount();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders locale-specific long-copy fixtures inside the captured shell", () => {
    const { rerender } = render(
      <StationScreenGallery request={{ state: "long-copy-ru", locale: "ru" }} />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Продолжительная автономная работа на производственной линии",
      }),
    ).not.toBeNull();

    rerender(<StationScreenGallery request={{ state: "long-copy-en", locale: "en" }} />);
    expect(
      screen.getByRole("heading", {
        name: "Extended offline operation on the production line",
      }),
    ).not.toBeNull();
  });
});
