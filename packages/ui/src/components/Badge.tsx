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
}

const TONE_STYLE: Record<BadgeTone, CSSProperties> = {
  neutral: { background: "var(--line)", color: "var(--fg-2)" },
  accent: { background: "var(--accent)", color: "var(--fg-on-inverse)" },
  ok: { background: "var(--ok-bg)", color: "var(--ok-fg)" },
  error: { background: "var(--err-bg)", color: "var(--err-fg)" },
  warn: { background: "var(--warn-bg)", color: "var(--warn-fg)" },
  info: { background: "var(--info-bg)", color: "var(--info-fg)" },
};

export function Badge({ tone = "neutral", className, style, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn("mk-badge", `mk-badge--${tone}`, className)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 16,
        minWidth: 16,
        padding: "1px 6px",
        borderRadius: "var(--r-1)",
        font: "400 12px/16px var(--font-mono)",
        whiteSpace: "nowrap",
        ...TONE_STYLE[tone],
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
