import { Button } from "@markiro/ui";
import { FloorFooter } from "../FloorFooter.js";

export interface WorkFooterProps {
  labels: { exceptions: string; pause: string; close: string };
  onExceptions: () => void;
  onPause: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
}

export function WorkFooter({
  labels,
  onExceptions,
  onPause,
  onClose,
  closeDisabled = false,
}: WorkFooterProps) {
  return (
    <FloorFooter
      className="work-footer"
      ariaLabel={`${labels.exceptions}, ${labels.pause}, ${labels.close}`}
    >
      <Button
        size="floor"
        variant="secondary"
        className="work-footer__action"
        style={{ width: "220px", maxWidth: "100%" }}
        onClick={(event) => {
          onExceptions();
          event.currentTarget.blur();
        }}
      >
        {labels.exceptions}
      </Button>
      <Button
        size="floor"
        variant="warning-outline"
        className="work-footer__action"
        style={{ width: "220px", maxWidth: "100%" }}
        onClick={(event) => {
          onPause();
          event.currentTarget.blur();
        }}
      >
        {labels.pause}
      </Button>
      <Button
        size="floor"
        variant="destructive-outline"
        disabled={closeDisabled}
        className="work-footer__action"
        style={{ width: "220px", maxWidth: "100%" }}
        onClick={(event) => {
          onClose();
          event.currentTarget.blur();
        }}
      >
        {labels.close}
      </Button>
    </FloorFooter>
  );
}
