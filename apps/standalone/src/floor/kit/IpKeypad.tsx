/* eslint-disable no-restricted-syntax -- a kit control: this file IS the floor's own button of its kind, drawn by floor-controls.css (test/floor-controls.test.ts keeps native buttons to this directory). */
import type { MouseEvent } from "react";

import { Button } from "@markiro/ui";

import { appendKey, eraseKey, hasDotKey, type IpTarget } from "./ip-entry.js";
import { ModeSegment } from "./ModeSegment.js";
import "./floor-controls.css";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export interface IpKeypadProps {
  /** What the keys type now. */
  target: IpTarget;
  /** The targets the header segment offers (the address and the port; the baud rate alone has none). */
  targets: readonly { value: IpTarget; label: string }[];
  onTargetChange: (target: IpTarget) => void;
  /** The text of the target's field. */
  value: string;
  onChange: (next: string) => void;
  /** The panel's group name for a reader, and the segment's. */
  ariaLabel: string;
  segmentLabel: string;
  eraseLabel: string;
  /** The panel's action: «Далее: порт» (primary) at the address, «Закрыть клавиатуру» at the port. */
  actionLabel: string;
  onAction: () => void;
  actionPrimary?: boolean;
  actionDisabled?: boolean;
}

/** A tap must not move the focus off the field: the keys type into it, a scanner's Enter must not press a key. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The side panel of the printer form (380 px): a segment that says which field is typed into, a
 * 3 x 4 keypad (0–9, «.» and «Стереть», 113 x 64 px with a `linectl` edge) and one 84 px action.
 * It is an addition to the fields, never a replacement: they stay plain inputs, so a hardware
 * keyboard and a paste work as always, and the keys go through the same `onChange`. The «.» cell
 * stays, empty, where the target takes digits only, so the keys never move.
 */
export function IpKeypad({
  target,
  targets,
  onTargetChange,
  value,
  onChange,
  ariaLabel,
  segmentLabel,
  eraseLabel,
  actionLabel,
  onAction,
  actionPrimary = false,
  actionDisabled = false,
}: IpKeypadProps) {
  const key = (character: string) => (
    <button
      key={character}
      type="button"
      className="floor-ipkeypad__key"
      onMouseDown={keepFocus}
      onClick={() => onChange(appendKey(value, character, target))}
    >
      {character}
    </button>
  );
  return (
    <div role="group" aria-label={ariaLabel} className="floor-ipkeypad">
      {targets.length > 1 && (
        <ModeSegment
          label={segmentLabel}
          hideLabel
          reserveHint={false}
          options={targets}
          value={target}
          onChange={onTargetChange}
        />
      )}
      <div className="floor-ipkeypad__keys">
        {DIGITS.map(key)}
        {hasDotKey(target) ? (
          key(".")
        ) : (
          <span className="floor-ipkeypad__gap" aria-hidden="true" />
        )}
        {key("0")}
        <button
          type="button"
          className="floor-ipkeypad__key floor-ipkeypad__key--fn"
          onMouseDown={keepFocus}
          onClick={() => onChange(eraseKey(value))}
        >
          {eraseLabel}
        </button>
      </div>
      <Button
        size="floor"
        variant={actionPrimary ? "primary" : "secondary"}
        className={actionPrimary ? "floor-primary floor-ipkeypad__action" : "floor-ipkeypad__action"}
        disabled={actionDisabled}
        onMouseDown={keepFocus}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  );
}
