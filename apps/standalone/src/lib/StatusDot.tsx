import "./status-dot.css";

/** The state a dot shows: all well, attention, trouble, or unknown/idle. */
export type StatusDotTone = "ok" | "warn" | "error" | "neutral";

export interface StatusDotProps {
  tone: StatusDotTone;
  /**
   * The state in words, for a screen reader and the pointer's tooltip. A
   * dot without it would be read by colour alone, so it is required.
   */
  label: string;
  /** A larger dot (16 px); the default is 12 px. */
  large?: boolean;
  /** The dot breathes: a state that is still being settled (connecting). */
  pulse?: boolean;
  /**
   * The dot sits inside a control that already carries the name (a button
   * that opens the details): it is then hidden from assistive technology
   * and has no tooltip of its own.
   */
  decorative?: boolean;
  className?: string;
}

/**
 * A small status dot (green / amber / red / grey) with an accessible name.
 * The office header and the station's status bar both show a link or a health
 * state this way: the details (since when, why) live in a tooltip or a
 * popover beside it, not in a chip across the header.
 */
export function StatusDot({
  tone,
  label,
  large = false,
  pulse = false,
  decorative = false,
  className,
}: StatusDotProps) {
  const classes = [
    "status-dot",
    `status-dot--${tone}`,
    large ? "status-dot--lg" : null,
    pulse ? "status-dot--pulse" : null,
    className ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (decorative) return <span className={classes} aria-hidden="true" />;
  return <span className={classes} role="img" aria-label={label} title={label} />;
}
