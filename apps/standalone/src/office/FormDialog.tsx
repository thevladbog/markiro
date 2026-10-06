import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, Modal } from "@markiro/ui";

export interface FormDialogProps {
  title: string;
  /** The submit button's text. */
  submitLabel: string;
  /** Keeps the submit button off, for example until something changed. */
  submitDisabled?: boolean;
  /** `destructive` for an action that takes a record out of use (archive, revoke). */
  submitVariant?: "primary" | "destructive";
  /** `false` hides a dialog that stays mounted between openings; open by default. */
  open?: boolean;
  /** The dialog's width (`Modal`'s); 480 px by default. */
  width?: number | string;
  /**
   * Sends the form; the dialog waits until the promise settles. It sorts its
   * own failures into a field error or the `alert` and must not reject: a
   * rejection, or a throw before the promise, still releases the dialog but
   * surfaces as an unhandled rejection. That is intended: a `.catch` here
   * would hide a bug in the caller.
   */
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onClose: () => void;
  /** Above the fields: a failed write (`WriteFailureAlert`), or nothing. */
  alert?: ReactNode;
  children: ReactNode;
}

/**
 * An office dialog around one form: the title, the fields, and a footer with
 * «Отмена» and the submit button, which the form owns through `form`. From
 * the submit until `onSubmit` settles, Escape, the overlay, the × and
 * «Отмена» do not close it and a second submit is dropped: a request in
 * flight is never abandoned or sent twice, and its error is not wiped from
 * under it.
 */
export function FormDialog({
  title,
  submitLabel,
  submitDisabled = false,
  submitVariant = "primary",
  open = true,
  width,
  onSubmit,
  onClose,
  alert,
  children,
}: FormDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  // Set at once, so a second submit or a close in the same moment is refused
  // before `sending` has re-rendered the buttons.
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const close = () => {
    if (!inFlight.current) onClose();
  };
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    // `onSubmit` may throw before it returns a promise: wrapping the call turns
    // that into a rejection too, so the flag is released either way.
    void new Promise<void>((resolve) => resolve(onSubmit(event))).finally(() => {
      inFlight.current = false;
      setSending(false);
    });
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      closeLabel={t("office.common.close")}
      {...(width === undefined ? {} : { width })}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={sending}>
            {t("office.common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={submitVariant}
            loading={sending}
            disabled={submitDisabled}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="standalone-form" onSubmit={send} noValidate>
        {alert}
        {children}
      </form>
    </Modal>
  );
}
