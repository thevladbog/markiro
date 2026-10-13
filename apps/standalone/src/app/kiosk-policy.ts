import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** What a second launch with `--windowed` sends (`window_policy::KIOSK_PERMITTED_EVENT`). */
export const KIOSK_PERMITTED_EVENT = "standalone://kiosk-permitted";

/**
 * What the shell permits of kiosk mode on this PC (`src-tauri/src/window_policy.rs`):
 * the role, `"kiosk": false` in `installation.json` and the `--windowed`
 * launch. Every member is a function-typed property, safe to pass unbound.
 */
export interface KioskPolicyApi {
  /**
   * Whether kiosk mode may lock this PC. An answer the shell cannot give reads
   * as `true`: the role and the station's configuration still decide, and a
   * station's floor stays on the safe side.
   */
  permitted: () => Promise<boolean>;
  /** Calls `listener` when a second launch with `--windowed` turned kiosk mode off. */
  onTurnedOff: (listener: () => void) => Promise<() => void>;
}

export function createTauriKioskPolicy(): KioskPolicyApi {
  return {
    permitted: async () => {
      try {
        const answer: unknown = await invoke("kiosk_permitted_now", {});
        return answer !== false;
      } catch {
        return true;
      }
    },
    onTurnedOff: async (listener) => {
      try {
        return await listen<unknown>(KIOSK_PERMITTED_EVENT, (event) => {
          if (event.payload === false) listener();
        });
      } catch {
        // No shell event channel (outside the application): nothing to hear.
        return () => undefined;
      }
    },
  };
}
