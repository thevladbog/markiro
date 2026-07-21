import React from "react";

export function Input({
  label, hint, error, value, defaultValue, onChange, placeholder, type = "text",
  mode = "office", mono, disabled, prefix, suffix, style, id,
}) {
  const [focus, setFocus] = React.useState(false);
  const floor = mode === "floor";
  const uid = React.useMemo(() => id || "in-" + Math.random().toString(36).slice(2, 7), [id]);
  return (
    <label htmlFor={uid} style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}>
      {label && <span style={{ font: floor ? "var(--floor-body-strong)" : "var(--text-caption)", color: "var(--fg-2)" }}>{label}</span>}
      <span style={{
        display: "flex", alignItems: "center", gap: 8,
        height: floor ? "var(--control-floor)" : "var(--control-md)",
        padding: "0 12px", borderRadius: "var(--r-2)", background: "var(--surface-card)",
        border: "1px solid " + (error ? "var(--err-solid)" : focus ? "var(--focus-ring)" : "var(--line-strong)"),
        boxShadow: focus ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)" : "none",
        opacity: disabled ? 0.45 : 1,
      }}>
        {prefix && <span style={{ color: "var(--fg-3)", font: "var(--text-code)" }}>{prefix}</span>}
        <input id={uid} type={type} value={value} defaultValue={defaultValue} placeholder={placeholder}
          disabled={disabled} onChange={onChange}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
            color: "var(--fg-1)", fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
            fontSize: floor ? 20 : 14, fontVariantNumeric: "tabular-nums",
          }} />
        {suffix && <span style={{ color: "var(--fg-3)", font: "var(--text-caption)" }}>{suffix}</span>}
      </span>
      {(error || hint) && (
        <span style={{ font: "var(--text-body-sm)", color: error ? "var(--err-fg)" : "var(--fg-3)" }}>
          {error || hint}
        </span>
      )}
    </label>
  );
}
