import type { CSSProperties, ReactNode } from "react";

import { Button, type ButtonProps } from "./Button.js";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  "aria-label": string;
  icon: ReactNode;
}

export function IconButton({ icon, size = "md", style, ...props }: IconButtonProps) {
  const dimension = size === "compact" ? "var(--control-sm)" : "var(--control-md)";

  return (
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
  );
}
