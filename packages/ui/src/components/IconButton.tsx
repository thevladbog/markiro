import type { CSSProperties, ReactNode } from "react";

import { Button, type ButtonProps } from "./Button.js";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  "aria-label": string;
  icon: ReactNode;
}

export function IconButton({ icon, size = "md", style, ...props }: IconButtonProps) {
  const dimension = size === "compact" ? "var(--control-sm)" : "var(--control-md)";

  return (
    <>
      <Button
        {...props}
        size={size}
        icon={icon}
        className={["mk-icon-button", props.className].filter(Boolean).join(" ")}
        style={
          {
            width: dimension,
            minWidth: dimension,
            padding: 0,
            gap: 0,
            ...style,
          } satisfies CSSProperties
        }
      />
      <style>{`
        .mk-icon-button:focus-visible {
          outline: 2px solid var(--focus-ring) !important;
          outline-offset: 2px !important;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent) !important;
        }
      `}</style>
    </>
  );
}
