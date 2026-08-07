import { Button } from "@markiro/ui";

export type BoxExceptionAction = "undo" | "clear" | "reprint" | "disassemble";

export interface ExceptionActionsProps {
  undoLabel: string;
  clearLabel: string;
  reprintLabel: string;
  disassembleLabel: string;
  canUndo: boolean;
  hasOpenBox: boolean;
  hasClosedBoxes: boolean;
  onSelect: (action: BoxExceptionAction) => void;
}

export function ExceptionActions({
  undoLabel,
  clearLabel,
  reprintLabel,
  disassembleLabel,
  canUndo,
  hasOpenBox,
  hasClosedBoxes,
  onSelect,
}: ExceptionActionsProps) {
  return (
    <div className="exception-actions">
      <Button size="floor" fullWidth disabled={!canUndo} onClick={() => onSelect("undo")}>
        {undoLabel}
      </Button>
      <Button
        size="floor"
        fullWidth
        variant="secondary"
        disabled={!hasOpenBox}
        onClick={() => onSelect("clear")}
      >
        {clearLabel}
      </Button>
      <Button size="floor" fullWidth disabled={!hasClosedBoxes} onClick={() => onSelect("reprint")}>
        {reprintLabel}
      </Button>
      <Button
        size="floor"
        fullWidth
        variant="destructive"
        disabled={!hasClosedBoxes}
        onClick={() => onSelect("disassemble")}
      >
        {disassembleLabel}
      </Button>
    </div>
  );
}
