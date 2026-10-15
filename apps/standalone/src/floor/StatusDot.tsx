import "./status-dot.css";

/** The state a dot shows: all well, attention, trouble, or unknown. */
export type StatusDotTone = "ok" | "warn" | "error" | "neutral";

export interface StatusDotProps {
  tone: StatusDotTone;
  /** The state in words: a dot alone would be read by colour, so the name is required. */
  label: string;
  /** The dot breathes: a state that is still being settled (connecting). */
  pulse?: boolean;
  /** The dot sits inside a control that carries the name: hidden from assistive technology. */
  decorative?: boolean;
}

/**
 * A small status dot (green / amber / red / grey) with an accessible name
 * (beta 3.2). The station's bar shows the link to the host this way; the
 * details live in a popover beside it. This is the floor's own copy: the office
 * shell makes a shared one (`StatusDot`), and the merge unifies them.
 */
export function StatusDot({ tone, label, pulse = false, decorative = false }: StatusDotProps) {
  const classes = `status-dot status-dot--${tone}${pulse ? " status-dot--pulse" : ""}`;
  if (decorative) return <span className={classes} aria-hidden="true" />;
  return <span className={classes} role="img" aria-label={label} title={label} />;
}
