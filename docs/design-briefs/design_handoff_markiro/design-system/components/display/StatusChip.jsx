import React from "react";
import { Icon } from "../icons/Icon.jsx";

const KIND = {
  ok: { fg: "var(--ok-fg)", bg: "var(--ok-bg)", border: "var(--ok-border)", icon: "check", label: "OK" },
  error: { fg: "var(--err-fg)", bg: "var(--err-bg)", border: "var(--err-border)", icon: "close", label: "Ошибка" },
  duplicate: { fg: "var(--warn-fg)", bg: "var(--warn-bg)", border: "var(--warn-border)", icon: "duplicate", label: "Дубликат" },
  syncing: { fg: "var(--info-fg)", bg: "var(--info-bg)", border: "var(--info-border)", icon: "sync", label: "Синхронизация" },
  offline: { fg: "var(--fg-2)", bg: "var(--surface-panel)", border: "var(--line-strong)", icon: "offline", label: "Офлайн" },
  neutral: { fg: "var(--fg-2)", bg: "var(--surface-panel)", border: "var(--line)", icon: null, label: "" },
};

export function StatusChip({ kind = "neutral", children, mode = "office", solid, icon, style }) {
  const k = KIND[kind] || KIND.neutral;
  const floor = mode === "floor";
  const iconName = icon === undefined ? k.icon : icon;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: floor ? 10 : 6,
      height: floor ? 44 : 24, padding: floor ? "0 16px" : "0 10px",
      borderRadius: "var(--r-1)", whiteSpace: "nowrap",
      background: solid ? k.fg : k.bg, color: solid ? "var(--surface-card)" : k.fg,
      border: "1px solid " + (solid ? k.fg : k.border),
      font: floor ? "var(--floor-body-strong)" : "600 12px/1 var(--font-ui)",
      ...style,
    }}>
      {iconName && <Icon name={iconName} size={floor ? 22 : 13} strokeWidth={floor ? 2 : 2.5} />}
      {children !== undefined ? children : k.label}
    </span>
  );
}
