import React from "react";

export function Card({ title, actions, children, padding, mode = "office", style }) {
  const floor = mode === "floor";
  return (
    <div style={{
      background: "var(--surface-card)", border: "1px solid var(--line)",
      borderRadius: "var(--r-3)", boxShadow: "var(--shadow-1)",
      display: "flex", flexDirection: "column", ...style,
    }}>
      {(title || actions) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: floor ? "20px 24px" : "14px 20px", borderBottom: "1px solid var(--line)",
        }}>
          <span style={{ font: floor ? "var(--floor-lg)" : "var(--text-h3)", color: "var(--fg-1)" }}>{title}</span>
          {actions && <span style={{ display: "flex", gap: 8 }}>{actions}</span>}
        </div>
      )}
      <div style={{ padding: padding !== undefined ? padding : floor ? 24 : 20, flex: 1 }}>{children}</div>
    </div>
  );
}
