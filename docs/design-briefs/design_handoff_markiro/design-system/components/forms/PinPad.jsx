import React from "react";

export function PinPad({ length = 4, onSubmit, label = "Введите PIN", style }) {
  const [val, setVal] = React.useState("");
  const add = (d) => setVal((v) => (v.length < length ? v + d : v));
  const back = () => setVal((v) => v.slice(0, -1));
  const ok = () => { if (val.length === length && onSubmit) { onSubmit(val); setVal(""); } };
  const Key = ({ children, onClick, accent }) => (
    <button onClick={onClick} style={{
      height: "var(--control-floor)", minWidth: "var(--control-floor)", borderRadius: "var(--r-2)",
      border: "1px solid " + (accent ? "var(--surface-inverse)" : "var(--line-strong)"),
      background: accent ? "var(--surface-inverse)" : "var(--surface-card)",
      color: accent ? "var(--fg-on-inverse)" : "var(--fg-1)",
      font: "var(--floor-lg)", fontVariantNumeric: "tabular-nums", cursor: "pointer",
    }}>{children}</button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 280, ...style }}>
      <div style={{ font: "var(--floor-body-strong)", color: "var(--fg-2)", textAlign: "center" }}>{label}</div>
      <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
        {Array.from({ length }).map((_, i) => (
          <span key={i} style={{
            width: 16, height: 16, borderRadius: 2,
            background: i < val.length ? "var(--fg-1)" : "transparent",
            border: "2px solid " + (i < val.length ? "var(--fg-1)" : "var(--line-strong)"),
          }} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {["1","2","3","4","5","6","7","8","9"].map((d) => <Key key={d} onClick={() => add(d)}>{d}</Key>)}
        <Key onClick={back}>⌫</Key>
        <Key onClick={() => add("0")}>0</Key>
        <Key accent onClick={ok}>OK</Key>
      </div>
    </div>
  );
}
