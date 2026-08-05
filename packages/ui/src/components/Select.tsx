import * as RadixSelect from "@radix-ui/react-select";
import { useId, useState, type CSSProperties, type FocusEvent } from "react";

import { cn } from "../cn.js";

export type SelectOption = string | { value: string; label: string; disabled?: boolean };

export interface SelectProps {
  label?: string;
  /** Строки или { value, label, disabled } */
  options: SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

function normalizeOption(option: SelectOption) {
  return typeof option === "string" ? { value: option, label: option, disabled: false } : option;
}

export function Select({
  label,
  options,
  value,
  onValueChange,
  disabled,
  name,
  required,
  hint,
  error,
  className,
  style,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps) {
  const [focus, setFocus] = useState(false);
  const [highlightedValue, setHighlightedValue] = useState<string>();
  const autoId = useId();
  const selectId = id ?? `mk-select-${autoId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = errorId ?? hintId;

  const handleFocus = (_event: FocusEvent<HTMLButtonElement>) => {
    setFocus(true);
  };

  const handleBlur = (_event: FocusEvent<HTMLButtonElement>) => {
    setFocus(false);
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
      <RadixSelect.Root
        {...(value === undefined ? {} : { value })}
        {...(onValueChange === undefined ? {} : { onValueChange })}
        {...(disabled === undefined ? {} : { disabled })}
        {...(name === undefined ? {} : { name })}
        {...(required === undefined ? {} : { required })}
      >
        <RadixSelect.Trigger
          id={selectId}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="mk-select__control"
          style={{
            appearance: "none",
            WebkitAppearance: "none",
            width: "100%",
            height: "var(--control-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "0 12px",
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
        >
          <RadixSelect.Value />
          <RadixSelect.Icon aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            style={{
              zIndex: 1000,
              overflow: "hidden",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              background: "var(--surface-card)",
              color: "var(--fg-1)",
              boxShadow: "0 12px 32px color-mix(in srgb, var(--fg-1) 18%, transparent)",
            }}
          >
            <RadixSelect.Viewport style={{ padding: 4 }}>
              {options.map(normalizeOption).map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  {...(option.disabled ? { disabled: true } : {})}
                  onFocus={() => setHighlightedValue(option.value)}
                  onBlur={() =>
                    setHighlightedValue((current) =>
                      current === option.value ? undefined : current,
                    )
                  }
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    minHeight: "var(--control-md)",
                    padding: "0 32px 0 12px",
                    borderRadius: "calc(var(--r-2) - 2px)",
                    background:
                      highlightedValue === option.value ? "var(--surface-panel)" : "transparent",
                    outline: "none",
                    font: "var(--text-body)",
                    cursor: option.disabled ? "not-allowed" : "pointer",
                    opacity: option.disabled ? 0.45 : 1,
                  }}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      right: 10,
                      display: "flex",
                      color: "var(--accent-fg)",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
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
