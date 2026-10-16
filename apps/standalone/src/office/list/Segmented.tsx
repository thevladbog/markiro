import { useRef, type KeyboardEvent } from "react";

import { Button } from "@markiro/ui";

import { OfficeIcon } from "../OfficeIcon.js";
import { nextEnabled } from "./menu-model.js";
import { segmentKeyMove } from "./segment-model.js";

export interface SegmentOption<Id extends string = string> {
  id: Id;
  label: string;
  disabled?: boolean;
  /** The id of the panel a tab controls (`aria-controls`). */
  panelId?: string;
}

export interface SegmentedProps<Id extends string = string> {
  options: readonly SegmentOption<Id>[];
  /** The selected option; `null` when none is (a custom period): the first one is then the tab stop. */
  value: Id | null;
  onChange: (id: Id) => void;
  /** The group's accessible name. */
  label: string;
  /**
   * `choice`: one value of a filter (`radiogroup`); `tabs`: the parts of a page (`tablist`, the
   * selected one controls the page below). The look and the keyboard are the same.
   */
  mode?: "choice" | "tabs";
  /** The track's width: the content's own (default) or the whole row. */
  fill?: boolean;
}

/**
 * The kit's segmented control: a `panel` track with 40 px segments, the selected one a `fg` fill
 * with a check and a heavier weight (never colour alone). One tab stop (roving tabindex): the
 * arrows, Home and End move the focus and select, as a radio group and a tab list both do.
 */
export function Segmented<Id extends string>({
  options,
  value,
  onChange,
  label,
  mode = "choice",
  fill = false,
}: SegmentedProps<Id>) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());
  const tabs = mode === "tabs";

  const move = (event: KeyboardEvent<HTMLButtonElement>, id: Id) => {
    const direction = segmentKeyMove(event.key);
    if (direction === null) return;
    event.preventDefault();
    const index = nextEnabled(
      direction,
      options.findIndex((option) => option.id === id),
      options.map((option) => option.disabled === true),
    );
    const next = index === null ? undefined : options[index];
    if (next === undefined) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  return (
    <div
      className={fill ? "office-segmented office-segmented--fill" : "office-segmented"}
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={label}
    >
      {options.map((option, index) => {
        const selected = option.id === value;
        const stop = selected || (value === null && index === 0);
        return (
          <Button
            key={option.id}
            variant="plain"
            ref={(node) => {
              if (node) refs.current.set(option.id, node);
              else refs.current.delete(option.id);
            }}
            role={tabs ? "tab" : "radio"}
            aria-label={option.label}
            {...(tabs ? { "aria-selected": selected } : { "aria-checked": selected })}
            {...(tabs && option.panelId !== undefined ? { "aria-controls": option.panelId } : {})}
            tabIndex={stop ? 0 : -1}
            disabled={option.disabled ?? false}
            className={
              selected
                ? "office-segmented__item office-segmented__item--selected"
                : "office-segmented__item"
            }
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => move(event, option.id)}
          >
            {selected && <OfficeIcon name="check" size={16} />}
            <span>{option.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
