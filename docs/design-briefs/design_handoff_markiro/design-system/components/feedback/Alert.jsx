import React from "react";
import { Icon } from "../icons/Icon.jsx";
import { StatusChip } from "../display/StatusChip.jsx";

const K = {
  ok: ["var(--ok-fg)", "var(--ok-bg)", "var(--ok-border)", "check"],
  error: ["var(--err-fg)", "var(--err-bg)", "var(--err-border)", "alert"],
  duplicate: ["var(--warn-fg)", "var(--warn-bg)", "var(--warn-border)", "duplicate"],
  syncing: ["var(--info-fg)", "var(--info-bg)", "var(--info-border)", "sync"],
  neutral: ["var(--fg-2)", "var(--surface-panel)", "var(--line)", "alert"],
};

export function Alert({ kind = "neutral", title, children, action, mode = "office", style }) {
  const [fg, bg, border, icon] = K[kind] || K.neutral;
  const floor = mode === "floor";
  return (
    <div role="alert" style={{
      display: "flex", gap: floor ? 16 : 12, alignItems: "flex-start",
      padding: floor ? 20 : 14, borderRadius: "var(--r-2)",
      background: bg, border: "1px solid " + border, ...style,
    }}>
      <Icon name={icon} size={floor ? 32 : 18} color={fg} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        {title && <span style={{ font: floor ? "var(--floor-body-strong)" : "600 14px/20px var(--font-ui)", color: fg }}>{title}</span>}
        {children && <span style={{ font: floor ? "var(--floor-body)" : "var(--text-body)", color: "var(--fg-2)" }}>{children}</span>}
      </div>
      {action}
    </div>
  );
}

export function Toast({ kind = "neutral", children, onClose, style }) {
  const [fg, , , icon] = K[kind] || K.neutral;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
      borderRadius: "var(--r-2)", background: "var(--surface-inverse)",
      color: "var(--fg-on-inverse)", boxShadow: "var(--shadow-3)", maxWidth: 420, ...style,
    }}>
      <Icon name={icon} size={18} color={kind === "neutral" ? "var(--fg-on-inverse)" : fg} />
      <span style={{ font: "var(--text-body)", flex: 1 }}>{children}</span>
      {onClose && (
        <button onClick={onClose} style={{ border: "none", background: "transparent", color: "inherit", opacity: 0.6, cursor: "pointer", padding: 4, display: "flex" }}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
