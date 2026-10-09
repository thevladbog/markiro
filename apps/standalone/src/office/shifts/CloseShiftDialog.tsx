import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Textarea } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { shiftClose } from "../../host/requests.js";
import { closeReasonRule } from "../../lib/rules.js";
import type { AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert, WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";

const closeSchema = z.object({ reason: closeReasonRule });
type CloseValues = z.input<typeof closeSchema>;

export interface CloseShiftDialogProps {
  /** An active shift. */
  shift: OfficeShift;
  onClose: () => void;
  onClosed: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was closed or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * Closes an active shift from the office, with the reason in words (3 to 500
 * characters, counted as the host counts them, with no line break or other
 * control character: the rule says so under the field), over the revision the
 * dialog was opened on: for a station that died or a shift nobody will finish.
 */
export function CloseShiftDialog({
  shift,
  onClose,
  onClosed,
  onReload,
  onOutdated,
}: CloseShiftDialogProps) {
  const { t } = useTranslation();
  const noteId = useId();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says the shift was closed or deleted meanwhile: a resend would
  // be refused the same way, so «Закрыть смену» stays off and the alert offers to load the list.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const close = useOfficeMutation((api, token, reason: string) =>
    api.closeShift(token, shift.id, shiftClose(reason, shift.rev)),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CloseValues>({
    resolver: zodResolver(closeSchema),
    defaultValues: { reason: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let closed: OfficeShift;
    try {
      // The rule trimmed the reason: what is sent is what the host keeps.
      closed = await close.mutateAsync(values.reason);
    } catch (error) {
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        reason: { field: "reason", message: "rules.closeReason" },
      });
      if (outcome.kind === "field") {
        setError(
          outcome.field,
          { type: "server", message: outcome.message },
          { shouldFocus: true },
        );
      } else if (outdated && outcome.kind === "alert") {
        setOutdatedMessage(outcome.message);
      } else {
        setFailure(outcome);
        rereadIfLost(error);
      }
      if (outdated) onOutdated();
      return;
    }
    onClosed(closed);
  });

  const message = errors.reason?.message;
  return (
    <FormDialog
      title={t("office.shifts.closeTitle", { number: shift.number })}
      submitLabel={t("office.shifts.closeSubmit")}
      submitVariant="destructive"
      submitDisabled={outdatedMessage !== null}
      onSubmit={submit}
      onClose={onClose}
      alert={
        outdatedMessage !== null ? (
          <StaleAlert onReload={onReload} message={outdatedMessage} />
        ) : (
          <WriteFailureAlert failure={failure} onReload={onReload} />
        )
      }
    >
      <p>{t("office.shifts.closeIntro")}</p>
      <Textarea
        label={t("office.shifts.fields.reason")}
        rows={4}
        // Read-only, not disabled, while the write is on its way: a disabled field would
        // lose the focus a refused reason is given back.
        readOnly={isSubmitting}
        aria-invalid={message === undefined ? undefined : true}
        aria-describedby={noteId}
        {...register("reason")}
      />
      <span
        id={noteId}
        className={message === undefined ? "shift-note" : "shift-note shift-note--error"}
        aria-live="polite"
      >
        {message === undefined ? t("office.shifts.fields.reasonHint") : t(message)}
      </span>
    </FormDialog>
  );
}
