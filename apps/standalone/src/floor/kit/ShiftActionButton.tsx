import { Button, type ButtonProps } from "@markiro/ui";

import { Glyph, type GlyphName } from "./StatusIcons.js";

const glyphs = {
  exceptions: "warning",
  history: "clipboard",
  undo: "arrow-left",
  pause: "pause",
  close: "octagon-stop",
} as const satisfies Record<string, GlyphName>;

type ShiftActionButtonProps = Omit<ButtonProps, "size" | "variant" | "className" | "icon"> & {
  action: keyof typeof glyphs;
  footer?: boolean;
};

export function ShiftActionButton({ action, footer = false, ...props }: ShiftActionButtonProps) {
  return (
    <Button
      {...props}
      size="floor"
      variant={action === "close" ? "destructive" : "secondary"}
      className={footer ? "work-footer__action floor-primary" : undefined}
      data-shift-action={action}
      icon={<Glyph name={glyphs[action]} />}
    />
  );
}
