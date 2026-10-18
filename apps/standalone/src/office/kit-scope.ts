import { useEffect } from "react";

/** The kit's 2026 office sizing scope (`@markiro/ui` components.css). */
export const KIT_SCOPE_CLASS = "mk-kit-2026";

let holders = 0;

/**
 * Puts the opt-in 2026 sizing (44 px controls, radius 16/20, no card shadow) on `<html>` while an
 * office screen is mounted. It is the root and not a wrapper because dialogs, panels and select
 * lists are portalled to the document body: a class on the office's own container would leave them
 * at the old size. The floor, the wizard and the cloud apps never mount it. Counted, so the login
 * handing over to the office does not drop the class between the two.
 */
export function useKitScope(): void {
  useEffect(() => {
    holders += 1;
    document.documentElement.classList.add(KIT_SCOPE_CLASS);
    return () => {
      holders -= 1;
      if (holders === 0) document.documentElement.classList.remove(KIT_SCOPE_CLASS);
    };
  }, []);
}
