import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { DemoDataSummary } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface DeleteDemoDataDialogProps {
  /** What the demo data holds, as the office last read it. */
  summary: DemoDataSummary;
  onClose: () => void;
  /** The demo data is gone (or was already): the office reads its lists again. */
  onDeleted: (removed: DemoDataSummary) => void;
}

/**
 * «Удалить демо-данные?» (spec 2026-10-21): one action, after asking, removes the demo product,
 * its shifts and everything they made. An open demo shift refuses it, and the dialog names it.
 */
export function DeleteDemoDataDialog({ summary, onClose, onDeleted }: DeleteDemoDataDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const remove = useOfficeMutation((api, token, _: undefined) => api.deleteDemoData(token));

  const submit = async () => {
    setFailure(null);
    try {
      onDeleted(await remove.mutateAsync(undefined));
    } catch (error) {
      const shifts = error instanceof HostError ? error.details["shifts"] : undefined;
      if (
        error instanceof HostError &&
        error.details["constraint"] === "demo_shift_active" &&
        Array.isArray(shifts)
      ) {
        setFailure({
          kind: "alert",
          message: "office.demo.delete.active",
          values: { shifts: shifts.join(", ") },
        });
        return;
      }
      setFailure(alertFailure(error));
    }
  };

  return (
    <FormDialog
      title={t("office.demo.delete.title")}
      submitLabel={t("office.demo.delete.submit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>
        {t("office.demo.delete.body", {
          shifts: summary.shifts,
          boxes: summary.boxes,
          pallets: summary.pallets,
          codes: summary.codes,
        })}
      </p>
      <p>{t("office.demo.delete.keeps")}</p>
    </FormDialog>
  );
}
