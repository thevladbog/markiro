import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import {
  templatePurposeSchema,
  type CategoryTemplateDefault,
  type LabelTemplateSummary,
  type ProductGroup,
  type TemplatePurpose,
} from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { FormDialog } from "../FormDialog.js";
import { templateOptions } from "../template-options.js";
import { searchableSelect } from "../select-search.js";
import { freePurposes } from "./defaults-form.js";

/** Group names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

export interface CategoryDefaultDialogProps {
  groups: readonly ProductGroup[];
  templates: readonly LabelTemplateSummary[];
  /** The category defaults the page holds: a slot in use is not offered again. */
  taken: readonly CategoryTemplateDefault[];
  onClose: () => void;
  onAdd: (entry: CategoryTemplateDefault) => void;
}

/**
 * Adds a category default to the page's document, which «Сохранить» sends
 * later: a category that still has a purpose without a default, a purpose
 * that category has no default of yet, and a template that fits that
 * category and purpose (`templateOptions`). A new category starts the purpose
 * and the template afresh; a new purpose, the template.
 */
export function CategoryDefaultDialog({
  groups,
  templates,
  taken,
  onClose,
  onAdd,
}: CategoryDefaultDialogProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurpose | "">("");
  const [templateId, setTemplateId] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [purposeError, setPurposeError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const category = code === "" ? null : Number(code);
  const categories = groups
    .filter((group) => freePurposes(taken, group.code).length > 0)
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const purposes = category === null ? [] : freePurposes(taken, category);
  const choices =
    category === null || purpose === ""
      ? [{ value: "", label: t("office.templateChoice.none") }]
      : templateOptions(templates, purpose, category, [], t);
  // Only «Не выбран» is left: the hint says why, and stays the field's message.
  const nothingFits = purpose !== "" && choices.length === 1;

  // Nothing goes to the host here: the row joins the page's document.
  const submit = (): Promise<void> => {
    setCodeError(category === null ? "office.templateDefaults.errors.chooseCategory" : null);
    setPurposeError(purpose === "" ? "office.templateDefaults.errors.choosePurpose" : null);
    setTemplateError(
      templateId === ""
        ? nothingFits
          ? "office.templateDefaults.noTemplateFits"
          : "office.templateDefaults.errors.chooseTemplate"
        : null,
    );
    if (category !== null && purpose !== "" && templateId !== "") {
      onAdd({ chzProductGroupCode: category, purpose, templateId });
    }
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateDefaults.addTitle")}
      submitLabel={t("office.templateDefaults.addSubmit")}
      onSubmit={submit}
      onClose={onClose}
    >
      <Select
        {...searchableSelect(t)}
        label={t("office.templateDefaults.fields.category")}
        options={[
          { value: "", label: t("office.templateDefaults.noCategory") },
          ...categories.map((group) => ({ value: String(group.code), label: group.name })),
        ]}
        value={code}
        onValueChange={(next) => {
          setCode(next);
          setPurpose("");
          setTemplateId("");
          setCodeError(null);
          setPurposeError(null);
          setTemplateError(null);
        }}
        {...errorProp(codeError === null ? undefined : t(codeError))}
      />
      <Select
        label={t("office.templateDefaults.fields.purpose")}
        options={[
          { value: "", label: t("office.templateDefaults.noPurpose") },
          ...purposes.map((each) => ({
            value: each,
            label: t(`office.templates.purposes.${each}`),
          })),
        ]}
        value={purpose}
        onValueChange={(next) => {
          const parsed = templatePurposeSchema.safeParse(next);
          setPurpose(parsed.success ? parsed.data : "");
          setTemplateId("");
          setPurposeError(null);
          setTemplateError(null);
        }}
        disabled={category === null}
        {...errorProp(purposeError === null ? undefined : t(purposeError))}
      />
      <Select
        {...searchableSelect(t)}
        label={t("office.templateDefaults.fields.template")}
        options={choices}
        value={templateId}
        onValueChange={(next) => {
          setTemplateId(next);
          setTemplateError(null);
        }}
        disabled={purpose === ""}
        {...(nothingFits ? { hint: t("office.templateDefaults.noTemplateFits") } : {})}
        {...errorProp(templateError === null ? undefined : t(templateError))}
      />
    </FormDialog>
  );
}
