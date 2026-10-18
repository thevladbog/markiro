import { useLayoutEffect, useEffect, useRef } from "react";

import { VIEW_GUARD_MS } from "../print/LabelPanel.js";

/** Milliseconds from a clock that does not go back; the guard after a change of view reads it. */
export const realClock = () => performance.now();

/**
 * The guard against a second tap (the label panel's, the exceptions' and the shift
 * close's): a press is ignored for `VIEW_GUARD_MS` after the screen changed its view.
 * The second tap of a gloved double tap lands on whatever the new view put under the
 * finger — after «Отправить» that is «Повторить отправку» of the job just failed, which
 * would print a label that may have left. The focus goes to the view itself, never to
 * a button. `clock` must be the same function from one render to the next: a new one
 * starts the guard again.
 */
export function useViewGuard<T extends HTMLElement>(view: string, clock: () => number) {
  const changedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const viewRef = useRef<T>(null);
  useLayoutEffect(() => {
    changedAt.current = clock();
  }, [view, clock]);
  useEffect(() => {
    viewRef.current?.focus();
  }, [view]);
  /** Whether a press now is the operator's own and not the second of a double tap. */
  const settled = () => {
    const since = clock() - changedAt.current;
    return !(since >= 0 && since < VIEW_GUARD_MS);
  };
  return { viewRef, settled };
}
