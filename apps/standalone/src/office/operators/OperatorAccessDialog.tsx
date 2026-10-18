import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfficeOperator, OperatorUpdate } from "../../host/protocol.js";
import { operatorUpdate } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

export interface OperatorAccessDialogProps {
  operator: OfficeOperator;
  onClose: () => void;
  onSaved: (operator: OfficeOperator) => void;
  /** The operator changed on the host: close and load the operators again. */
  onReload: () => void;
}

/**
 * Turns an active operator off, or one that is off back on, after saying
 * what it means on the stations. Turning off takes the operator out of use
 * (the `destructive` variant); turning on is a light confirmation, since it
 * gives the PIN and the badges their access back.
 */
export function OperatorAccessDialog({
  operator,
  onClose,
  onSaved,
  onReload,
}: OperatorAccessDialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const change = useOfficeMutation((api, token, body: OperatorUpdate) =>
    api.updateOperator(token, operator.id, body),
  );
  const turningOff = operator.active;

  const submit = async () => {
    setFailure(null);
    let saved: OfficeOperator;
    try {
      saved = await change.mutateAsync(operatorUpdate(operator, { active: !turningOff }));
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t(turningOff ? "office.operators.deactivateTitle" : "office.operators.activateTitle")}
      submitLabel={t(
        turningOff ? "office.operators.deactivateSubmit" : "office.operators.activateSubmit",
      )}
      submitVariant={turningOff ? "destructive" : "primary"}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>
        {t(turningOff ? "office.operators.deactivateBody" : "office.operators.activateBody", {
          name: operator.name,
        })}
      </p>
    </FormDialog>
  );
}
