import React from "react";

export function Tabs({ items = [], value, onChange, mode = "office", style }) {
  const floor = mode === "floor";
  return (
    <div role="tablist" style={{ display: "flex", gap: floor ? 8 : 4, borderBottom: "1px solid var(--line)", ...style }}>
      {items.map((it) => {
        const id = typeof it === "string" ? it : it.value;
        const label = typeof it === "string" ? it : it.label;
        const active = id === value;
        return (
          <button key={id} role="tab" aria-selected={active} onClick={() => onChange && onChange(id)}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              padding: floor ? "16px 20px" : "10px 14px", marginBottom: -1,
              font: floor ? "var(--floor-body-strong)" : "600 14px/1 var(--font-ui)",
              color: active ? "var(--fg-1)" : "var(--fg-3)",
              borderBottom: "2px solid " + (active ? "var(--fg-1)" : "transparent"),
              minHeight: floor ? "var(--control-floor)" : "var(--control-md)",
            }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
