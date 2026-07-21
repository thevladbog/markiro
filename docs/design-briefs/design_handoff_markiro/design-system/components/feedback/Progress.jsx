import React from "react";

export function ProgressBar({ value = 0, max = 100, kind = "neutral", mode = "office", label, showValue, style }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = { ok: "var(--ok-solid)", error: "var(--err-solid)", duplicate: "var(--warn-solid)", syncing: "var(--info-solid)", neutral: "var(--fg-1)" }[kind];
  const floor = mode === "floor";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {(label || showValue) && (
        <div style={{ display: "flex", justifyContent: "space-between", font: floor ? "var(--floor-body)" : "var(--text-body-sm)", color: "var(--fg-2)" }}>
          <span>{label}</span>
          {showValue && <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{value.toLocaleString("ru-RU")} / {max.toLocaleString("ru-RU")}</span>}
        </div>
      )}
      <div style={{ height: floor ? 12 : 6, background: "var(--surface-panel)", borderRadius: 2, overflow: "hidden", border: "1px solid var(--line)" }}>
        <div style={{ width: pct + "%", height: "100%", background: color, transition: "width 300ms" }} />
      </div>
    </div>
  );
}

export function RingCounter({ value = 0, max = 100, size = 120, label, kind = "neutral", style }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const stroke = size >= 100 ? 8 : 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = { ok: "var(--ok-solid)", error: "var(--err-solid)", duplicate: "var(--warn-solid)", syncing: "var(--info-solid)", neutral: "var(--fg-1)" }[kind];
  return (
    <div style={{ position: "relative", width: size, height: size, ...style }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          transform={"rotate(-90 " + size / 2 + " " + size / 2 + ")"} style={{ transition: "stroke-dashoffset 300ms" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: size / 4.2, lineHeight: 1, color: "var(--fg-1)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(pct * 100)}%
        </span>
        {label && <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>}
      </div>
    </div>
  );
}
