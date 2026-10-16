import { useId, type ReactNode } from "react";

import "./floor-controls.css";

export interface SwitchCardProps {
  title: string;
  /** A sentence under the title. */
  hint?: string;
  /** Under the hint, when it has something to say: «Шаблон: …». */
  detail?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The words of the state under the switch: «Включено» / «Выключено». */
  stateLabel: string;
  disabled?: boolean;
}

/**
 * One L1 card that is the switch: the whole card presses, on = a 2 px `fg`
 * border, a check in the knob and the state in words (never the colour alone).
 */
export function SwitchCard({
  title,
  hint,
  detail,
  checked,
  onChange,
  stateLabel,
  disabled = false,
}: SwitchCardProps) {
  const titleId = useId();
  const hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={titleId}
      {...(hint === undefined ? {} : { "aria-describedby": hintId })}
      className="floor-switch-card"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span id={titleId} className="floor-switch-card__title">
        {title}
      </span>
      {hint !== undefined && (
        <span id={hintId} className="floor-switch-card__hint">
          {hint}
        </span>
      )}
      {detail !== undefined && <span className="floor-switch-card__detail">{detail}</span>}
      <span className="floor-switch-card__state" aria-hidden="true">
        <span className="floor-switch-card__track">
          <span className="floor-switch-card__knob">
            <svg viewBox="0 0 24 24" focusable="false">
              <path
                d="m6 12.5 4 4L18 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </span>
        <span className="floor-switch-card__word">{stateLabel}</span>
      </span>
    </button>
  );
}
