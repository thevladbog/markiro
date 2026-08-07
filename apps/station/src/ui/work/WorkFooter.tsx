import { Button } from "@markiro/ui";
import { FloorFooter } from "../FloorFooter.js";

export interface WorkFooterProps {
  labels: { exceptions: string; exit: string };
  onExceptions: () => void;
  onExit: () => void;
}

export function WorkFooter({ labels, onExceptions, onExit }: WorkFooterProps) {
  return (
    <FloorFooter ariaLabel={`${labels.exceptions}, ${labels.exit}`}>
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
          onExit();
          event.currentTarget.blur();
        }}
      >
        {labels.exit}
      </Button>
    </FloorFooter>
  );
}
