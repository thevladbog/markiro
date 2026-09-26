import { lightingAt, timeOfDayAt } from "./lighting";
import { chooseTier, createFrameBudget, QUALITY_TIERS, type QualityTier } from "./quality";
import { chapterAt, filmTimeFromLayout, type SectionBox } from "./timeline";
import type { WorldHandle } from "./world/runtime";

export interface FilmRuntime {
  readonly reducedMotion: boolean;
  readonly webgl: boolean;
  readonly tier: QualityTier;
  /** When false, slow frames never switch the page back to the posters. */
  readonly frameBudget: boolean;
  viewportHeight(): number;
  devicePixelRatio(): number;
  requestFrame(callback: (now: number) => void): void;
  listen(type: "scroll" | "resize", listener: () => void): () => void;
  onFirstInteraction(listener: () => void): () => void;
  loadWorld(canvas: HTMLCanvasElement, tier: QualityTier): Promise<WorldHandle>;
}

/** Samples longer than this are a hidden tab or a stall; they count as one very slow frame. */
const MAX_FRAME_SAMPLE_MS = 1000;

export function initFilm(root: Document, runtime: FilmRuntime): () => void {
  const film = root.querySelector<HTMLElement>("[data-film]");
  const canvas = root.querySelector<HTMLCanvasElement>("[data-film-canvas]");
  if (film === null || canvas === null) return () => undefined;
  const sections = [...film.querySelectorAll<HTMLElement>("[data-film-chapter]")];
  if (sections.length === 0) return () => undefined;
  const themed = [film, ...root.querySelectorAll<HTMLElement>("[data-film-chrome]")];
  const rail = film.querySelector<HTMLElement>("[data-film-rail]");
  const railLinks = [...film.querySelectorAll<HTMLAnchorElement>("[data-film-rail] a")];
  const budget = createFrameBudget();
  const cleanups: (() => void)[] = [];
  let world: WorldHandle | null = null;
  let pending = false;
  let lastFilmTime = Number.NaN;
  let lastChapter = -1;
  let railShown: boolean | null = null;
  let measuredMs = 0;
  let warmUpPending = true;
  let disposed = false;

  const stopWorld = (): void => {
    world?.dispose();
    world = null;
    film.classList.remove("film--live");
  };

  const resizeWorld = (): void => {
    world?.resize(canvas.clientWidth, canvas.clientHeight, runtime.devicePixelRatio());
    lastFilmTime = Number.NaN;
  };

  // Each render asks for one more animation frame; the gap between the two callbacks is how
  // long the rendered frame held the page. The budget window advances by measured frame time
  // only, so reading pauses between scrolls do not count, and the first frame after loading
  // (shader compilation) is skipped.
  const measure =
    (renderedAt: number) =>
    (now: number): void => {
      if (world === null) return;
      if (warmUpPending) {
        warmUpPending = false;
        return;
      }
      const frameMs = Math.min(now - renderedAt, MAX_FRAME_SAMPLE_MS);
      measuredMs += frameMs;
      if (budget.push(frameMs, measuredMs) === "too-slow") stopWorld();
    };

  const update = (now: number): void => {
    pending = false;
    if (disposed) return;
    const boxes: SectionBox[] = sections.map((section) => {
      const rect = section.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    const filmTime = filmTimeFromLayout(boxes, runtime.viewportHeight());
    const { index } = chapterAt(filmTime, sections.length);
    const theme = lightingAt(timeOfDayAt(filmTime)).uiTheme;
    for (const element of themed) {
      if (element.dataset.theme !== theme) element.dataset.theme = theme;
    }
    if (index !== lastChapter) {
      lastChapter = index;
      film.dataset.chapter = String(index + 1);
      railLinks.forEach((link, linkIndex) => {
        if (linkIndex === index) link.setAttribute("aria-current", "step");
        else link.removeAttribute("aria-current");
      });
    }
    // Once the film has scrolled past (the demo section below has taken over the viewport),
    // the rail must leave with it: it stays fixed, so a stale visible rail would paint under
    // the next section and keep tab order walking through links nobody can see.
    const showRail = index > 0 && film.getBoundingClientRect().bottom > runtime.viewportHeight();
    if (showRail !== railShown) {
      railShown = showRail;
      rail?.classList.toggle("is-visible", showRail);
    }
    if (world === null || filmTime === lastFilmTime) return;
    world.render(filmTime);
    lastFilmTime = filmTime;
    film.dataset.filmTime = filmTime.toFixed(3);
    if (runtime.frameBudget) runtime.requestFrame(measure(now));
  };

  const schedule = (): void => {
    if (pending) return;
    pending = true;
    runtime.requestFrame(update);
  };

  cleanups.push(
    runtime.listen("scroll", schedule),
    runtime.listen("resize", () => {
      resizeWorld();
      schedule();
    }),
  );

  if (!runtime.reducedMotion && runtime.webgl) {
    cleanups.push(
      runtime.onFirstInteraction(() => {
        void runtime
          .loadWorld(canvas, runtime.tier)
          .then((handle) => {
            if (disposed) {
              handle.dispose();
              return;
            }
            world = handle;
            resizeWorld();
            film.classList.add("film--live");
            schedule();
          })
          .catch((error: unknown) => {
            // The posters already tell the story; leave a trace for debugging.
            console.warn("Markiro film: the 3D stage is unavailable, keeping the posters", error);
            stopWorld();
          });
      }),
    );
  }

  schedule();
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    stopWorld();
  };
}

export function browserFilmRuntime(browserWindow: Window & typeof globalThis): FilmRuntime {
  const matches = (query: string): boolean => browserWindow.matchMedia(query).matches;
  const hardware: Navigator & { readonly deviceMemory?: number } = browserWindow.navigator;
  // Poster renders pin the tier and keep slow software frames: ?film-tier=high&film-budget=off
  const params = new URL(browserWindow.location.href).searchParams;
  const pinnedTier = QUALITY_TIERS.find((tier) => tier === params.get("film-tier"));
  return {
    reducedMotion: matches("(prefers-reduced-motion: reduce)"),
    webgl: typeof browserWindow.WebGL2RenderingContext === "function",
    tier:
      pinnedTier ??
      chooseTier({
        coarsePointer: matches("(pointer: coarse)"),
        deviceMemory: hardware.deviceMemory ?? null,
        cores: hardware.hardwareConcurrency > 0 ? hardware.hardwareConcurrency : null,
      }),
    frameBudget: params.get("film-budget") !== "off",
    viewportHeight: () => browserWindow.innerHeight,
    devicePixelRatio: () => browserWindow.devicePixelRatio || 1,
    requestFrame: (callback) => {
      browserWindow.requestAnimationFrame(callback);
    },
    listen: (type, listener) => {
      browserWindow.addEventListener(type, listener, { passive: true });
      return () => {
        browserWindow.removeEventListener(type, listener);
      };
    },
    onFirstInteraction: (listener) => {
      const events = ["scroll", "wheel", "pointerdown", "touchstart", "keydown"] as const;
      const remove = (): void => {
        for (const type of events) browserWindow.removeEventListener(type, handle);
      };
      const handle = (): void => {
        remove();
        listener();
      };
      for (const type of events) browserWindow.addEventListener(type, handle, { passive: true });
      return remove;
    },
    loadWorld: async (canvas, tier) => {
      const { startWorld } = await import("./world/runtime");
      return startWorld(canvas, tier);
    },
  };
}
