import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "../cn.js";

export type InputSize = "md" | "floor";

/** Порт `design-system/components/forms/Input.jsx` с офисным и цеховым размерами. */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix" | "size"> {
  label?: string;
  /** Подсказка под полем */
  hint?: string;
  /** Текст ошибки: красная рамка + сообщение */
  error?: string;
  /** Plex Mono + tabular-nums — коды, GTIN, количества */
  mono?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  size?: InputSize;
}

export function Input({
  label,
  hint,
  error,
  mono = false,
  prefix,
  suffix,
  size = "md",
  autoComplete,
  type,
  disabled,
  className,
  style,
  id,
  onFocus,
  onBlur,
  ...rest
}: InputProps) {
  const [focus, setFocus] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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

  // Почти все поля админки — данные других людей (ФИО сотрудника, PIN станции),
  // и автофилл подставляет туда email/пароль владельца. autocomplete="off" Chrome
  // игнорирует на парольных полях — уважает только "new-password"; расширения-
  // парольники игнорируют его везде, их глушат data-атрибуты. Поля, где автофилл
  // уместен (логин, свой профиль), задают autoComplete явно и не глушатся.
  const resolvedAutoComplete = autoComplete ?? (type === "password" ? "new-password" : "off");
  const passwordManagerOptOut =
    autoComplete === undefined
      ? {
          "data-1p-ignore": true,
          "data-lpignore": "true",
          "data-bwignore": true,
          "data-form-type": "other",
        }
      : undefined;

  return (
    <div
      className={cn("mk-field", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <label
          htmlFor={inputId}
          style={{
            font: size === "floor" ? "var(--floor-body-strong)" : "var(--text-caption)",
            color: "var(--fg-2)",
          }}
        >
          {label}
        </label>
      )}
      <span
        className={cn("mk-input", error && "mk-input--error")}
        onClick={size === "floor" && !disabled ? () => inputRef.current?.focus() : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: size === "floor" ? "var(--control-floor)" : "var(--control-md)",
          padding: size === "floor" ? "0 16px" : "0 12px",
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
        {prefix && (
          <span
            style={{
              color: "var(--fg-3)",
              font: size === "floor" ? "var(--floor-body)" : "var(--text-code)",
            }}
          >
            {prefix}
          </span>
        )}
        <input
          ref={inputRef}
          id={inputId}
          type={type}
          autoComplete={resolvedAutoComplete}
          {...passwordManagerOptOut}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="mk-input__control"
          style={{
            flex: 1,
            minWidth: 0,
            height: size === "floor" ? "100%" : undefined,
            minHeight: size === "floor" ? "var(--control-floor)" : undefined,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--fg-1)",
            fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
            fontSize: size === "floor" ? 20 : 14,
            fontVariantNumeric: "tabular-nums",
          }}
          {...rest}
        />
        {suffix && (
          <span
            style={{
              color: "var(--fg-3)",
              font: size === "floor" ? "var(--floor-body)" : "var(--text-caption)",
            }}
          >
            {suffix}
          </span>
        )}
      </span>
      {(error || hint) && (
        <span
          id={error ? errorId : hintId}
          style={{
            font: size === "floor" ? "var(--floor-body)" : "var(--text-body-sm)",
            color: error ? "var(--err-fg)" : "var(--fg-3)",
          }}
        >
          {error || hint}
        </span>
      )}
    </div>
  );
}
