/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import type { MouseEvent } from "react";

import { CYRILLIC_ROWS, eraseLetter, typeLetter, typeSpace } from "./cyrillic-keyboard.js";
import "./floor-controls.css";

export interface CyrillicKeyboardProps {
  /** The text of the field the keys write into. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  eraseLabel: string;
  spaceLabel: string;
}

/** A tap must not take the focus from the field it types into: it would end the typing. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The flat Cyrillic keyboard (kit control): ЙЦУКЕН in three rows, 64 px keys edged in `linectl`,
 * «Стереть» and «Пробел» beside the last row. Controlled and button-only; it replaces the
 * Windows on-screen keyboard, which covered half of the screen and was not the product's.
 */
export function CyrillicKeyboard({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  eraseLabel,
  spaceLabel,
}: CyrillicKeyboardProps) {
  return (
    <div role="group" aria-label={ariaLabel} className="floor-cyrillic">
      {CYRILLIC_ROWS.map((row, index) => (
        <div className="floor-cyrillic__row" key={row.join("")}>
          {row.map((letter) => (
            <button
              key={letter}
              type="button"
              className="floor-cyrillic__key"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => onChange(typeLetter(value, letter))}
            >
              {letter}
            </button>
          ))}
          {index === CYRILLIC_ROWS.length - 1 && (
            <>
              <button
                type="button"
                className="floor-cyrillic__key floor-cyrillic__key--fn floor-cyrillic__key--erase"
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => onChange(eraseLetter(value))}
              >
                {eraseLabel}
              </button>
              <button
                type="button"
                className="floor-cyrillic__key floor-cyrillic__key--fn floor-cyrillic__key--space"
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => onChange(typeSpace(value))}
              >
                {spaceLabel}
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
