import { canUseCategory, readConsent } from "../lib/consent";

export interface RevealEntry {
  readonly isIntersecting: boolean;
  readonly target: Element;
}

export interface LandingObserver {
  disconnect(): void;
  observe(target: Element): void;
  unobserve(target: Element): void;
}

export interface LandingRuntime {
  createObserver(callback: (entries: readonly RevealEntry[]) => void): LandingObserver;
  readonly reducedMotion: boolean;
  track(eventName: string, properties: Readonly<Record<string, string>>): void;
}

function analyticsProperties(element: HTMLElement): Readonly<Record<string, string>> {
  const placement = element.dataset.placement;
  return placement === undefined ? {} : { placement };
}

export function initLanding(root: Document, runtime: LandingRuntime): () => void {
  const trigger = root.querySelector<HTMLButtonElement>("[data-menu-trigger]");
  const menu = root.querySelector<HTMLElement>("[data-menu]");
  const revealTargets = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
  let observer: LandingObserver | null = null;

  root.documentElement.classList.add("motion-ready");

  const setMenuOpen = (open: boolean, restoreFocus = false): void => {
    trigger?.setAttribute("aria-expanded", String(open));
    trigger?.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
    menu?.classList.toggle("is-open", open);
    root.body.classList.toggle("menu-is-open", open);
    if (restoreFocus) trigger?.focus();
  };

  const onTriggerClick = (): void => {
    setMenuOpen(trigger?.getAttribute("aria-expanded") !== "true");
  };

  const onMenuClick = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest("a") !== null) {
      setMenuOpen(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && trigger?.getAttribute("aria-expanded") === "true") {
      setMenuOpen(false, true);
    }
  };

  const onAnalyticsClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const analyticsTarget = event.target.closest<HTMLElement>("[data-analytics]");
    const eventName = analyticsTarget?.dataset.analytics;
    if (analyticsTarget !== null && analyticsTarget !== undefined && eventName !== undefined) {
      runtime.track(eventName, analyticsProperties(analyticsTarget));
    }
  };

  trigger?.addEventListener("click", onTriggerClick);
  menu?.addEventListener("click", onMenuClick);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("click", onAnalyticsClick);

  if (runtime.reducedMotion) {
    for (const target of revealTargets) target.classList.add("is-visible");
  } else if (revealTargets.length > 0) {
    observer = runtime.createObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer?.unobserve(entry.target);
      }
    });
    for (const target of revealTargets) observer.observe(target);
  }

  return () => {
    trigger?.removeEventListener("click", onTriggerClick);
    menu?.removeEventListener("click", onMenuClick);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("click", onAnalyticsClick);
    observer?.disconnect();
  };
}

export function browserLandingRuntime(browserWindow: Window & typeof globalThis): LandingRuntime {
  return {
    createObserver: (callback) =>
      new browserWindow.IntersectionObserver((entries) => callback(entries), { threshold: 0.18 }),
    reducedMotion: browserWindow.matchMedia("(prefers-reduced-motion: reduce)").matches,
    track: (eventName, properties) => {
      if (!canUseCategory(readConsent(browserWindow.localStorage), "analytics")) return;
      browserWindow.dispatchEvent(
        new browserWindow.CustomEvent("markiro:analytics", {
          detail: { eventName, properties },
        }),
      );
    },
  };
}
