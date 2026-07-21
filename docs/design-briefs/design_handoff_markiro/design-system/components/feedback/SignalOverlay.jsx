import React from "react";
import { Icon } from "../icons/Icon.jsx";

const K = {
  ok: { bg: "var(--ok-solid)", fg: "#0B2A17", icon: "check", label: "Код принят" },
  error: { bg: "var(--err-solid)", fg: "#FFFFFF", icon: "close", label: "Ошибка" },
  duplicate: { bg: "var(--warn-solid)", fg: "#33250E", icon: "duplicate", label: "Дубликат" },
  "box-complete": { bg: "var(--surface-inverse)", fg: "var(--fg-on-inverse)", icon: "box", label: "Короб собран" },
};

/* Полноэкранный сигнал линии: в цехе статус и есть интерфейс.
   OK — короткая вспышка; ошибка/дубликат — до подтверждения. */
export function SignalOverlay({ kind = "ok", title, detail, action, style }) {
  const k = K[kind] || K.ok;
  return (
    <div style={{
      position: "absolute", inset: 0, background: k.bg, color: k.fg, zIndex: 90,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 24, textAlign: "center", padding: 32, ...style,
    }}>
      <Icon name={k.icon} size={140} strokeWidth={2.5} color={k.fg} />
      <div style={{ font: "var(--floor-counter-sm)", fontFamily: "var(--font-ui)", fontWeight: 700 }}>{title || k.label}</div>
      {detail && <div style={{ font: "var(--floor-lg)", opacity: 0.85, maxWidth: 640 }}>{detail}</div>}
      {action}
    </div>
  );
}
