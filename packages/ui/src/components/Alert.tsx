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
    padding: "12px 16px",
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
        className="mk-alert__icon"
        // Same 20px line box as the title and the body text, so the glyph
        // sits on the first text line instead of floating above it.
        style={{
          flexShrink: 0,
          width: 16,
          textAlign: "center",
          color: config.fg,
          font: "600 14px/20px var(--font-ui)",
        }}
      >
        {config.glyph}
      </span>
      <div
        className="mk-alert__body"
        style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}
      >
        {title && (
          <span
            className="mk-alert__title"
            style={{ font: "600 14px/20px var(--font-ui)", color: config.fg }}
          >
            {title}
          </span>
        )}
        {children && (
          // `div`, not `span`: children are often block content (e.g. the
          // pickup order detail page's conflict list), and phrasing content
          // (span) cannot contain a list -- that's invalid HTML.
          <div
            className="mk-alert__text"
            style={{ font: "var(--text-body)", color: "var(--fg-2)" }}
          >
            {children}
          </div>
        )}
      </div>
      {action ? (
        <div className="mk-alert__action" style={{ alignSelf: "center", flexShrink: 0 }}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
