import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { badgeLabel } from "./operator-records.js";

export interface RevokeBadgeDialogProps {
  operator: OfficeOperator;
  badge: BadgeInfo;
  onClose: () => void;
  onRevoked: () => void;
}

/**
 * Asks before a badge is revoked: it stops opening the stations once they
 * sync, and it never comes back (a new card is a new badge). The host
 * answers 204, and revoking it again changes nothing.
 */
export function RevokeBadgeDialog({ operator, badge, onClose, onRevoked }: RevokeBadgeDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const revoke = useOfficeMutation((api, token, _variables: void) =>
    api.revokeBadge(token, operator.id, badge.id),
  );
  const label = badgeLabel(badge, t);

  const submit = async () => {
    setFailure(null);
    try {
      await revoke.mutateAsync();
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onRevoked();
  };

  return (
    <FormDialog
      title={t("office.operators.badges.revokeTitle")}
      submitLabel={t("office.operators.badges.revokeSubmit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <p>{t("office.operators.badges.revokeBody", { label, name: operator.name })}</p>
    </FormDialog>
  );
}
