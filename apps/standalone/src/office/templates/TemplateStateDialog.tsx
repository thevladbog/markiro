import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HostError } from "../../host/client.js";
import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { templateFailure, type TemplateFailure } from "./template-text.js";

export interface TemplateStateDialogProps {
  /** The row as it was when the dialog opened: its revision goes with the write. */
  template: LabelTemplateSummary;
  onClose: () => void;
  onSaved: (template: LabelTemplate) => void;
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
  /** The host has no such template any more: the list is read again under the dialog. */
  onMissing?: () => void;
}

/**
 * Switches an enabled template off, or a disabled one on, after saying what
 * it means. Switching off takes the template out of use (the `destructive`
 * variant); switching on is a light confirmation. Only the flag goes, with the
 * opened row's revision (`templateUpdate`). A template that is a default
 * cannot be switched off: the host refuses with `template_is_default`, and the
 * dialog says whose default it is and where to choose another.
 */
export function TemplateStateDialog({
  template,
  onClose,
  onSaved,
  onReload,
  onMissing,
}: TemplateStateDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const change = useOfficeMutation((api, token, body: TemplateUpdate) =>
    api.updateTemplate(token, template.id, body),
  );
  const turningOff = template.enabled;

  const submit = async () => {
    setFailure(null);
    let saved: LabelTemplate;
    try {
      saved = await change.mutateAsync(templateUpdate(template, { enabled: !turningOff }));
    } catch (error) {
      setFailure(templateFailure(error));
      if (error instanceof HostError && error.code === "not_found") onMissing?.();
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t(turningOff ? "office.templates.disableTitle" : "office.templates.enableTitle")}
      submitLabel={t(
        turningOff ? "office.templates.disableSubmit" : "office.templates.enableSubmit",
      )}
      submitVariant={turningOff ? "destructive" : "primary"}
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} onReload={onReload} />}
    >
      <p>
        {t(turningOff ? "office.templates.disableBody" : "office.templates.enableBody", {
          name: template.name,
        })}
      </p>
    </FormDialog>
  );
}
