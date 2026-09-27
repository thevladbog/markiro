// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { initHomeMap } from "./map";

function renderMap(): HTMLElement[] {
  document.body.innerHTML = `
    <ul>
      <li data-map-spot><a href="#product-line" aria-describedby="tip-line">Линия</a><div role="tooltip" id="tip-line">Станция</div></li>
      <li data-map-spot><a href="#product-kiosk" aria-describedby="tip-kiosk">Киоск</a><div role="tooltip" id="tip-kiosk">Киоск</div></li>
    </ul>`;
  return [...document.querySelectorAll<HTMLElement>("[data-map-spot]")];
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("initHomeMap", () => {
  it("hides the focused hotspot's tooltip on Escape and brings it back when focus leaves", () => {
    const [line, kiosk] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    pressEscape();
    expect(line?.hasAttribute("data-dismissed")).toBe(true);
    expect(kiosk?.hasAttribute("data-dismissed")).toBe(false);
    line?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
  });

  it("brings a dismissed tooltip back when the pointer leaves", () => {
    const [line] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    pressEscape();
    line?.dispatchEvent(new Event("pointerleave"));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
  });

  it("ignores other keys and stops listening after cleanup", () => {
    const [line] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
    pressEscape();
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
  });
});
