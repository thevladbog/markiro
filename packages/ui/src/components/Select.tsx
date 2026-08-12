import * as RadixSelect from "@radix-ui/react-select";
import { useId, useState, type CSSProperties, type FocusEvent } from "react";

import { cn } from "../cn.js";
import { useOverlayPortalContainer } from "./OverlayLayer.js";

const EMPTY_OPTION_VALUE = "__markiro_empty_option__";

export type SelectOption<TValue extends string = string> =
  TValue | { value: TValue; label: string; disabled?: boolean };
export type SelectSize = "md" | "floor";

export interface SelectProps<TValue extends string = string> {
  label?: string;
  /** Строки или { value, label, disabled } */
  options: SelectOption<TValue>[];
  value?: TValue;
  onValueChange?: (value: TValue) => void;
  hint?: string;
  error?: string;
  size?: SelectSize;
  /** Keep native select semantics for forms that rely on browser option behavior. */
  native?: boolean;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  /** Text shown when no value is selected. An empty option label takes precedence. */
  placeholder?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

function normalizeOption<TValue extends string>(option: SelectOption<TValue>) {
  return typeof option === "string" ? { value: option, label: option, disabled: false } : option;
}

export function Select<TValue extends string = string>({
  label,
  options,
  value,
  onValueChange,
  disabled,
  name,
  required,
  placeholder,
  hint,
  error,
  size = "md",
  native = false,
  className,
  style,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps<TValue>) {
  const overlayPortalContainer = useOverlayPortalContainer();
  const [focus, setFocus] = useState(false);
  const autoId = useId();
  const selectId = id ?? `mk-select-${autoId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = errorId ?? hintId;
  const normalizedOptions = options.map(normalizeOption);
  const emptyOptionLabel = normalizedOptions.find((option) => option.value === "")?.label;
  const itemOptions = normalizedOptions.map((option) =>
    option.value === "" ? { ...option, value: EMPTY_OPTION_VALUE } : option,
  );

  if (size === "floor" || native) {
    const floor = size === "floor";
    return (
      <div
        className={cn("mk-field", className)}
        style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
      >
        {label && (
          <label
            htmlFor={selectId}
            style={{
              font: floor ? "var(--floor-body-strong)" : "var(--text-caption)",
              color: "var(--fg-2)",
            }}
          >
            {label}
          </label>
        )}
        <span style={{ position: "relative", display: "flex" }}>
          <select
            id={selectId}
            {...(value === undefined ? {} : { value })}
            {...(name === undefined ? {} : { name })}
            {...(required === undefined ? {} : { required })}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onValueChange?.(event.target.value as TValue)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            className="mk-select__control"
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              width: "100%",
              height: floor ? "var(--control-floor)" : "var(--control-md)",
              padding: floor ? "0 48px 0 16px" : "0 40px 0 12px",
              borderRadius: "var(--r-2)",
              background: "var(--surface-card)",
              color: "var(--fg-1)",
              border: `1px solid ${
                error ? "var(--err-solid)" : focus ? "var(--focus-ring)" : "var(--line-strong)"
              }`,
              boxShadow: focus
                ? "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)"
                : "none",
              font: floor ? "var(--floor-body)" : "var(--text-body)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
            }}
          >
            {placeholder && emptyOptionLabel === undefined ? (
              <option value="" disabled>
                {placeholder}
              </option>
            ) : null}
            {normalizedOptions.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
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
              right: floor ? 16 : 12,
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
              font: floor ? "var(--floor-body)" : "var(--text-caption)",
              color: error ? "var(--err-fg)" : "var(--fg-3)",
            }}
          >
            {error || hint}
          </span>
        )}
      </div>
    );
  }

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
        {...(onValueChange === undefined
          ? {}
          : {
              onValueChange: (nextValue: string) =>
                onValueChange((nextValue === EMPTY_OPTION_VALUE ? "" : nextValue) as TValue),
            })}
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
          <RadixSelect.Value placeholder={emptyOptionLabel ?? placeholder} />
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
        <RadixSelect.Portal
          {...(overlayPortalContainer === undefined ? {} : { container: overlayPortalContainer })}
        >
          <RadixSelect.Content
            data-mk-nested-overlay=""
            data-position="popper"
            position="popper"
            sideOffset={4}
            collisionPadding={8}
            className="mk-select__content"
            style={{
              zIndex: "var(--z-overlay-popover)",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              background: "var(--surface-card)",
              color: "var(--fg-1)",
              boxShadow: "0 12px 32px color-mix(in srgb, var(--fg-1) 18%, transparent)",
            }}
          >
            <RadixSelect.Viewport className="mk-select__viewport">
              {itemOptions.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  {...(option.disabled ? { disabled: true } : {})}
                  className="mk-select__item"
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    minHeight: "var(--control-md)",
                    padding: "0 32px 0 12px",
                    borderRadius: "calc(var(--r-2) - 2px)",
                    background: "transparent",
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
