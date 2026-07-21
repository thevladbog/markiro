import React from "react";
import { Icon } from "../icons/Icon.jsx";

/* items: [{id, label, icon, badge}] */
export function Sidebar({ items = [], activeId, onSelect, footer, collapsed, style }) {
  return (
    <nav style={{
      width: collapsed ? 64 : 232, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "var(--surface-panel)", borderRight: "1px solid var(--line)",
      padding: "16px 8px", gap: 2, height: "100%", boxSizing: "border-box", ...style,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 10px 16px 10px" }}>
        <svg width="28" height="28" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" fill="var(--fg-1)" /><g fill="var(--surface-page)"><rect x="14" y="14" width="8" height="8" /><rect x="14" y="26" width="8" height="8" /><rect x="14" y="38" width="8" height="8" /><rect x="26" y="22" width="8" height="8" /><rect x="38" y="14" width="8" height="8" /><rect x="38" y="26" width="8" height="8" /><rect x="38" y="38" width="8" height="8" /><rect x="26" y="42" width="8" height="8" fill="#3DDC7A" /></g></svg>
        {!collapsed && <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 17, color: "var(--fg-1)" }}>маркиро</span>}
      </div>
      {items.map((it) => {
        const active = it.id === activeId;
        return (
          <button key={it.id} onClick={() => onSelect && onSelect(it.id)} title={collapsed ? it.label : undefined}
            style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              padding: collapsed ? "10px" : "9px 10px", justifyContent: collapsed ? "center" : "flex-start",
              borderRadius: "var(--r-2)", border: "none", cursor: "pointer", textAlign: "left",
              background: active ? "var(--surface-card)" : "transparent",
              boxShadow: active ? "inset 0 0 0 1px var(--line)" : "none",
              color: active ? "var(--fg-1)" : "var(--fg-2)",
              font: "500 14px/20px var(--font-ui)",
            }}>
            {it.icon && <Icon name={it.icon} size={18} />}
            {!collapsed && <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>}
            {!collapsed && it.badge != null && (
              <span style={{ font: "var(--text-meta)", background: "var(--line)", borderRadius: "var(--r-1)", padding: "1px 6px", color: "var(--fg-2)", fontVariantNumeric: "tabular-nums" }}>{it.badge}</span>
            )}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      {footer}
    </nav>
  );
}
