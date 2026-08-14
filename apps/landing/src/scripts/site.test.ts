// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { initLanding, type LandingRuntime, type RevealEntry } from "./site";

function renderShell(): void {
  document.body.innerHTML = `
    <button data-menu-trigger aria-expanded="false" aria-controls="landing-navigation">Меню</button>
    <nav id="landing-navigation" data-menu><a href="#cycle">Как работает</a></nav>
    <main><section data-reveal></section><article data-reveal></article></main>
  `;
}

function runtime(overrides: Partial<LandingRuntime> = {}): LandingRuntime {
  return {
    createObserver: vi.fn(() => ({
      disconnect: vi.fn(),
      observe: vi.fn(),
      unobserve: vi.fn(),
    })),
    reducedMotion: false,
    track: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.documentElement.className = "";
  document.body.innerHTML = "";
});

describe("initLanding", () => {
  it("opens the mobile menu and restores trigger focus when Escape closes it", () => {
    renderShell();
    const trigger = document.querySelector<HTMLButtonElement>("[data-menu-trigger]");
    const menu = document.querySelector<HTMLElement>("[data-menu]");
    const cleanup = initLanding(document, runtime());

    trigger?.click();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.classList.contains("is-open")).toBe(true);

    menu?.querySelector<HTMLAnchorElement>("a")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(menu?.classList.contains("is-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    cleanup();
  });

  it("reveals all content immediately without creating an observer for reduced motion", () => {
    renderShell();
    const createObserver = vi.fn<LandingRuntime["createObserver"]>();

    initLanding(document, runtime({ createObserver, reducedMotion: true }));

    expect(document.querySelectorAll("[data-reveal].is-visible")).toHaveLength(2);
    expect(createObserver).not.toHaveBeenCalled();
  });

  it("reveals intersecting content once and disconnects the observer on cleanup", () => {
    renderShell();
    let reveal: ((entries: readonly RevealEntry[]) => void) | undefined;
    const observer = {
      disconnect: vi.fn(),
      observe: vi.fn(),
      unobserve: vi.fn(),
    };
    const createObserver: LandingRuntime["createObserver"] = (callback) => {
      reveal = callback;
      return observer;
    };
    const cleanup = initLanding(document, runtime({ createObserver }));
    const firstTarget = document.querySelector<HTMLElement>("[data-reveal]");

    if (firstTarget === null || reveal === undefined) throw new Error("Reveal fixture is missing");
    reveal([{ isIntersecting: true, target: firstTarget }]);

    expect(firstTarget.classList.contains("is-visible")).toBe(true);
    expect(observer.unobserve).toHaveBeenCalledWith(firstTarget);
    cleanup();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
