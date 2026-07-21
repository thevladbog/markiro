import React from "react";
import { Icon } from "../icons/Icon.jsx";
import { Button } from "../forms/Button.jsx";

export function Modal({ open, title, children, footer, onClose, width = 480, style }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "var(--surface-overlay)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24,
    }}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{
        width, maxWidth: "100%", maxHeight: "90vh", overflow: "auto",
        background: "var(--surface-card)", borderRadius: "var(--r-3)",
        border: "1px solid var(--line)", boxShadow: "var(--shadow-3)",
        display: "flex", flexDirection: "column", ...style,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ font: "var(--text-h2)", color: "var(--fg-1)" }}>{title}</span>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--fg-3)", padding: 6, display: "flex" }}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div style={{ padding: 20, flex: 1 }}>{children}</div>
        {footer && <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--line)" }}>{footer}</div>}
      </div>
    </div>
  );
}

export function FullScreenDialog({ open, title, children, footer, onClose }) {
  if (!open) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "var(--surface-page)", zIndex: 100,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ font: "var(--floor-title)", color: "var(--fg-1)" }}>{title}</span>
        {onClose && <Button mode="floor" variant="secondary" fullWidth={false} style={{ width: "auto", minWidth: "var(--control-floor)" }} onClick={onClose} icon={<Icon name="close" size={24} />}>Закрыть</Button>}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>{children}</div>
      {footer && <div style={{ display: "flex", gap: 12, padding: 24, borderTop: "1px solid var(--line)" }}>{footer}</div>}
    </div>
  );
}
