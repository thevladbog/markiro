import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, ConfirmDialog, SidePanel, type SidePanelSize } from "@markiro/ui";

import { useReportDirty } from "./dirty-guard.js";

export interface EntityDrawerProps {
  title: string;
  /** The submit button's text. */
  submitLabel: string;
  /** Keeps the submit button off, for example until something changed. */
  submitDisabled?: boolean;
  /** `destructive` for an action that takes a record out of use (archive, revoke). */
  submitVariant?: "primary" | "destructive";
  /** What is typed and not saved yet: closing then asks first. */
  dirty: boolean;
  /** The panel's width class of `@markiro/ui`; `complex` (720 px) by default. */
  size?: SidePanelSize;
  /**
   * Sends the form; the drawer waits until the promise settles. It sorts its
   * own failures into a field error or the `alert` and must not reject, as
   * with `FormDialog`.
   */
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onClose: () => void;
  /** Above the fields: a failed write (`WriteFailureAlert`), or nothing. */
  alert?: ReactNode;
  /** Above the form's fields and part of the drawer, not of the form (a photo written on its own). */
  top?: ReactNode;
  children: ReactNode;
}

/**
 * The office's drawer for a record's form (owner decision after beta 3: a
 * record with many fields or long values opens from the right, not as a
 * modal): a header, a body that scrolls and a footer that stays, with
 * «Отмена» and the submit button, which the form owns through `form`. It is
 * `FormDialog`'s contract in a `SidePanel`:
 *
 * - from the submit until `onSubmit` settles, Escape, the backdrop, the ×
 *   and «Отмена» do not close it and a second submit is dropped;
 * - with `dirty`, every way of closing asks «Закрыть без сохранения?» first,
 *   and answering «Вернуться» keeps the form as it was;
 * - a select's list or a date picker's popover inside it takes its own
 *   Escape and clicks, and does not close the drawer.
 */
export function EntityDrawer({
  title,
  submitLabel,
  submitDisabled = false,
  submitVariant = "primary",
  dirty,
  size = "complex",
  onSubmit,
  onClose,
  alert,
  top,
  children,
}: EntityDrawerProps) {
  const { t } = useTranslation();
  const formId = useId();
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(false);
  // The header's «Выйти» asks before it throws away what is typed here.
  useReportDirty(dirty);
  const close = () => {
    if (inFlight.current) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    void new Promise<void>((resolve) => resolve(onSubmit(event))).finally(() => {
      inFlight.current = false;
      setSending(false);
    });
  };
  return (
    <>
      <SidePanel
        open
        // A long name stays two lines at most, with the whole of it as the tooltip
        // (and as the dialog's accessible name): it must not eat the form's room.
        title={
          <span className="entity-drawer__title" title={title}>
            {title}
          </span>
        }
        size={size}
        busy={sending}
        closeLabel={t("office.common.close")}
        onClose={close}
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
        <div className="standalone-form">
          {top}
          <form id={formId} className="standalone-form" onSubmit={send} noValidate>
            {alert}
            {children}
          </form>
        </div>
      </SidePanel>
      <ConfirmDialog
        open={asking}
        title={t("office.drawer.discardTitle")}
        description={t("office.drawer.discardBody")}
        confirmLabel={t("office.drawer.discard")}
        cancelLabel={t("office.drawer.keepEditing")}
        tone="destructive"
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
        onCancel={() => setAsking(false)}
      />
    </>
  );
}
