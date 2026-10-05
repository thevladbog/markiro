import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplate, LabelTemplateSummary, TemplateUpdate } from "../../host/protocol.js";
import { templateUpdate } from "../../host/requests.js";
import { useProductGroups } from "../catalog-queries.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { sameCategories, scopeCodes, scopeOf, type CategoryScope } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { templateFailure, type TemplateFailure } from "./template-text.js";

export interface TemplateCategoriesDialogProps {
  /** The row as it was when the dialog opened: its revision goes with the write. */
  template: LabelTemplateSummary;
  onClose: () => void;
  onSaved: (template: LabelTemplate) => void;
  /** The template changed on the host: close and load the templates again. */
  onReload: () => void;
}

/**
 * A template's categories: every category (`null`) or the chosen ones,
 * ascending, with the opened row's revision (`templateUpdate`). «Сохранить»
 * stays off until the categories differ from the row's in more than their
 * order, and «Только выбранные» needs at least one category. Narrowing a
 * template out of a category whose default it is, or narrowing the
 * organization's default at all, is refused with `template_is_default`, and
 * the dialog says whose default the template is.
 */
export function TemplateCategoriesDialog({
  template,
  onClose,
  onSaved,
  onReload,
}: TemplateCategoriesDialogProps) {
  const { t } = useTranslation();
  const groups = useProductGroups();
  const [scope, setScope] = useState<CategoryScope>(() => scopeOf(template.chzProductGroupCodes));
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const save = useOfficeMutation((api, token, body: TemplateUpdate) =>
    api.updateTemplate(token, template.id, body),
  );
  const codes = scopeCodes(scope);

  const submit = async () => {
    setFailure(null);
    if (codes !== null && codes.length === 0) {
      setScopeError("office.categoryScope.empty");
      return;
    }
    let saved: LabelTemplate;
    try {
      saved = await save.mutateAsync(templateUpdate(template, { chzProductGroupCodes: codes }));
    } catch (error) {
      setFailure(templateFailure(error));
      return;
    }
    onSaved(saved);
  };

  return (
    <FormDialog
      title={t("office.templates.categoriesTitle", { name: template.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={sameCategories(codes, template.chzProductGroupCodes)}
      onSubmit={submit}
      onClose={onClose}
      alert={<TemplateFailureAlert failure={failure} groups={groups.data} onReload={onReload} />}
    >
      <p>{t("office.templates.categoriesIntro")}</p>
      <CategoryScopeField
        value={scope}
        onChange={(next) => {
          setScope(next);
          setScopeError(null);
        }}
        {...(scopeError === null ? {} : { error: t(scopeError) })}
      />
    </FormDialog>
  );
}
