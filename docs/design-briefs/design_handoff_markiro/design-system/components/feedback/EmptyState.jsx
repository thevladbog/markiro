import React from "react";
import { Icon } from "../icons/Icon.jsx";

/* Паттерн пустого/ошибочного/офлайн состояния поверхности. */
export function EmptyState({ icon = "report", title, children, action, mode = "office", style }) {
  const floor = mode === "floor";
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 12, padding: floor ? 48 : 40, textAlign: "center", ...style,
    }}>
      <Icon name={icon} size={floor ? 64 : 40} color="var(--fg-disabled)" strokeWidth={1.5} />
      <div style={{ font: floor ? "var(--floor-lg)" : "var(--text-h3)", color: "var(--fg-1)" }}>{title}</div>
      {children && <div style={{ font: floor ? "var(--floor-body)" : "var(--text-body)", color: "var(--fg-3)", maxWidth: 420 }}>{children}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 16, radius, style }) {
  return (
    <span style={{
      display: "inline-block", width, height, borderRadius: radius ?? "var(--r-1)",
      background: "linear-gradient(90deg, var(--surface-panel) 25%, var(--line) 50%, var(--surface-panel) 75%)",
      backgroundSize: "200% 100%", animation: "mk-shimmer 1.4s ease infinite", ...style,
    }}>
      <style>{"@keyframes mk-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}"}</style>
    </span>
  );
}
