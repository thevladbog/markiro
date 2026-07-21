import React from "react";
import { Icon } from "../icons/Icon.jsx";
import { StatusChip } from "../display/StatusChip.jsx";

/* Статус-бар станции: связь, синхронизация, оборудование, оператор, время. */
export function StatusBar({ online = true, syncing, queued = 0, devices = [], operator, shiftLabel, clock, style }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16, padding: "0 20px",
      height: 56, background: "var(--surface-panel)", borderBottom: "1px solid var(--line)",
      font: "var(--floor-body)", color: "var(--fg-2)", ...style,
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, color: online ? "var(--ok-fg)" : "var(--warn-fg)", fontWeight: 600 }}>
        <Icon name={online ? "wifi" : "offline"} size={22} />
        {online ? "В сети" : "Офлайн"}
      </span>
      {syncing && (
        <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--info-fg)", fontWeight: 600 }}>
          <Icon name="sync" size={20} />
          Синхронизация{queued > 0 ? ": " + queued.toLocaleString("ru-RU") : ""}
        </span>
      )}
      {!online && queued > 0 && (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>В очереди: {queued.toLocaleString("ru-RU")}</span>
      )}
      {devices.map((d) => (
        <span key={d.name} title={d.name} style={{ display: "flex", alignItems: "center", gap: 6, color: d.ok ? "var(--fg-2)" : "var(--err-fg)", fontWeight: d.ok ? 400 : 600 }}>
          <Icon name={d.icon || "printer"} size={20} />
          {d.ok ? d.name : d.name + " — нет связи"}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      {operator && (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="user" size={20} />
          {operator}{shiftLabel ? " · " + shiftLabel : ""}
        </span>
      )}
      {clock && <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--fg-1)", fontWeight: 500 }}>{clock}</span>}
    </div>
  );
}
