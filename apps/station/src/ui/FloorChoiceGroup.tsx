import { useRef, type KeyboardEvent } from "react";
import { cn } from "@markiro/ui";

export interface FloorChoice {
  value: string;
  label: string;
}

export interface FloorChoiceGroupProps {
  /** Accessible name of the group — the question the choices answer. */
  label: string;
  choices: readonly FloorChoice[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Floor-sized stand-in for a native `<select>` on the station's touch screen.
 * The platform dropdown opens a mouse-sized list outside the overlay, unstyled
 * and far below the 64px glove target the floor UI holds everywhere else, and
 * it hides every option but one behind a tap. Here all options stay visible as
 * touch targets, and the group keeps the standard radiogroup keyboard
 * contract: Tab enters and leaves it, arrows and Home/End move the selection.
 */
export function FloorChoiceGroup({
  label,
  choices,
  value,
  onChange,
  disabled = false,
  className,
}: FloorChoiceGroupProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = choices.findIndex((choice) => choice.value === value);
  // Nothing selected yet still needs one tab stop, or the group would be
  // unreachable from the keyboard.
  const focusIndex = selectedIndex === -1 ? 0 : selectedIndex;

  function select(index: number): void {
    const choice = choices[index];
    if (!choice) return;
    onChange(choice.value);
    buttons.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled || choices.length === 0) return;
    const last = choices.length - 1;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        select(focusIndex === last ? 0 : focusIndex + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        select(focusIndex === 0 ? last : focusIndex - 1);
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(last);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("floor-choice-group", className)}
      onKeyDown={onKeyDown}
    >
      {choices.map((choice, index) => (
        <button
          key={choice.value}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          disabled={disabled}
          tabIndex={index === focusIndex ? 0 : -1}
          className="floor-choice"
          onClick={() => onChange(choice.value)}
        >
          {/* The selected option is marked by this filled dot as well as by
              colour, so it stays readable on a washed-out floor screen. */}
          <span aria-hidden="true" className="floor-choice__mark" />
          <span className="floor-choice__label">{choice.label}</span>
        </button>
      ))}
    </div>
  );
}
