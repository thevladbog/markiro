import { Button } from "@markiro/ui";
import { FloorFooter } from "../FloorFooter.js";

export interface WorkFooterProps {
  labels: { exceptions: string; pause: string; close: string; more?: string };
  onExceptions: () => void;
  onPause: () => void;
  onClose: () => void;
  /**
   * Opens the overflow menu (currently: closing the shift's current pallet
   * early). Omitted entirely on a shift with no pallets -- the button only
   * renders when both this and `labels.more` are given, so every existing
   * caller that never had an overflow action keeps its exact three-button
   * footer.
   */
  onMore?: () => void;
  closeDisabled?: boolean;
}

export function WorkFooter({
  labels,
  onExceptions,
  onPause,
  onClose,
  onMore,
  closeDisabled = false,
}: WorkFooterProps) {
  const showMore = Boolean(onMore && labels.more);
  return (
    <FloorFooter
      className="work-footer"
      ariaLabel={
        showMore
          ? `${labels.exceptions}, ${labels.pause}, ${labels.close}, ${labels.more}`
          : `${labels.exceptions}, ${labels.pause}, ${labels.close}`
      }
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
      {showMore ? (
        <Button
          size="floor"
          variant="secondary"
          className="work-footer__action work-footer__action--more"
          style={{ width: "120px", maxWidth: "100%" }}
          onClick={(event) => {
            onMore?.();
            event.currentTarget.blur();
          }}
        >
          {labels.more}
        </Button>
      ) : null}
    </FloorFooter>
  );
}
