import type { TextareaHTMLAttributes } from "react";

import { cn } from "../cn.js";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export function Textarea({ label, id, className, style, ...rest }: TextareaProps) {
  return (
    <label className="mk-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && <span style={{ font: "var(--text-caption)", color: "var(--fg-2)" }}>{label}</span>}
      <textarea
        id={id}
        className={cn("mk-textarea__control", className)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "12px",
          borderRadius: "var(--r-2)",
          background: "var(--surface-card)",
          border: "1px solid var(--line-strong)",
          color: "var(--fg-1)",
          outline: "none",
          font: "var(--text-body)",
          ...style,
        }}
        {...rest}
      />
    </label>
  );
}
