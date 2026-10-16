import { Button } from "@markiro/ui";

export interface SortToggleProps {
  /** The visible, short label: «пр.», «смена». */
  label: string;
  /** The accessible name: «Сортировать по дате производства». */
  ariaLabel: string;
  /** This key is the one the table is sorted by. */
  active: boolean;
  dir: "asc" | "desc";
  onToggle: () => void;
}

/**
 * A second sort key in a heading that shows two values in one column (the dates of a shift, the
 * plan beside the output). The heading's own cell sorts by the first; this chip sorts by the other,
 * says so with `aria-pressed` and an arrow, and never by colour alone.
 */
export function SortToggle({ label, ariaLabel, active, dir, onToggle }: SortToggleProps) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className="office-sort-toggle"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={(event) => {
        // The heading's cell sorts by its own key when it is pressed; this chip is not that.
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {label}
      {active && <span aria-hidden="true">{dir === "desc" ? "↓" : "↑"}</span>}
    </Button>
  );
}
