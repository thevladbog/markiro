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

  const stopWorld = (): void => {
    world?.dispose();
    world = null;
    film.classList.remove("film--live");
  };

  const resizeWorld = (): void => {
    world?.resize(canvas.clientWidth, canvas.clientHeight, runtime.devicePixelRatio());
    lastFilmTime = Number.NaN;
  };

  // The next frame starts only after the rendered one is presented, so the gap
  // between the two callbacks is the real cost of the frame, GPU included.
  const measure =
    (renderedAt: number) =>
    (now: number): void => {
      if (world !== null && budget.push(now - renderedAt, now) === "too-slow") stopWorld();
    };

  const update = (now: number): void => {
    pending = false;
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
    film.dataset.chapter = String(index + 1);
    rail?.classList.toggle("is-visible", index > 0);
    railLinks.forEach((link, linkIndex) => {
      if (linkIndex === index) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    });
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
