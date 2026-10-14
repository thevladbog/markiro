import type { ScanSource } from "./scan-source.js";

/**
 * A scan source the floor's screens read through, that can be muted while a
 * dialog asks for a badge itself (the identity re-confirmation, beta 3): the
 * dialog reads the unmuted `inner`, and the screens under it hear nothing, so
 * a badge is never taken for a product's code, nor a product's code for a
 * badge. Muting also drops the keys typed so far.
 */
export interface GatedScanSource {
  /** What the floor's screens read. */
  source: ScanSource;
  setMuted: (muted: boolean) => void;
}

export function createGatedScanSource(inner: ScanSource): GatedScanSource {
  let muted = false;
  return {
    source: {
      start: (listener) =>
        inner.start((raw) => {
          if (!muted) listener(raw);
        }),
      clearPendingInput: () => inner.clearPendingInput(),
      setManualTextEntryActive: (active) => inner.setManualTextEntryActive(active),
    },
    setMuted: (next) => {
      if (muted === next) return;
      muted = next;
      inner.clearPendingInput();
    },
  };
}
