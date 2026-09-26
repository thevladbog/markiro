// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { initFilm, type FilmRuntime } from "./film";
import type { WorldHandle } from "./world/runtime";

const VIEWPORT = 1000;
const SPANS = [2.6, 1.3, 1.3, 1.35, 1.45, 1.35, 1.6];
const FILM_HEIGHT = SPANS.reduce((sum, span) => sum + span * VIEWPORT, 0);
const TOTAL_SCROLL = FILM_HEIGHT - VIEWPORT;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountFilm() {
  document.body.innerHTML = `
    <div data-film-chrome data-theme="light"></div>
    <div data-film data-theme="light">
      <canvas data-film-canvas></canvas>
      ${SPANS.map((_, index) => `<section data-film-chapter id="c${index}"></section>`).join("")}
      <nav data-film-rail>${SPANS.map((_, index) => `<a href="#c${index}">${index}</a>`).join("")}</nav>
    </div>`;
  let scrollY = 0;
  let start = 0;
  const film = document.querySelector("[data-film]") as HTMLElement;
  film.getBoundingClientRect = () =>
    ({ top: -scrollY, height: FILM_HEIGHT, bottom: FILM_HEIGHT - scrollY }) as DOMRect;
  for (const [index, section] of [
    ...document.querySelectorAll<HTMLElement>("[data-film-chapter]"),
  ].entries()) {
    const top = start;
    const height = (SPANS[index] ?? 0) * VIEWPORT;
    section.getBoundingClientRect = () => ({ top: top - scrollY, height }) as DOMRect;
    start += height;
  }
  return {
    film,
    chrome: document.querySelector("[data-film-chrome]") as HTMLElement,
    scrollTo: (y: number) => {
      scrollY = y;
    },
  };
}

function fakeRuntime(overrides: Partial<FilmRuntime> = {}) {
  const frames: ((now: number) => void)[] = [];
  const listeners = new Map<string, () => void>();
  let interaction: (() => void) | null = null;
  let clock = 0;
  const renders: number[] = [];
  const world = {
    render: (time: number) => {
      renders.push(time);
    },
    resize: vi.fn(),
    dispose: vi.fn(),
  } satisfies WorldHandle;
  const loadWorld = vi.fn(() => Promise.resolve<WorldHandle>(world));
  const runtime: FilmRuntime = {
    reducedMotion: false,
    webgl: true,
    tier: "high",
    frameBudget: true,
    viewportHeight: () => VIEWPORT,
    devicePixelRatio: () => 1,
    requestFrame: (callback) => {
      frames.push(callback);
    },
    listen: (type, listener) => {
      listeners.set(type, listener);
      return () => {
        listeners.delete(type);
      };
    },
    onFirstInteraction: (listener) => {
      interaction = listener;
      return () => {
        interaction = null;
      };
    },
    loadWorld,
    ...overrides,
  };
  return {
    runtime,
    world,
    renders,
    loadWorld,
    flush(stepMs = 16) {
      while (frames.length > 0) {
        clock += stepMs;
        frames.shift()?.(clock);
      }
    },
    wait: (ms: number) => {
      clock += ms;
    },
    scroll: () => listeners.get("scroll")?.(),
    interact: () => interaction?.(),
    hasListeners: () => listeners.size > 0 || interaction !== null,
  };
}

/** Thirty scroll steps, each rendered frame taking 120 ms. */
function scrollSlowly(fake: ReturnType<typeof fakeRuntime>, scrollTo: (y: number) => void): void {
  for (let step = 1; step <= 30; step += 1) {
    scrollTo(step * 40);
    fake.scroll();
    fake.flush(120);
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("film entry script", () => {
  it("loads the world only after the first interaction and renders film time", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    expect(fake.loadWorld).not.toHaveBeenCalled();
    fake.interact();
    await settle();
    fake.flush();
    expect(film.classList.contains("film--live")).toBe(true);
    expect(fake.renders.at(-1)).toBe(0);
    scrollTo(800);
    fake.scroll();
    fake.flush();
    expect(fake.renders.at(-1)).toBeCloseTo(0.5);
    expect(film.dataset.filmTime).toBe("0.500");
  });

  it("never loads the world with reduced motion", async () => {
    const { film } = mountFilm();
    const fake = fakeRuntime({ reducedMotion: true });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    expect(fake.loadWorld).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("keeps the posters and warns when the world fails to load", async () => {
    const { film } = mountFilm();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = fakeRuntime({ loadWorld: () => Promise.reject(new Error("no context")) });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    expect(film.classList.contains("film--live")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("marks the current chapter in the rail and hides the rail on chapter one", () => {
    const { scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    const rail = document.querySelector("[data-film-rail]");
    expect(rail?.classList.contains("is-visible")).toBe(false);
    scrollTo(2600 - VIEWPORT + 650);
    fake.scroll();
    fake.flush();
    expect(rail?.classList.contains("is-visible")).toBe(true);
    const links = [...document.querySelectorAll("[data-film-rail] a")];
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("hides the rail once the film has scrolled past", () => {
    const { scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    const rail = document.querySelector("[data-film-rail]");
    // Still inside the last chapter, with the film's bottom well below the viewport bottom.
    scrollTo(TOTAL_SCROLL - 500);
    fake.scroll();
    fake.flush();
    expect(rail?.classList.contains("is-visible")).toBe(true);
    // The film has scrolled past: its bottom (500 px) now sits above the viewport bottom.
    scrollTo(TOTAL_SCROLL + 500);
    fake.scroll();
    fake.flush();
    expect(rail?.classList.contains("is-visible")).toBe(false);
  });

  it("turns the film and the header chrome dark at night", () => {
    const { film, chrome, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    expect(film.dataset.theme).toBe("light");
    scrollTo(TOTAL_SCROLL);
    fake.scroll();
    fake.flush();
    expect(film.dataset.theme).toBe("dark");
    expect(chrome.dataset.theme).toBe("dark");
  });

  it("falls back to the posters when rendered frames stay slow", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush();
    scrollSlowly(fake, scrollTo);
    expect(fake.world.dispose).toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("keeps slow frames live when the budget is off", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime({ frameBudget: false });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush();
    scrollSlowly(fake, scrollTo);
    expect(fake.world.dispose).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(true);
  });

  it("cleans up listeners and the world", async () => {
    mountFilm();
    const fake = fakeRuntime();
    const cleanup = initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    cleanup();
    expect(fake.world.dispose).toHaveBeenCalled();
    expect(fake.hasListeners()).toBe(false);
  });

  it("never loads the world without WebGL", async () => {
    const { film } = mountFilm();
    const fake = fakeRuntime({ webgl: false });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    expect(fake.loadWorld).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("disposes a world that finishes loading after cleanup", async () => {
    const { film } = mountFilm();
    let finish: (handle: WorldHandle) => void = () => undefined;
    const fake = fakeRuntime({
      loadWorld: () =>
        new Promise<WorldHandle>((resolve) => {
          finish = resolve;
        }),
    });
    const cleanup = initFilm(document, fake.runtime);
    fake.interact();
    cleanup();
    finish(fake.world);
    await settle();
    expect(fake.world.dispose).toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("ignores the warm-up frame and reading pauses", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush(300);
    fake.wait(3000);
    for (let step = 1; step <= 150; step += 1) {
      scrollTo(step * 10);
      fake.scroll();
      fake.flush(16);
    }
    expect(fake.world.dispose).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(true);
  });

  it("counts a hidden-tab gap as one slow frame", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush();
    scrollTo(10);
    fake.scroll();
    fake.flush(16);
    scrollTo(20);
    fake.scroll();
    fake.flush(10_000);
    for (let step = 1; step <= 80; step += 1) {
      scrollTo(20 + step * 10);
      fake.scroll();
      fake.flush(16);
    }
    expect(fake.world.dispose).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(true);
  });
});
