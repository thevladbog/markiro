import React from "react";

export function Select({ label, options = [], value, onChange, mode = "office", disabled, hint, error, style }) {
  const [focus, setFocus] = React.useState(false);
  const floor = mode === "floor";
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label && <span style={{ font: floor ? "var(--floor-body-strong)" : "var(--text-caption)", color: "var(--fg-2)" }}>{label}</span>}
      <span style={{ position: "relative", display: "flex" }}>
        <select value={value} disabled={disabled}
          onChange={(e) => onChange && onChange(e.target.value)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{
            appearance: "none", WebkitAppearance: "none", width: "100%",
            height: floor ? "var(--control-floor)" : "var(--control-md)",
            padding: "0 36px 0 12px", borderRadius: "var(--r-2)",
            background: "var(--surface-card)", color: "var(--fg-1)",
            border: "1px solid " + (error ? "var(--err-solid)" : focus ? "var(--focus-ring)" : "var(--line-strong)"),
            boxShadow: focus ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)" : "none",
            font: floor ? "var(--floor-body)" : "var(--text-body)", cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1,
          }}>
          {options.map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const t = typeof o === "string" ? o : o.label;
            return <option key={v} value={v}>{t}</option>;
          })}
        </select>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-3)" strokeWidth="2"
          style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
      {(error || hint) && (
        <span style={{ font: "var(--text-body-sm)", color: error ? "var(--err-fg)" : "var(--fg-3)" }}>{error || hint}</span>
      )}
    </label>
  );
}
