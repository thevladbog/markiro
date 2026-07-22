import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Port of `design-system/components/feedback/Alert.jsx`'s `Alert` export
 * (office mode only — the handoff's `mode="floor"` variant is out of scope).
 * Remapped from the handoff's `kind` union (ok/error/duplicate/syncing/neutral)
 * to the plan's `tone` contract (ok/error/warn/info) — the same remap
 * StatusChip already applies (`duplicate` -> `warn`, `syncing` -> `info`,
 * `neutral` dropped since the plan does not ask for it; `info` is the
 * default here since it is the closest fit to the handoff's neutral).
 * Icon glyphs are the literal characters used elsewhere in this package
 * (StatusChip, Toast) instead of the handoff's `<Icon>` SVG set, which this
 * package does not port.
 */
export type AlertTone = "ok" | "error" | "warn" | "info";

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: AlertTone;
  title?: ReactNode;
  /** Кнопка действия справа (например «Повторить») */
  action?: ReactNode;
}

interface ToneConfig {
  fg: string;
  bg: string;
  border: string;
  glyph: string;
}

export const ALERT_TONE: Record<AlertTone, ToneConfig> = {
  ok: { fg: "var(--ok-fg)", bg: "var(--ok-bg)", border: "var(--ok-border)", glyph: "✓" },
  error: { fg: "var(--err-fg)", bg: "var(--err-bg)", border: "var(--err-border)", glyph: "✕" },
  warn: { fg: "var(--warn-fg)", bg: "var(--warn-bg)", border: "var(--warn-border)", glyph: "⧉" },
  info: { fg: "var(--info-fg)", bg: "var(--info-bg)", border: "var(--info-border)", glyph: "⟳" },
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
  style,
  ...rest
}: AlertProps) {
  const config = ALERT_TONE[tone];
  const containerStyle: CSSProperties = {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: 14,
    borderRadius: "var(--r-2)",
    background: config.bg,
    border: `1px solid ${config.border}`,
    ...style,
  };

  return (
    <div
      role="alert"
      className={cn("mk-alert", `mk-alert--${tone}`, className)}
      style={containerStyle}
      {...rest}
    >
      <span
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 1, color: config.fg, font: "600 16px/1 var(--font-ui)" }}
      >
        {config.glyph}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        {title && (
          <span style={{ font: "600 14px/20px var(--font-ui)", color: config.fg }}>{title}</span>
        )}
        {children && (
          <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>{children}</span>
        )}
      </div>
      {action}
    </div>
  );
}
