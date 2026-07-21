import React from "react";
import { Icon } from "../icons/Icon.jsx";

/* Верхний переключатель задач станции (цех): крупные цели, всегда с подписями. */
export function TaskSwitcher({ items = [], activeId, onSelect, style }) {
  return (
    <div style={{ display: "flex", gap: 8, ...style }}>
      {items.map((it) => {
        const active = it.id === activeId;
        return (
          <button key={it.id} onClick={() => onSelect && onSelect(it.id)} style={{
            display: "flex", alignItems: "center", gap: 12, minHeight: "var(--control-floor)",
            padding: "0 20px", borderRadius: "var(--r-2)", cursor: "pointer",
            border: "1px solid " + (active ? "var(--fg-1)" : "var(--line-strong)"),
            background: active ? "var(--surface-inverse)" : "var(--surface-card)",
            color: active ? "var(--fg-on-inverse)" : "var(--fg-2)",
            font: "var(--floor-body-strong)",
          }}>
            {it.icon && <Icon name={it.icon} size={24} />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
