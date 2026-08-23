export type BoxExceptionAction = "undo" | "clear" | "reprint" | "disassemble";

export interface ExceptionActionEntry {
  label: string;
  /** One line under the label: what the action will actually do. */
  hint: string;
}

export interface ExceptionActionsProps {
  undo: ExceptionActionEntry;
  clear: ExceptionActionEntry;
  reprint: ExceptionActionEntry;
  disassemble: ExceptionActionEntry;
  canUndo: boolean;
  hasOpenBox: boolean;
  hasClosedBoxes: boolean;
  onSelect: (action: BoxExceptionAction) => void;
}

const GLYPHS: Record<BoxExceptionAction, string> = {
  undo: "↩",
  clear: "⌫",
  reprint: "⎙",
  disassemble: "✕",
};

/**
 * Equal-height action cards. Plain buttons rather than @markiro/ui Buttons:
 * each card carries a label AND an explanatory hint line, which the shared
 * Button's single-line floor layout was never meant to hold. The aria-label
 * pins the accessible name to the label alone so the hint stays visual.
 */
export function ExceptionActions({
  undo,
  clear,
  reprint,
  disassemble,
  canUndo,
  hasOpenBox,
  hasClosedBoxes,
  onSelect,
}: ExceptionActionsProps) {
  const card = (
    action: BoxExceptionAction,
    entry: ExceptionActionEntry,
    enabled: boolean,
  ): React.JSX.Element => (
    <button
      type="button"
      className="exception-action"
      data-action={action}
      aria-label={entry.label}
      disabled={!enabled}
      onClick={() => onSelect(action)}
    >
      <span className="exception-action__title">
        <span aria-hidden="true" className="exception-action__glyph">
          {GLYPHS[action]}
        </span>
        {entry.label}
      </span>
      <span className="exception-action__hint">{entry.hint}</span>
    </button>
  );

  return (
    <div className="exception-actions">
      {card("undo", undo, canUndo)}
      {card("clear", clear, hasOpenBox)}
      {card("reprint", reprint, hasClosedBoxes)}
      {card("disassemble", disassemble, hasClosedBoxes)}
    </div>
  );
}
