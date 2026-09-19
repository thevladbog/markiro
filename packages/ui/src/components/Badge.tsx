import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "../cn.js";

/**
 * Badge is a Task-2 synthesis — the handoff has no dedicated `Badge.jsx`.
 * Ported from the count pill in `prototypes/admin-panel.dc.html` sidebar nav
 * (`font: 400 12px/16px 'IBM Plex Mono'; background: #E0DED7; border-radius:
 * 4px; padding: 1px 6px; color: #45433E` — exactly `--line`/`--fg-2`/`--r-1`)
 * plus semantic tone variants reusing the existing status tokens.
 */
export type BadgeTone = "neutral" | "accent" | "ok" | "error" | "warn" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /**
   * Let a long label break across lines. Opt-in, because a badge is normally
   * a short pill that must not be split -- but a nowrap badge contributes its
   * whole string to its container's min-content width, which in a narrow
   * table column pushes every other column out and gets the pill clipped by
   * the scroll container. Wrapping also releases the fixed 16px height: the
   * pill grows to the lines it needs instead of spilling over its own
   * background (`minHeight` keeps a one-line badge exactly as tall as before).
   */
  wrap?: boolean;
}

const TONE_STYLE: Record<BadgeTone, CSSProperties> = {
  neutral: { background: "var(--line)", color: "var(--fg-2)" },
  accent: { background: "var(--accent)", color: "var(--fg-on-inverse)" },
  ok: { background: "var(--ok-bg)", color: "var(--ok-fg)" },
  error: { background: "var(--err-bg)", color: "var(--err-fg)" },
  warn: { background: "var(--warn-bg)", color: "var(--warn-fg)" },
  info: { background: "var(--info-bg)", color: "var(--info-fg)" },
};

export function Badge({
  tone = "neutral",
  wrap = false,
  className,
  style,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn("mk-badge", `mk-badge--${tone}`, wrap && "mk-badge--wrap", className)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: wrap ? "auto" : 16,
        minHeight: 16,
        minWidth: 16,
        padding: "1px 6px",
        borderRadius: "var(--r-1)",
        font: "400 12px/16px var(--font-mono)",
        whiteSpace: wrap ? "normal" : "nowrap",
        ...TONE_STYLE[tone],
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
