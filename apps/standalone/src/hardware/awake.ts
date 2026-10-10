import type { HardwareApi } from "./hardware.js";

/**
 * Keeping the computer awake while a shift's work screen is open (stage 2a
 * spec, decision 34, question В11): `hold()` while a screen needs it, and
 * the function it answers when the screen goes. The shell's request is
 * asked for on the first hold and let go after the last release, in the
 * order the screen asked — a release and a hold racing as one work screen
 * gives way to the next can never leave the computer asleep or awake by
 * mistake. A refusal of the shell is not the screen's concern: the work goes
 * on, and the manual Windows list checks `powercfg /requests`.
 */
export interface SystemAwake {
  /** Keeps the computer awake until the answered function is called (once; again is nothing). */
  hold: () => () => void;
  /**
   * Lets the computer sleep whatever was held: the app's start, which a
   * reload of the webview also is — the shell's request outlives the
   * webview that asked for it (plan 2a4's queued item 15).
   */
  reset: () => Promise<void>;
}

export function createSystemAwake(setSystemAwake: HardwareApi["setSystemAwake"]): SystemAwake {
  let holders = 0;
  // A reset forgets every hold before it: their releases ask nothing.
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();

  function ask(awake: boolean): Promise<void> {
    chain = chain.then(() => setSystemAwake(awake)).catch(() => undefined);
    return chain;
  }

  return {
    hold: () => {
      holders += 1;
      if (holders === 1) void ask(true);
      const heldIn = generation;
      let released = false;
      return () => {
        if (released || heldIn !== generation) return;
        released = true;
        holders -= 1;
        if (holders === 0) void ask(false);
      };
    },
    reset: () => {
      holders = 0;
      generation += 1;
      return ask(false);
    },
  };
}
