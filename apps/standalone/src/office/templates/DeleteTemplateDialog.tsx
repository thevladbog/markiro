import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplate } from "../../host/protocol.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { deleteFailure } from "./editor-failure.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import type { TemplateFailure } from "./template-text.js";

export interface DeleteTemplateDialogProps {
  template: Pick<LabelTemplate, "id" | "name">;
  onClose: () => void;
  /** The host deleted the template (204). */
  onDeleted: () => void;
}

/**
 * Deletes a template after saying what it means (`DELETE /v1/office/templates/{id}`,
 * the `destructive` submit): the stations stop getting it, the products that
 * prefer it lose the preference, and there is no undo. A default cannot be
 * deleted (`template_is_default`: the dialog says whose default it is), nor
 * can a stock template; the host answers a delete repeated after a lost
 * answer with 204 again.
 */
export function DeleteTemplateDialog({ template, onClose, onDeleted }: DeleteTemplateDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const remove = useOfficeMutation((api, token, id: string) => api.deleteTemplate(token, id));

  const submit = async () => {
    setFailure(null);
    try {
      await remove.mutateAsync(template.id);
    } catch (error) {
      setFailure(deleteFailure(error));
      return;
    }
    onDeleted();
  };

  return (
    <FormDialog
      title={t("office.templateEditor.deleteDialog.title")}
      submitLabel={t("office.templateEditor.deleteDialog.submit")}
      submitVariant="destructive"
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} />}
    >
      <p>{t("office.templateEditor.deleteDialog.body", { name: template.name })}</p>
    </FormDialog>
  );
}
