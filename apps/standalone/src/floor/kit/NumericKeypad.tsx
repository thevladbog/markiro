/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import type { MouseEvent } from "react";

import { appendDigit, dropDigit, type KeypadKey } from "./numeric-entry.js";
import "./floor-controls.css";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

interface NumericKeypadBase {
  disabled?: boolean;
  ariaLabel: string;
  clearLabel: string;
  backspaceLabel: string;
}

/** One entry the keypad edits: it is told the next value. */
interface NumericKeypadValue extends NumericKeypadBase {
  /** The entry as a digit string. */
  value: string;
  onChange: (next: string) => void;
  /** The entry takes no more digits than this. */
  maxLength: number;
  /** A code, not a quantity: «0» may open the entry (a personnel number, a PIN). */
  leadingZero?: boolean;
  onKey?: undefined;
}

/** A screen with rules of its own (two fields, one keypad): it is told each key. */
interface NumericKeypadKeys extends NumericKeypadBase {
  onKey: (key: KeypadKey) => void;
}

export type NumericKeypadProps = NumericKeypadValue | NumericKeypadKeys;

/** A tap must not move the focus to the key: the scanner's closing Enter would press it. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The flat 3 x 4 keypad of the kit: 1–9, «Очистить», 0, backspace. Controlled
 * and button-only (no text field), so it never takes a scanner's input; the
 * keys stay at 72 px and grow with the room the grid gives them.
 */
export function NumericKeypad(props: NumericKeypadProps) {
  const { disabled = false, ariaLabel, clearLabel, backspaceLabel } = props;
  const press = (key: KeypadKey) => {
    if (props.onKey !== undefined) {
      props.onKey(key);
      return;
    }
    const { value, onChange, maxLength, leadingZero = false } = props;
    if (key.kind === "digit") onChange(appendDigit(value, key.digit, maxLength, leadingZero));
    else onChange(key.kind === "clear" ? "" : dropDigit(value));
  };
  const key = (digit: string) => (
    <button
      key={digit}
      type="button"
      className="floor-keypad__key"
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={() => press({ kind: "digit", digit })}
    >
      {digit}
    </button>
  );
  return (
    <div role="group" aria-label={ariaLabel} className="floor-keypad">
      {DIGITS.map(key)}
      <button
        type="button"
        className="floor-keypad__key floor-keypad__key--fn"
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={() => press({ kind: "clear" })}
      >
        {clearLabel}
      </button>
      {key("0")}
      <button
        type="button"
        className="floor-keypad__key floor-keypad__key--fn"
        aria-label={backspaceLabel}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={() => press({ kind: "backspace" })}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <path
            d="M12 6h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H12L3 16l9-10Zm5 6.5 7 7m0-7-7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
