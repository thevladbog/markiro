/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import type { MouseEvent, ReactNode } from "react";

import "./floor-controls.css";

export type EntryFieldStatus = "empty" | "active" | "accepted" | "filled" | "error" | "locked";

export interface EntryFieldProps {
  /** Ties the label and the line under the field to it. */
  id: string;
  label: string;
  /** What has been typed; `shown` is what the field draws of it (dots for a PIN). */
  shown: string;
  /** The accessible name of the value (`aria-label` of the `output`). */
  valueLabel: string;
  status: EntryFieldStatus;
  /** In an empty field that does not hold the keypad. */
  placeholder: string;
  /** The line under the field: its rule while active, «Ошибка · …» on an error. */
  hint: string;
  /** In place of the value while the field is locked. */
  lockedText?: string;
  onSelect: () => void;
}

/** A tap on the field must not move the focus to it: a scan's closing Enter would press it. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

const ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

function statusIcon(status: EntryFieldStatus): ReactNode {
  if (status === "accepted") {
    return (
      <svg className="floor-entry__icon" data-icon="accepted" viewBox="0 0 32 32" {...ICON}>
        <circle cx="16" cy="16" r="12" />
        <path d="m10.5 16.5 3.8 3.8 7.2-8" />
      </svg>
    );
  }
  if (status === "locked") {
    return (
      <svg className="floor-entry__icon" data-icon="locked" viewBox="0 0 32 32" {...ICON}>
        <rect x="6" y="14" width="20" height="13" rx="3" />
        <path d="M10.5 14v-3.5a5.5 5.5 0 0 1 11 0V14" />
      </svg>
    );
  }
  return null;
}

/**
 * One of the sign-in's two fields (design kit 2026-10): a label above, a 84 px field that says
 * its state in more than colour (the active one is ringed 2 px `fg` with a still caret, an
 * accepted one carries a tick, a refused one «Ошибка ·» and a 2 px `err` border, a locked one a
 * padlock), and a line under it that is always there, so the next field does not move when the
 * keypad does. It is a button, not a text input, so no caret and no soft keyboard take the
 * scanner's keys; a tap chooses the field the one keypad edits.
 */
export function EntryField({
  id,
  label,
  shown,
  valueLabel,
  status,
  placeholder,
  hint,
  lockedText,
  onSelect,
}: EntryFieldProps) {
  const locked = status === "locked";
  const empty = shown === "";
  const text =
    locked && lockedText !== undefined ? lockedText : status === "active" ? "—" : placeholder;
  return (
    <div className="floor-entry" data-status={status}>
      <span className="floor-entry__label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="floor-entry__box"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        aria-pressed={status === "active"}
        {...(status === "error" ? { "aria-invalid": true } : {})}
        disabled={locked}
        onMouseDown={keepFocus}
        onClick={onSelect}
      >
        <output className="floor-entry__value" aria-label={valueLabel}>
          {shown}
        </output>
        {(empty || locked) && (
          <span className="floor-entry__placeholder" aria-hidden="true">
            {text}
          </span>
        )}
        {statusIcon(status)}
      </button>
      <span className="floor-entry__hint" id={`${id}-hint`}>
        {hint}
      </span>
    </div>
  );
}
