import { useCallback, useRef, type KeyboardEvent } from "react";

/**
 * Digits typed on the floor's keypad or a keyboard, as the form's digit string
 * (design kit 2026-10, step B). The string stays bare ("1200"): thin-space
 * grouping belongs to the readout only, and the form's own rules
 * (`plannedQtyRule`, `shiftBoxCapacityRule`) still judge it at «Далее».
 */

/** `value` with `digit` appended: nothing for a non-digit, a leading zero or a full entry. */
export function appendDigit(value: string, digit: string, maxLength: number): string {
  if (!/^[0-9]$/.test(digit)) return value;
  if (value === "" && digit === "0") return value;
  if (value.length >= maxLength) return value;
  return value + digit;
}

/** `value` without its last digit. */
export function dropDigit(value: string): string {
  return value.slice(0, -1);
}

/** The digits in groups of three, split by `separator` (a narrow no-break space): "1200" -> "1 200". */
export function groupDigits(value: string, separator = "\u202f"): string {
  return value.replace(/\B(?=(?:[0-9]{3})+$)/g, separator);
}

/** A hardware scanner types its digits faster than a hand can: under this, two keys are one scan. */
export const SCAN_KEY_GAP_MS = 40;
/** A scan's closing Enter follows its last digit within this. */
export const SCAN_END_GAP_MS = 300;

export interface KeyboardDigitsOptions {
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  disabled?: boolean;
  /** Milliseconds; tests give their own. */
  clock?: () => number;
}

/**
 * A `keydown` handler for the area of the keypad: digits, Backspace and Delete
 * («Очистить») of a physical keyboard edit the entry, as the keys do. A wedge
 * scanner is a keyboard too, so a run of digits typed faster than
 * `SCAN_KEY_GAP_MS` is a scan, not typing: the digits it had already entered
 * are taken back, the rest is dropped, and its closing Enter does not press
 * the focused key. Keys with Ctrl, Alt or Meta are shortcuts and are left alone.
 */
export function useKeyboardDigits({
  value,
  onChange,
  maxLength,
  disabled = false,
  clock = () => performance.now(),
}: KeyboardDigitsOptions): (event: KeyboardEvent) => void {
  const latest = useRef({ value, onChange, maxLength, disabled, clock });
  latest.current = { value, onChange, maxLength, disabled, clock };
  const chain = useRef({ at: Number.NEGATIVE_INFINITY, before: "", scan: false });
  return useCallback((event: KeyboardEvent) => {
    const {
      value: now,
      onChange: change,
      maxLength: max,
      disabled: off,
      clock: time,
    } = latest.current;
    if (off || event.ctrlKey || event.altKey || event.metaKey) return;
    const at = time();
    const state = chain.current;
    const gap = at - state.at;
    if (event.key === "Enter") {
      if (state.scan && gap < SCAN_END_GAP_MS) event.preventDefault();
      state.scan = false;
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      change(dropDigit(now));
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      change("");
      return;
    }
    if (!/^[0-9]$/.test(event.key)) return;
    event.preventDefault();
    if (state.scan && gap < SCAN_END_GAP_MS) {
      state.at = at;
      return;
    }
    if (gap < SCAN_KEY_GAP_MS) {
      state.scan = true;
      state.at = at;
      change(state.before);
      return;
    }
    state.scan = false;
    state.at = at;
    state.before = now;
    change(appendDigit(now, event.key, max));
  }, []);
}
