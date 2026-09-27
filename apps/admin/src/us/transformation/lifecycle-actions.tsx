import { useEffect, useRef, useState } from "react";
import { Button, Textarea } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { TransformationHttpRecord } from "@markiro/platform-contracts";

export type TransformationLifecycleAction = "amend" | "void";

/** Keeps the confirmation in the editor tree so a capability refresh closes it safely. */
export function TransformationLifecycleActions({
  record,
  canManageQa,
  disabled,
  onSubmit,
  onReasonDirtyChange,
}: {
  record: TransformationHttpRecord;
  canManageQa: boolean;
  disabled: boolean;
  onSubmit: (action: TransformationLifecycleAction, reason: string) => Promise<void>;
  onReasonDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<TransformationLifecycleAction | null>(null);
  const [reason, setReason] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => onReasonDirtyChange(reason.length > 0), [onReasonDirtyChange, reason]);
  useEffect(() => () => onReasonDirtyChange(false), [onReasonDirtyChange]);
  function close() {
    setAction(null);
    setReason("");
    trigger.current?.focus();
  }
  const originalDraft = record.status === "draft" && record.revision === 1;
  const canAmend =
    record.status === "finalized" &&
    record.lifecycle?.currentEventId === record.id &&
    record.lifecycle.pendingDraftId === null;
  const canVoid = originalDraft || canAmend;
  if (!canManageQa || (!canAmend && !canVoid)) return null;
  return (
    <section className="us-tr-lifecycle" aria-label={t("transformation.qaOnly")}>
      {canAmend ? (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={(event) => {
            if (disabled) return;
            trigger.current = event.currentTarget;
            setAction("amend");
          }}
        >
          {t("transformation.amendment")}
        </Button>
      ) : null}
      {canVoid ? (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={(event) => {
            if (disabled) return;
            trigger.current = event.currentTarget;
            setAction("void");
          }}
        >
          {t("transformation.void")}
        </Button>
      ) : null}
      {action ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(action === "amend" ? "transformation.amendment" : "transformation.void")}
          className="us-tr-dialog"
        >
          <h3>{t(action === "amend" ? "transformation.amendment" : "transformation.void")}</h3>
          <p>
            {t(
              action === "amend"
                ? "transformation.amendmentHint"
                : originalDraft
                  ? "transformation.voidDraftHint"
                  : "transformation.voidFinalHint",
            )}
          </p>
          <Textarea
            label={t("transformation.actionReason")}
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="us-tr-actions">
            <Button type="button" variant="secondary" disabled={disabled} onClick={close}>
              {t("transformation.cancel")}
            </Button>
            <Button
              type="button"
              disabled={disabled || !reason.trim() || !canManageQa}
              onClick={() => {
                if (disabled || !canManageQa || !reason.trim()) return;
                void onSubmit(action, reason.trim()).then(close);
              }}
            >
              {t("transformation.confirm")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
