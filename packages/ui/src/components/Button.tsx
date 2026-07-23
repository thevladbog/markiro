import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

import { cn } from "../cn.js";

/** Порт `design-system/components/forms/Button.jsx` — только офисный режим (40px / 32px). */
export type ButtonVariant = "primary" | "secondary" | "destructive";
export type ButtonSize = "md" | "compact";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary — главное действие экрана (одно); secondary — обычное; destructive — необратимое */
  variant?: ButtonVariant;
  /** md — 40px (по умолчанию); compact — 32px, для плотных панелей/таблиц */
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Показывает спиннер и блокирует onClick */
  loading?: boolean;
  /** Иконка (или любой узел) слева от текста */
  icon?: ReactNode;
}

const HEIGHT: Record<ButtonSize, string> = {
  md: "var(--control-md)",
  compact: "var(--control-sm)",
};

const VARIANT_STYLE: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: "var(--surface-inverse)",
    color: "var(--fg-on-inverse)",
    border: "1px solid var(--surface-inverse)",
  },
  secondary: {
    background: "var(--surface-card)",
    color: "var(--fg-1)",
    border: "1px solid var(--line-strong)",
  },
  destructive: {
    // handoff hardcodes white text on the solid error color — no on-solid token exists
    background: "var(--err-solid)",
    color: "#FFFFFF",
    border: "1px solid var(--err-solid)",
  },
};

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  icon,
  disabled = false,
  children,
  className,
  style,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      onClick={loading ? undefined : onClick}
      className={cn(
        "mk-btn",
        `mk-btn--${variant}`,
        `mk-btn--${size}`,
        fullWidth && "mk-btn--full",
        className,
      )}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        height: HEIGHT[size],
        padding: "0 16px",
        borderRadius: "var(--r-2)",
        font: "600 14px/1 var(--font-ui)",
        fontSize: size === "compact" ? 13 : 14,
        width: fullWidth ? "100%" : undefined,
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "filter 120ms, transform 60ms",
        ...VARIANT_STYLE[variant],
        ...style,
      }}
      {...rest}
    >
      {loading && <span aria-hidden="true" className="mk-spin" style={SPIN_STYLE} />}
      {!loading && icon}
      {children}
      {loading && <style>{"@keyframes mk-spin{to{transform:rotate(360deg)}}"}</style>}
    </button>
  );
}

const SPIN_STYLE: CSSProperties = {
  width: 14,
  height: 14,
  border: "2px solid currentColor",
  borderRightColor: "transparent",
  borderRadius: "50%",
  display: "inline-block",
  animation: "mk-spin 700ms linear infinite",
};
