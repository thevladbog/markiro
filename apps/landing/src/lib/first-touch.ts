/** Remove attribution saved by older landing builds. Request consent excludes it. */
export const FIRST_TOUCH_STORAGE_KEY = "markiro:first-touch";

export function clearLegacyFirstTouch(store: Pick<Storage, "removeItem">): void {
  try {
    store.removeItem(FIRST_TOUCH_STORAGE_KEY);
  } catch {
    // Storage may be blocked; no attribution is read, collected or submitted.
  }
}
