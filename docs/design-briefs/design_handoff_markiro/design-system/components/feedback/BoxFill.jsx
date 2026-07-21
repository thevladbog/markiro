import React from "react";

/* Фирменный компонент: сетка ячеек короба, заполняющаяся по мере сканирования (14/20). */
export function BoxFill({ filled = 0, total = 20, columns, cellSize = 24, kind = "ok", showCount = true, mode = "office", style }) {
  const cols = columns || Math.ceil(Math.sqrt(total * 1.6));
  const color = { ok: "var(--ok-solid)", error: "var(--err-solid)", duplicate: "var(--warn-solid)", syncing: "var(--info-solid)", neutral: "var(--fg-1)" }[kind];
  const floor = mode === "floor";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: floor ? 16 : 10, ...style }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(" + cols + ", " + cellSize + "px)", gap: Math.max(3, cellSize / 7) }}>
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} style={{
            width: cellSize, height: cellSize, borderRadius: 2,
            background: i < filled ? color : "transparent",
            border: "1.5px solid " + (i < filled ? color : "var(--line-strong)"),
            transition: "background 150ms",
          }} />
        ))}
      </div>
      {showCount && (
        <div style={{
          fontFamily: "var(--font-mono)", fontWeight: 600, fontVariantNumeric: "tabular-nums",
          fontSize: floor ? 48 : 20, lineHeight: 1, color: "var(--fg-1)",
        }}>
          {filled} <span style={{ color: "var(--fg-3)" }}>/ {total}</span>
        </div>
      )}
    </div>
  );
}
