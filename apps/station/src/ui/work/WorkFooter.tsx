import { Button } from "@markiro/ui";
import { FloorFooter } from "../FloorFooter.js";

export interface WorkFooterProps {
  labels: { exceptions: string; pause: string; close: string };
  onExceptions: () => void;
  onPause: () => void;
  onClose: () => void;
}

export function WorkFooter({ labels, onExceptions, onPause, onClose }: WorkFooterProps) {
  return (
    <FloorFooter ariaLabel={`${labels.exceptions}, ${labels.pause}, ${labels.close}`}>
      <Button
        size="floor"
        variant="secondary"
        onClick={(event) => {
          onExceptions();
          event.currentTarget.blur();
        }}
      >
        {labels.exceptions}
      </Button>
      <Button
        size="floor"
        variant="secondary"
        onClick={(event) => {
          onPause();
          event.currentTarget.blur();
        }}
      >
        {labels.pause}
      </Button>
      <Button
        size="floor"
        variant="secondary"
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
