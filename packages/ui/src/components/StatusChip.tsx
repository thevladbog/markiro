import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Port of `design-system/components/display/StatusChip.jsx`, remapped from
 * the handoff's `kind` union (ok/error/duplicate/syncing/offline/neutral) to
 * the plan's simplified `status` contract (ok/error/warn/info/neutral).
 * `warn` reuses the handoff's "duplicate" tokens/glyph, `info` reuses
 * "syncing" — same semantic colors, renamed to the generic status vocabulary.
 * Glyphs are the literal characters from `display/display.card.html`
 * (✓ ✕ ⧉ ⟳) rather than the `<Icon>` SVG set, since Task 2 does not port an
 * Icon component. `neutral` gets its own glyph + label so color is never the
 * only signal, even for the "no status" case.
 */
export type StatusChipStatus = "ok" | "error" | "warn" | "info" | "neutral";

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: StatusChipStatus;
  /** Override the default label text (e.g. for translated copy) */
  label?: ReactNode;
  /** Fill with the solid status color (for dark panels) */
  solid?: boolean;
}

interface StatusConfig {
  fg: string;
  bg: string;
  border: string;
  glyph: string;
  label: string;
}

const STATUS: Record<StatusChipStatus, StatusConfig> = {
  ok: {
    fg: "var(--ok-fg)",
    bg: "var(--ok-bg)",
    border: "var(--ok-border)",
    glyph: "✓",
    label: "OK",
  },
  error: {
    fg: "var(--err-fg)",
    bg: "var(--err-bg)",
    border: "var(--err-border)",
    glyph: "✕",
    label: "Error",
  },
  warn: {
    fg: "var(--warn-fg)",
    bg: "var(--warn-bg)",
    border: "var(--warn-border)",
    glyph: "⧉",
    label: "Duplicate",
  },
  info: {
    fg: "var(--info-fg)",
    bg: "var(--info-bg)",
    border: "var(--info-border)",
    glyph: "⟳",
    label: "Syncing",
  },
  neutral: {
    fg: "var(--fg-2)",
    bg: "var(--surface-panel)",
    border: "var(--line)",
    glyph: "–",
    label: "Neutral",
  },
};

export function StatusChip({
  status,
  label,
  solid = false,
  className,
  style,
  ...rest
}: StatusChipProps) {
  const config = STATUS[status];

  return (
    <span
      className={cn("mk-chip", `mk-chip--${status}`, solid && "mk-chip--solid", className)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 10px",
        borderRadius: "var(--r-1)",
        whiteSpace: "nowrap",
        background: solid ? config.fg : config.bg,
        color: solid ? "var(--surface-card)" : config.fg,
        border: `1px solid ${solid ? config.fg : config.border}`,
        font: "600 12px/1 var(--font-ui)",
        ...style,
      }}
      {...rest}
    >
      <span aria-hidden="true">{config.glyph}</span>
      <span>{label ?? config.label}</span>
    </span>
  );
}
