import { useId, type ChangeEvent, type KeyboardEvent } from "react";

export interface TouchRangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function steppedValue(value: number, delta: number, min: number, max: number, step: number) {
  const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
  return Number(Math.min(max, Math.max(min, value + delta * step)).toFixed(precision));
}

/** A native range input with a full-width floor target and visible numeric value. */
export function TouchRange({ label, value, min, max, step, disabled, onChange }: TouchRangeProps) {
  const inputId = useId();

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(Number(event.target.value));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = steppedValue(value, 1, min, max, step);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = steppedValue(value, -1, min, max, step);
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    }
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  }

  return (
    <div className="touch-range">
      <label className="touch-range__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="touch-range__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <output className="touch-range__value" htmlFor={inputId}>
        {value}
      </output>
    </div>
  );
}
