import type { CSSProperties } from "react";

import { cn } from "../cn.js";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onValueChange: (value: number) => void;
  "aria-label": string;
  "aria-valuetext"?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A range slider on the browser's own `range` control: the arrow keys, Home, End, Page keys and
 * `aria-valuenow` come with it, the token colours and the 40 px touch height are the kit's.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onValueChange,
  "aria-label": ariaLabel,
  "aria-valuetext": ariaValueText,
  className,
  style,
}: SliderProps) {
  return (
    <input
      type="range"
      className={cn("mk-slider", className)}
      style={style}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      {...(ariaValueText === undefined ? {} : { "aria-valuetext": ariaValueText })}
      onChange={(event) => onValueChange(Number(event.target.value))}
    />
  );
}
