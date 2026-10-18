import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeLine } from "../../host/protocol.js";
import { lineUpdate } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface ArchiveLineDialogProps {
  line: OfficeLine;
  onClose: () => void;
  onArchived: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * Asks before a line goes to the archive. Archiving leaves the devices on the
 * line alone: a station already on it stays there until an administrator
 * moves it in «Устройства»; no station can choose it any more.
 */
export function ArchiveLineDialog({ line, onClose, onArchived, onReload }: ArchiveLineDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const archive = useOfficeMutation((api, token, _variables: void) =>
    api.updateLine(token, line.id, lineUpdate(line, { name: line.name, archived: true })),
  );

  const submit = async () => {
    setFailure(null);
    let archived: OfficeLine;
    try {
      archived = await archive.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onArchived(archived);
  };

  return (
    <FormDialog
      title={t("office.lines.archiveTitle")}
      submitLabel={t("office.lines.archiveSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.lines.archiveBody", { name: line.name })}</p>
    </FormDialog>
  );
}
