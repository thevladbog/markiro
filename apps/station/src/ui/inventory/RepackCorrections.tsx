import { Button } from "@markiro/ui";

export interface RepackCorrectionsProps {
  itemCount: number;
  busy: boolean;
  onRemoveLast: () => void;
  onClear: () => void;
  onCloseIncomplete: () => void;
  labels: { removeLast: string; clear: string; closeIncomplete: string; empty: string };
}

export function RepackCorrections({
  itemCount,
  busy,
  onRemoveLast,
  onClear,
  onCloseIncomplete,
  labels,
}: RepackCorrectionsProps) {
  if (itemCount === 0) return <p>{labels.empty}</p>;
  return (
    <div className="repack-corrections">
      <Button size="floor" variant="secondary" disabled={busy} onClick={onRemoveLast}>
        {labels.removeLast}
      </Button>
      <Button size="floor" variant="secondary" disabled={busy} onClick={onClear}>
        {labels.clear}
      </Button>
      <Button size="floor" disabled={busy} onClick={onCloseIncomplete}>
        {labels.closeIncomplete}
      </Button>
    </div>
  );
}
