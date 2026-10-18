/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import { useId, useRef, type KeyboardEvent } from "react";

import "./floor-controls.css";

export interface ModeOption<T extends string> {
  value: T;
  label: string;
}

export interface ModeSegmentProps<T extends string> {
  /** The visible, group-naming caption: «Режим работы». */
  label: string;
  options: readonly ModeOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** One line under the group, said politely when the choice changes. */
  hint?: string;
  disabled?: boolean;
  /** The caption names the group for a reader and is not drawn (a segment that is a header of its panel). */
  hideLabel?: boolean;
  /** Keep a line of its own height for the hint when there is none (the default: groups below never jump). */
  reserveHint?: boolean;
}

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="floor-segmented__check"
    >
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The kit's segmented control as a radio group: a labelled caption, two (or
 * more) options at 64 px, the selected one a `fg` fill with a check and weight
 * 600. One tab stop; the arrows move the choice, as radios do.
 */
export function ModeSegment<T extends string>({
  label,
  options,
  value,
  onChange,
  hint,
  disabled = false,
  hideLabel = false,
  reserveHint = true,
}: ModeSegmentProps<T>) {
  const labelId = useId();
  const hintId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, from: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const target = (from + step + options.length) % options.length;
    const option = options[target];
    if (option === undefined) return;
    onChange(option.value);
    refs.current[target]?.focus();
  };
  return (
    <div className="floor-mode">
      <p
        id={labelId}
        className={hideLabel ? "floor-mode__label floor-mode__label--hidden" : "floor-mode__label"}
      >
        {label}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        {...(hint === undefined ? {} : { "aria-describedby": hintId })}
        className="floor-segmented"
      >
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="floor-segmented__option"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => move(event, index)}
            >
              {checked && <Check />}
              {option.label}
            </button>
          );
        })}
      </div>
      {(reserveHint || hint !== undefined) && (
        <p id={hintId} className="floor-mode__hint" aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  );
}
