/** A raw scan, as the scanner typed it, before anything trims or reads it. */
export type ScanListener = (raw: string) => void;

/**
 * Where scans come from (stage 1 spec §5.6): a keyboard-wedge scanner and the
 * COM scanners of the shell (plan 2a4). The sign-in screen, a new shift and
 * the work screen do not care which.
 */
export interface ScanSource {
  /** Begins delivering scans; returns the function that stops it. */
  start(listener: ScanListener): () => void;
  /** Drops the keys typed since the last Enter. */
  clearPendingInput(): void;
  /**
   * `true` while a text field takes typing (the name search): the keys are
   * the field's, not a scan, and Enter hands nothing over. Either way the
   * keys typed so far are dropped.
   */
  setManualTextEntryActive(active: boolean): void;
}

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/** The GS1 group separator a product's DataMatrix carries between its fields. */
const GROUP_SEPARATOR = "\u001d";

/**
 * A HID scanner is a keyboard: it types the code and presses Enter. This
 * source gathers single-character keys and hands them over on Enter,
 * skipping modifiers and navigation keys (their `key` is a name such as
 * «Shift» or «ArrowLeft»). Ported from the cloud station's
 * `createKeyboardWedgeSource` (`apps/station/src/lib/scan-source.ts`), with
 * the handling of modified keys added here: a scanner sends the GS1 group
 * separator as the control character Ctrl+], read as the separator itself
 * (so a product's code is told from a badge); every other key held with Ctrl
 * or Meta is a shortcut, not a scan, and is dropped; AltGr, which Windows
 * reports as Ctrl+Alt, types a character and is kept.
 */
export function createKeyboardWedgeSource(target: KeyTarget = window): ScanSource {
  const buffers = new Set<() => void>();
  let manualTextEntry = false;
  return {
    start(listener) {
      let payload = "";
      const clear = () => {
        payload = "";
      };
      buffers.add(clear);
      const onKeyDown = (event: Event) => {
        // Typing into a text field: no scan, and its Enter stays the field's.
        if (manualTextEntry) return;
        const { key, ctrlKey, altKey, metaKey } = event as KeyboardEvent;
        if (key === "Enter") {
          // The scan's closing Enter lands on whatever holds the focus, and a
          // focused button would also take it as a click. `preventDefault`
          // stops that; filtering by the event's target instead would drop
          // the scan itself, which is worse.
          event.preventDefault();
          if (payload.length > 0) listener(payload);
          payload = "";
          return;
        }
        if (ctrlKey && !altKey && key === "]") {
          payload += GROUP_SEPARATOR;
          return;
        }
        if ((ctrlKey || metaKey) && !altKey) return;
        if (key.length === 1) payload += key;
      };
      target.addEventListener("keydown", onKeyDown);
      return () => {
        clear();
        buffers.delete(clear);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
    clearPendingInput() {
      for (const clear of buffers) clear();
    },
    setManualTextEntryActive(active) {
      for (const clear of buffers) clear();
      manualTextEntry = active;
    },
  };
}

/**
 * The COM scanners the shell reads (`standalone://scan`, plan 2a4) as a scan
 * source: each frame as the scanner sent it, the group separator and the AIM
 * prefixes kept (the domain removes them). The subscription is the shell's
 * and asynchronous, so a source stopped before it answered drops it as soon
 * as it does. A failed subscription (no shell event channel, as outside the
 * application) leaves this source silent and the keyboard still scanning:
 * which COM ports read, and whether they are connected, the workstation's
 * setup shows (plan 2a7). While a text field takes typing, COM scans are
 * dropped as the keyboard's are.
 */
export function createComScanSource(
  subscribe: (listener: ScanListener) => Promise<() => void>,
): ScanSource {
  let manualTextEntry = false;
  return {
    start(listener) {
      let stopped = false;
      let unsubscribe: (() => void) | null = null;
      subscribe((raw) => {
        if (stopped || manualTextEntry || raw.length === 0) return;
        listener(raw);
      }).then(
        (stop) => {
          if (stopped) stop();
          else unsubscribe = stop;
        },
        () => undefined,
      );
      return () => {
        stopped = true;
        unsubscribe?.();
        unsubscribe = null;
      };
    },
    clearPendingInput() {
      // A COM frame arrives whole: nothing is pending between two scans.
    },
    setManualTextEntryActive(active) {
      manualTextEntry = active;
    },
  };
}

/**
 * Several sources as one: every scan of each reaches the one listener, and
 * stopping stops them all. The floor reads the keyboard and the COM scanners
 * at once (stage 2a spec, decision 25, chose one by the setup; plan 2a6 reads
 * both, so a station needs no setup to scan and a stray wedge scanner still
 * works next to a COM one).
 */
export function mergeScanSources(...sources: readonly ScanSource[]): ScanSource {
  return {
    start(listener) {
      const stops = sources.map((source) => source.start(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    clearPendingInput() {
      for (const source of sources) source.clearPendingInput();
    },
    setManualTextEntryActive(active) {
      for (const source of sources) source.setManualTextEntryActive(active);
    },
  };
}
