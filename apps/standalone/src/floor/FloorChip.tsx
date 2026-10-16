import { Glyph } from "./kit/StatusIcons.js";
import type { ChipIcon, ChipKind, ChipTone } from "./header-chips.js";

export interface FloorChipProps {
  kind: ChipKind;
  tone: ChipTone;
  icon: ChipIcon;
  /** The words: always in the tree; a collapsed chip hides them from the eye, not from a reader. */
  text: string;
  /** `icon`: the chip is its glyph alone (a healthy chip when the row is tight). */
  form: "full" | "icon";
  /** The full detail as the tooltip. */
  title?: string;
  className?: string;
}

/**
 * One chip of the floor's header: a glyph and a word on a tone (the kit's status vocabulary, the
 * tone is never the only sign). 40 px high; the hit target round a pressable one is made by its
 * button, as the link's.
 */
export function FloorChip({ kind, tone, icon, text, form, title, className }: FloorChipProps) {
  return (
    <div
      className={className === undefined ? "floor-chip" : `floor-chip ${className}`}
      data-chip={kind}
      data-tone={tone}
      data-form={form}
      title={title ?? text}
    >
      <Glyph name={icon} size={22} />
      <span className={form === "icon" ? "station-visually-hidden" : "floor-chip__text"}>
        {text}
      </span>
    </div>
  );
}
