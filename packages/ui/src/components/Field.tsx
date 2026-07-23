import { cloneElement, useId, type CSSProperties, type ReactElement } from "react";

import { cn } from "../cn.js";

/**
 * Field is a Task-2 synthesis — there is no `Field.jsx` in the handoff.
 * `Input`/`Select` already wire their own `error`/`hint` (ported from the
 * handoff), but many controls (native checkboxes, radios, custom widgets)
 * do not. Field gives those a consistent, accessible label/error wrapper by
 * cloning the single child with `id`/`aria-invalid`/`aria-describedby`.
 */
interface FieldableProps {
  id?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}

export interface FieldProps {
  label?: string;
  error?: string;
  hint?: string;
  /** Override the generated id used to associate the label/error with the child */
  htmlFor?: string;
  children: ReactElement;
  className?: string;
  style?: CSSProperties;
}

export function Field({ label, error, hint, htmlFor, children, className, style }: FieldProps) {
  const autoId = useId();
  const fieldId = htmlFor ?? `mk-field-${autoId}`;
  const errorId = error ? `${fieldId}-error` : undefined;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const describedBy = errorId ?? hintId;

  const extraProps: FieldableProps = {
    id: fieldId,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  const control = cloneElement(children, extraProps);

  return (
    <div
      className={cn("mk-field", className)}
      style={{ display: "flex", flexDirection: "column", gap: 6, ...style }}
    >
      {label && (
        <label
          htmlFor={fieldId}
          className="mk-field__label"
          style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}
        >
          {label}
        </label>
      )}
      {control}
      {error && (
        <span
          id={errorId}
          className="mk-field__error"
          style={{ font: "var(--text-body-sm)", color: "var(--err-fg)" }}
        >
          {error}
        </span>
      )}
      {!error && hint && (
        <span
          id={hintId}
          className="mk-field__hint"
          style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}
