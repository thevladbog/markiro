import * as RadixRadioGroup from "@radix-ui/react-radio-group";
import { useId, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "../cn.js";

export interface RadioGroupOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  options: RadioGroupOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  label?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export function RadioGroup({
  options,
  value,
  onValueChange,
  label,
  hint,
  error,
  disabled = false,
  name,
  id,
  className,
  style,
  "aria-label": ariaLabel,
}: RadioGroupProps) {
  const [focusedValue, setFocusedValue] = useState<string>();
  const autoId = useId();
  const groupId = id ?? `mk-radio-group-${autoId}`;
  const labelId = label ? `${groupId}-label` : undefined;
  const hintId = hint ? `${groupId}-hint` : undefined;
  const errorId = error ? `${groupId}-error` : undefined;

  return (
    <div
      className={cn("mk-field", "mk-radio-group", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <span id={labelId} style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}>
          {label}
        </span>
      )}
      <RadixRadioGroup.Root
        id={groupId}
        disabled={disabled}
        {...(value === undefined ? {} : { value })}
        {...(onValueChange === undefined ? {} : { onValueChange })}
        {...(name === undefined ? {} : { name })}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        {...(ariaLabel === undefined && labelId ? { "aria-labelledby": labelId } : {})}
        {...(error ? { "aria-invalid": true } : {})}
        {...(errorId || hintId ? { "aria-describedby": errorId ?? hintId } : {})}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          const optionDisabled = disabled || option.disabled === true;

          return (
            <div key={option.value} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <RadixRadioGroup.Item
                id={optionId}
                value={option.value}
                disabled={optionDisabled}
                aria-labelledby={`${optionId}-label`}
                onFocus={() => setFocusedValue(option.value)}
                onBlur={() =>
                  setFocusedValue((current) => (current === option.value ? undefined : current))
                }
                className="mk-radio-group__control"
                style={{
                  flex: "0 0 auto",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  marginTop: 1,
                  padding: 0,
                  border: `1px solid ${error ? "var(--err-solid)" : "var(--line-strong)"}`,
                  borderRadius: "50%",
                  background: "var(--surface-card)",
                  outline: "none",
                  boxShadow:
                    focusedValue === option.value
                      ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)"
                      : "none",
                  cursor: optionDisabled ? "not-allowed" : "pointer",
                  opacity: optionDisabled ? 0.45 : 1,
                }}
              >
                <RadixRadioGroup.Indicator
                  aria-hidden="true"
                  className="mk-radio-group__indicator"
                />
              </RadixRadioGroup.Item>
              <span
                id={`${optionId}-label`}
                style={{ font: "var(--text-body)", color: "var(--fg-1)" }}
              >
                {option.label}
              </span>
            </div>
          );
        })}
      </RadixRadioGroup.Root>
      {(error || hint) && (
        <span
          id={error ? errorId : hintId}
          style={{ font: "var(--text-body-sm)", color: error ? "var(--err-fg)" : "var(--fg-3)" }}
        >
          {error || hint}
        </span>
      )}
      <style>{`
        .mk-radio-group__control[data-state="checked"] {
          border-color: var(--surface-inverse);
        }
        .mk-radio-group__indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--surface-inverse);
        }
      `}</style>
    </div>
  );
}
