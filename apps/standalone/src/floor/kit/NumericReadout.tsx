/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import { Fragment } from "react";

import { groupDigits } from "./numeric-entry.js";
import "./floor-controls.css";

export interface NumericReadoutProps {
  label: string;
  /** Beside the label: «необязательно», «из товара». */
  note?: string;
  /** The digit string; grouped here by thin spaces. */
  value: string;
  unit: string;
  /** `null`: the only field (nothing to choose); else whether this field takes the keypad. */
  active: boolean | null;
  onSelect?: () => void;
  /** The id of the error line, when the field has an error. */
  errorId?: string;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * The value window of the keypad: a plain bordered field (2 px `fg` border
 * only while it is the active one), not a text input, so no caret and no
 * soft keyboard take the scanner's keys. With two fields a tap chooses which
 * one the keypad edits.
 */
export function NumericReadout({
  label,
  note,
  value,
  unit,
  active,
  onSelect,
  errorId,
  invalid = false,
  disabled = false,
}: NumericReadoutProps) {
  const groups = groupDigits(value, " ").split(" ");
  return (
    <button
      type="button"
      className="floor-readout"
      data-active={active === false ? undefined : "true"}
      {...(active === null ? {} : { "aria-pressed": active })}
      {...(invalid ? { "aria-invalid": true } : {})}
      {...(errorId === undefined ? {} : { "aria-describedby": errorId })}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="floor-readout__label">
        <span>{label}</span>
        {note !== undefined && <em>{note}</em>}
      </span>
      <span className="floor-readout__value">
        {value === "" ? (
          <span className="floor-readout__empty" aria-hidden="true">
            —
          </span>
        ) : (
          <span className="floor-readout__digits">
            {groups.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="floor-readout__thin" aria-hidden="true" />}
                {group}
              </Fragment>
            ))}
          </span>
        )}
        <span className="floor-readout__unit">{unit}</span>
      </span>
    </button>
  );
}
