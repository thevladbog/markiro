/**
 * Map hotspots show their tooltip on hover and focus through CSS. Escape hides the tooltip the
 * visitor is on (WCAG 1.4.13); leaving the hotspot with the pointer or focus brings it back.
 */
export function initHomeMap(root: Document): () => void {
  const spots = [...root.querySelectorAll<HTMLElement>("[data-map-spot]")];
  const cleanups: (() => void)[] = [];

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    for (const spot of spots) {
      if (spot.matches(":hover") || spot.contains(root.activeElement)) {
        spot.setAttribute("data-dismissed", "");
      }
    }
  };
  root.addEventListener("keydown", onKeyDown);
  cleanups.push(() => root.removeEventListener("keydown", onKeyDown));

  for (const spot of spots) {
    const reset = (): void => spot.removeAttribute("data-dismissed");
    spot.addEventListener("pointerleave", reset);
    spot.addEventListener("focusout", reset);
    cleanups.push(() => {
      spot.removeEventListener("pointerleave", reset);
      spot.removeEventListener("focusout", reset);
    });
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
