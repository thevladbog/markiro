import React from "react";

const H = { sm: "var(--control-sm)", md: "var(--control-md)", floor: "var(--control-floor)" };

export function Button({
  variant = "primary", mode = "office", size, fullWidth, disabled, loading,
  icon, children, onClick, type = "button", style,
}) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const floor = mode === "floor";
  const h = H[size || (floor ? "floor" : "md")];
  const base = {
    primary: { background: "var(--surface-inverse)", color: "var(--fg-on-inverse)", border: "1px solid var(--surface-inverse)" },
    secondary: { background: "var(--surface-card)", color: "var(--fg-1)", border: "1px solid var(--line-strong)" },
    destructive: { background: "var(--err-solid)", color: "#FFFFFF", border: "1px solid var(--err-solid)" },
    ghost: { background: "transparent", color: "var(--fg-2)", border: "1px solid transparent" },
  }[variant];
  const hovered = !floor && hover && !disabled ? { filter: "brightness(0.92)" } : null;
  const pressed = press && !disabled ? { transform: "translateY(1px)", filter: "brightness(0.85)" } : null;
  return (
    <button type={type} disabled={disabled} onClick={loading ? undefined : onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)} onMouseUp={() => setPress(false)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: floor ? 12 : 8,
        height: h, padding: floor ? "0 24px" : "0 16px", borderRadius: "var(--r-2)",
        font: floor ? "var(--floor-body-strong)" : "600 14px/1 var(--font-ui)",
        fontSize: floor ? 20 : size === "sm" ? 13 : 14,
        width: fullWidth || floor ? "100%" : undefined, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, transition: "filter 120ms, transform 60ms",
        ...base, ...hovered, ...pressed, ...style,
      }}>
      {loading ? <span style={{
        width: floor ? 20 : 14, height: floor ? 20 : 14, border: "2px solid currentColor",
        borderRightColor: "transparent", borderRadius: "50%", display: "inline-block",
        animation: "mk-spin 700ms linear infinite",
      }} /> : icon}
      {children}
      <style>{"@keyframes mk-spin{to{transform:rotate(360deg)}}"}</style>
    </button>
  );
}
