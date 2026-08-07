import { useState } from "react";
import { Button, FullScreenDialog } from "@markiro/ui";

export interface OtherReasonDialogProps {
  open: boolean;
  title: string;
  label: string;
  backLabel: string;
  useLabel: string;
  onClose: () => void;
  onUse: (reason: string) => void;
}

export function OtherReasonDialog({
  open,
  title,
  label,
  backLabel,
  useLabel,
  onClose,
  onUse,
}: OtherReasonDialogProps) {
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();

  return (
    <FullScreenDialog
      open={open}
      title={title}
      backLabel={backLabel}
      onClose={() => {
        setReason("");
        onClose();
      }}
      footer={
        <Button
          size="floor"
          disabled={!trimmedReason}
          onClick={() => {
            onUse(trimmedReason);
            setReason("");
          }}
        >
          {useLabel}
        </Button>
      }
    >
      <div className="exception-other-reason">
        <label htmlFor="exception-other-reason">{label}</label>
        <textarea
          id="exception-other-reason"
          value={reason}
          maxLength={500}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </FullScreenDialog>
  );
}
