import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { useId, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "../cn.js";

export interface CheckboxProps {
  label: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export function Checkbox({
  label,
  checked,
  onCheckedChange,
  hint,
  error,
  disabled = false,
  name,
  id,
  className,
  style,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  const [focused, setFocused] = useState(false);
  const autoId = useId();
  const checkboxId = id ?? `mk-checkbox-${autoId}`;
  const labelId = `${checkboxId}-label`;
  const hintId = hint ? `${checkboxId}-hint` : undefined;
  const errorId = error ? `${checkboxId}-error` : undefined;

  return (
    <div
      className={cn("mk-field", "mk-checkbox", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <RadixCheckbox.Root
          id={checkboxId}
          onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked === true)}
          disabled={disabled}
          {...(checked === undefined ? {} : { checked })}
          {...(name === undefined ? {} : { name })}
          {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
          {...(ariaLabel === undefined ? { "aria-labelledby": labelId } : {})}
          {...(error ? { "aria-invalid": true } : {})}
          {...(errorId || hintId ? { "aria-describedby": errorId ?? hintId } : {})}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="mk-checkbox__control"
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
            borderRadius: "var(--r-1)",
            color: "var(--fg-on-inverse)",
            outline: "none",
            boxShadow: focused
              ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)"
              : "none",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1,
          }}
        >
          <RadixCheckbox.Indicator aria-hidden="true" style={{ display: "flex" }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
          </RadixCheckbox.Indicator>
        </RadixCheckbox.Root>
        <span id={labelId} style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
          {label}
        </span>
      </div>
      {(error || hint) && (
        <span
          id={error ? errorId : hintId}
          style={{ font: "var(--text-body-sm)", color: error ? "var(--err-fg)" : "var(--fg-3)" }}
        >
          {error || hint}
        </span>
      )}
      <style>{`
        .mk-checkbox__control[data-state="checked"],
        .mk-checkbox__control[data-state="indeterminate"] {
          background: var(--surface-inverse);
          border-color: var(--surface-inverse);
        }
      `}</style>
    </div>
  );
}
