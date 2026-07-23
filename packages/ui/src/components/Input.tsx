import { useId, useState, type FocusEvent, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../cn.js";

/** Порт `design-system/components/forms/Input.jsx` — только офисный режим (высота 40px). */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: string;
  /** Подсказка под полем */
  hint?: string;
  /** Текст ошибки: красная рамка + сообщение */
  error?: string;
  /** Plex Mono + tabular-nums — коды, GTIN, количества */
  mono?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export function Input({
  label,
  hint,
  error,
  mono = false,
  prefix,
  suffix,
  disabled,
  className,
  style,
  id,
  onFocus,
  onBlur,
  ...rest
}: InputProps) {
  const [focus, setFocus] = useState(false);
  const autoId = useId();
  const inputId = id ?? `mk-input-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = errorId ?? hintId;

  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    setFocus(true);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    setFocus(false);
    onBlur?.(event);
  };

  return (
    <div
      className={cn("mk-field", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <label htmlFor={inputId} style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}>
          {label}
        </label>
      )}
      <span
        className={cn("mk-input", error && "mk-input--error")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: "var(--control-md)",
          padding: "0 12px",
          borderRadius: "var(--r-2)",
          background: "var(--surface-card)",
          border: `1px solid ${
            error ? "var(--err-solid)" : focus ? "var(--focus-ring)" : "var(--line-strong)"
          }`,
          boxShadow: focus
            ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)"
            : "none",
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {prefix && <span style={{ color: "var(--fg-3)", font: "var(--text-code)" }}>{prefix}</span>}
        <input
          id={inputId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="mk-input__control"
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--fg-1)",
            fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
            fontSize: 14,
            fontVariantNumeric: "tabular-nums",
          }}
          {...rest}
        />
        {suffix && (
          <span style={{ color: "var(--fg-3)", font: "var(--text-caption)" }}>{suffix}</span>
        )}
      </span>
      {(error || hint) && (
        <span
          id={error ? errorId : hintId}
          style={{
            font: "var(--text-body-sm)",
            color: error ? "var(--err-fg)" : "var(--fg-3)",
          }}
        >
          {error || hint}
        </span>
      )}
    </div>
  );
}
