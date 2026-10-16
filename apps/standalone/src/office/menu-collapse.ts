/** Below this window width the menu is icons only, until the user opens it. */
export const AUTO_COLLAPSE_BELOW = 1366;

/**
 * Whether the menu is collapsed to its icons. The user's own choice (`override`: `true` collapsed,
 * `false` open) wins; without one, a window narrower than `AUTO_COLLAPSE_BELOW` collapses it, so the
 * office and the station fit one 1280 x 800 screen. A width of 0 is an unmeasured window (a test,
 * a first paint): it counts as a wide one.
 */
export function isMenuCollapsed(width: number, override: boolean | null): boolean {
  if (override !== null) return override;
  return width > 0 && width < AUTO_COLLAPSE_BELOW;
}
