import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import {
  minCollapseLevel,
  nextCollapseLevel,
  type BarMeasure,
  type CollapseLevel,
  type HeaderScreen,
} from "./header-chips.js";

/** The natural width of the identity's longer row (its texts, as they would be uncut). */
function identityWidth(bar: HTMLElement): number {
  let widest = 0;
  for (const row of bar.querySelectorAll<HTMLElement>(".station-status-identity__row")) {
    const texts = [...row.querySelectorAll<HTMLElement>("dd")];
    // The separators (`·` and the gap round it) are about 20 px a join.
    const width = texts.reduce((sum, text) => sum + text.scrollWidth, 0) + 20 * (texts.length - 1);
    widest = Math.max(widest, width);
  }
  return widest;
}

function measureBar(bar: HTMLElement): BarMeasure {
  const rail = bar.querySelector<HTMLElement>(".floor-bar__rail");
  const style = getComputedStyle(bar);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const gap = padding + (parseFloat(style.columnGap) || 0);
  return {
    barWidth: bar.clientWidth,
    railWidth: rail === null ? 0 : rail.offsetWidth,
    identityWidth: identityWidth(bar),
    gap,
  };
}

/**
 * How far the one-row header has collapsed (`header-chips`): healthy chips lose their words, then
 * «Сменить оператора» becomes an icon; the station's name is cut by CSS after that. It climbs one
 * step per measurement while the row overflows and starts again from the screen's minimum when the
 * window's width or what the row says changes, so the row opens up again as soon as it fits. A
 * browser with no layout (a test's DOM) measures zeros and keeps the minimum.
 */
export function useHeaderCollapse(
  screen: HeaderScreen,
  content: string,
): { ref: RefObject<HTMLElement | null>; level: CollapseLevel } {
  const ref = useRef<HTMLElement | null>(null);
  const min = minCollapseLevel(screen);
  const [level, setLevel] = useState<CollapseLevel>(min);
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);

  useEffect(() => {
    const bar = ref.current;
    if (bar === null) return undefined;
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setWidth(bar.clientWidth));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // The text's widths change when the bundled fonts arrive.
    if (typeof document === "undefined" || document.fonts === undefined) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFonts((count) => count + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Start again from the minimum when the window or the content changed.
  useLayoutEffect(() => {
    setLevel(min);
  }, [min, content, width, fonts]);

  // Climb while the row still overflows: after every step, and after every restart above. A
  // settled level changes nothing, so it stops by itself at the last step.
  useLayoutEffect(() => {
    const bar = ref.current;
    if (bar === null) return;
    const measure = measureBar(bar);
    setLevel((current) => nextCollapseLevel(current, measure, min));
  }, [level, min, content, width, fonts]);

  return { ref, level };
}
