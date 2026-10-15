import { createContext, useContext } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";

/**
 * What «Отвязать станцию» (beta 3) needs from the app, handed down by `App`
 * through a context so that «Рабочее место» mounts the component without
 * carrying props: the station's database and pairing, who is signed in, the
 * scan source and its mute for the badge re-confirmation, and the three things
 * only the app can do — count what is unsent, ask whether the pairing still
 * owes a restored host its blocks, and forget the pairing (the existing
 * `device_forget`, then back to the pairing screens).
 */
export interface UnpairApi {
  local: LocalExecutor;
  pairing: Pairing;
  /** The operator signed in: only their own proof confirms. */
  operatorId: string | null;
  /** An operator works in a shift: nothing may be forgotten under it. */
  inShift: boolean;
  source: ScanSource;
  onMute: (muted: boolean) => void;
  /** Records without a receipt of this pairing; `null` when they cannot be counted. */
  countUnsent: () => Promise<number | null>;
  /** The pairing still owes a restored host its SSCC blocks (plan РК-С). */
  owesBlocks: () => Promise<boolean>;
  /** `device_forget`; with `keepUnsent` the unsent records stay on the disk. Rejects with a `DeviceError`. */
  forget: (keepUnsent: boolean) => Promise<void>;
  now?: () => number;
}

export const UnpairContext = createContext<UnpairApi | null>(null);

export function useUnpair(): UnpairApi | null {
  return useContext(UnpairContext);
}
