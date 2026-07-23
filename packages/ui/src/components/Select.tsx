import { useId, useState, type FocusEvent, type SelectHTMLAttributes } from "react";

import { cn } from "../cn.js";

/** Порт `design-system/components/forms/Select.jsx` (нативный select) — только офисный режим. */
export type SelectOption = string | { value: string; label: string; disabled?: boolean };

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  label?: string;
  /** Строки или {value, label} */
  options: SelectOption[];
  onChange?: (value: string) => void;
  hint?: string;
  error?: string;
}

export function Select({
  label,
  options,
  value,
  onChange,
  disabled,
  hint,
  error,
  className,
  style,
  id,
  onFocus,
  onBlur,
  ...rest
}: SelectProps) {
  const [focus, setFocus] = useState(false);
  const autoId = useId();
  const selectId = id ?? `mk-select-${autoId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = errorId ?? hintId;

  const handleFocus = (event: FocusEvent<HTMLSelectElement>) => {
    setFocus(true);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLSelectElement>) => {
    setFocus(false);
    onBlur?.(event);
  };

  return (
    <div
      className={cn("mk-field", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <label htmlFor={selectId} style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}>
          {label}
        </label>
      )}
      <span style={{ position: "relative", display: "flex" }}>
        <select
          id={selectId}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange?.(event.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="mk-select__control"
          style={{
            appearance: "none",
            WebkitAppearance: "none",
            width: "100%",
            height: "var(--control-md)",
            padding: "0 36px 0 12px",
            borderRadius: "var(--r-2)",
            background: "var(--surface-card)",
            color: "var(--fg-1)",
            border: `1px solid ${
              error ? "var(--err-solid)" : focus ? "var(--focus-ring)" : "var(--line-strong)"
            }`,
            boxShadow: focus
              ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)"
              : "none",
            font: "var(--text-body)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1,
          }}
          {...rest}
        >
          {options.map((option) => {
            const optionValue = typeof option === "string" ? option : option.value;
            const optionLabel = typeof option === "string" ? option : option.label;
            const optionDisabled = typeof option === "string" ? false : Boolean(option.disabled);
            return (
              <option key={optionValue} value={optionValue} disabled={optionDisabled}>
                {optionLabel}
              </option>
            );
          })}
        </select>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-3)"
          strokeWidth={2}
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
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
