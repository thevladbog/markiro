import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Port of `design-system/components/feedback/EmptyState.jsx`'s `EmptyState`
 * export (office mode only). The handoff's `icon` prop takes a name from its
 * `<Icon>` set, which this package does not port (see `StatusChip.tsx`); it
 * is replaced with an optional `icon` slot accepting any `ReactNode` so
 * callers can still lead with a glyph/illustration if they want one. The
 * handoff's free-form `children` (description text) is renamed `hint` to
 * match this package's existing `hint` convention (`Input`, `Select`,
 * `Field`). `Skeleton`, the handoff's other export from the same file, is
 * out of scope — not requested by the plan for this task.
 */
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  hint?: ReactNode;
  /** Кнопка действия («Создать задание») */
  action?: ReactNode;
  /** Необязательный слот перед заголовком (глиф/иллюстрация) */
  icon?: ReactNode;
}

export function EmptyState({
  title,
  hint,
  action,
  icon,
  className,
  style,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn("mk-empty-state", className)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 40,
        textAlign: "center",
        ...style,
      }}
      {...rest}
    >
      {icon}
      <div style={{ font: "var(--text-h3)", color: "var(--fg-1)" }}>{title}</div>
      {hint && (
        <div style={{ font: "var(--text-body)", color: "var(--fg-3)", maxWidth: 420 }}>{hint}</div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
