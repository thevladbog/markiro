import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { bridge } from "./bridge.js";

export interface SignerUpdate {
  readonly version: string;
  readonly notes: string | null;
  /** Downloads, installs and relaunches. Only ever called from an operator action. */
  install: () => Promise<void>;
}

/** Once a day is often enough for a tray agent; the mirror changes far less. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns `null` both when there is no update and when the check failed. The
 * agent's job is to keep the tenant's token fresh; an unreachable mirror is a
 * reason to log and carry on, never a reason to stop.
 */
export async function checkForUpdate(): Promise<SignerUpdate | null> {
  try {
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      notes: found.body ?? null,
      install: async () => {
        await found.downloadAndInstall();
        await relaunch();
      },
    };
  } catch (error) {
    console.warn("signer update check failed", error);
    return null;
  }
}

/**
 * The tray tells the operator to open the window; the banner is where they
 * consent. An operator who decided to install later must not be told again on
 * every daily check, so each version is announced at most once per process.
 */
export async function announceUpdate(update: SignerUpdate, announced: Set<string>): Promise<void> {
  if (announced.has(update.version)) return;
  announced.add(update.version);
  try {
    await bridge.notifyUpdateAvailable(update.version);
  } catch (error) {
    // A tray that will not show is not a reason to hide the banner.
    console.warn("signer update notification failed", error);
  }
}
