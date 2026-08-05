import {
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button, type ButtonProps } from "./Button.js";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  "aria-label": string;
  icon: ReactNode;
}

export function IconButton({
  icon,
  size = "md",
  style,
  onFocus,
  onBlur,
  onPointerDown,
  ...props
}: IconButtonProps) {
  const pointerOriginRef = useRef(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const dimension = size === "compact" ? "var(--control-sm)" : "var(--control-md)";

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    pointerOriginRef.current = true;
    setFocusVisible(false);
    onPointerDown?.(event);
  };

  const handleFocus = (event: FocusEvent<HTMLButtonElement>) => {
    setFocusVisible(!pointerOriginRef.current);
    onFocus?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    pointerOriginRef.current = false;
    setFocusVisible(false);
    onBlur?.(event);
  };

  return (
    <Button
      {...props}
      size={size}
      icon={icon}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onPointerDown={handlePointerDown}
      className={["mk-icon-button", props.className].filter(Boolean).join(" ")}
      {...(focusVisible ? { "data-focus-visible": true } : {})}
      style={
        {
          width: dimension,
          minWidth: dimension,
          padding: 0,
          gap: 0,
          ...style,
          ...(focusVisible
            ? {
                outline: "2px solid var(--focus-ring)",
                outlineOffset: 2,
                boxShadow: "0 0 0 2px color-mix(in srgb, var(--focus-ring) 25%, transparent)",
              }
            : {}),
        } satisfies CSSProperties
      }
    />
  );
}
