import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import {
  templatePurposeSchema,
  type CategoryPalletSheetDefault,
  type CategoryTemplateDefault,
  type LabelTemplateSummary,
  type PalletSheets,
  type ProductGroup,
} from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { FormDialog } from "../FormDialog.js";
import { sheetChoices } from "../sheet-choice.js";
import { searchableSelect } from "../select-search.js";
import { templateOptions } from "../template-options.js";
import { freeKinds, type DefaultKind } from "./defaults-form.js";

/** Group names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

/** What the dialog adds: a label template's category default, or a category's A4 sheet. */
export type AddedDefault =
  | { kind: "label"; entry: CategoryTemplateDefault }
  | { kind: "sheet"; entry: CategoryPalletSheetDefault };

export interface CategoryDefaultDialogProps {
  groups: readonly ProductGroup[];
  templates: readonly LabelTemplateSummary[];
  /** The A4 sheets; `undefined` while they are not loaded (the sheet is then not offered). */
  sheets?: PalletSheets | undefined;
  /** The category defaults the page holds: a slot in use is not offered again. */
  taken: readonly CategoryTemplateDefault[];
  /** The categories' default sheets the page holds. */
  takenSheets?: readonly CategoryPalletSheetDefault[];
  onClose: () => void;
  onAdd: (added: AddedDefault) => void;
}

function kindOf(value: string): DefaultKind | "" {
  if (value === "pallet_sheet") return value;
  const parsed = templatePurposeSchema.safeParse(value);
  return parsed.success ? parsed.data : "";
}

/**
 * Adds a category default to the page's document, which «Сохранить» sends
 * later: a category that still has a kind without a default, a kind that
 * category has no default of yet (a label's purpose, or the pallet's A4
 * sheet beside the pallet label), and a template that fits that category and
 * purpose (`templateOptions`) or an enabled sheet (`sheetChoices`). A new
 * category starts the kind and the choice afresh; a new kind, the choice.
 */
export function CategoryDefaultDialog({
  groups,
  templates,
  sheets,
  taken,
  takenSheets = [],
  onClose,
  onAdd,
}: CategoryDefaultDialogProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [purpose, setPurpose] = useState<DefaultKind | "">("");
  const [templateId, setTemplateId] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [purposeError, setPurposeError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const category = code === "" ? null : Number(code);
  // The sheet is offered once the sheets are loaded and one of them can be chosen.
  const sheetsOffered = sheetChoices(sheets, [], "", t).length > 1;
  const kinds = (group: number) =>
    freeKinds(taken, takenSheets, group).filter((kind) => kind !== "pallet_sheet" || sheetsOffered);
  const categories = groups
    .filter((group) => kinds(group.code).length > 0)
    .sort((a, b) => NAMES.compare(a.name, b.name));
  const purposes = category === null ? [] : kinds(category);
  const choices =
    category === null || purpose === ""
      ? [{ value: "", label: t("office.templateChoice.none") }]
      : purpose === "pallet_sheet"
        ? sheetChoices(sheets, [], t("office.sheetChoice.none"), t)
        : templateOptions(templates, purpose, category, [], t);
  // Only «Не выбран» is left: the hint says why, and stays the field's message.
  const nothingFits = purpose !== "" && choices.length === 1;
  const noFitText =
    purpose === "pallet_sheet"
      ? "office.templateDefaults.noSheetFits"
      : "office.templateDefaults.noTemplateFits";

  // Nothing goes to the host here: the row joins the page's document.
  const submit = (): Promise<void> => {
    setCodeError(category === null ? "office.templateDefaults.errors.chooseCategory" : null);
    setPurposeError(purpose === "" ? "office.templateDefaults.errors.choosePurpose" : null);
    setTemplateError(
      templateId === ""
        ? nothingFits
          ? noFitText
          : purpose === "pallet_sheet"
            ? "office.templateDefaults.errors.chooseSheet"
            : "office.templateDefaults.errors.chooseTemplate"
        : null,
    );
    if (category !== null && purpose !== "" && templateId !== "") {
      onAdd(
        purpose === "pallet_sheet"
          ? { kind: "sheet", entry: { chzProductGroupCode: category, sheetId: templateId } }
          : { kind: "label", entry: { chzProductGroupCode: category, purpose, templateId } },
      );
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
            label:
              each === "pallet_sheet"
                ? t("office.templateDefaults.sheetKind")
                : t(`office.templates.purposes.${each}`),
          })),
        ]}
        value={purpose}
        onValueChange={(next) => {
          setPurpose(kindOf(next));
          setTemplateId("");
          setPurposeError(null);
          setTemplateError(null);
        }}
        disabled={category === null}
        {...errorProp(purposeError === null ? undefined : t(purposeError))}
      />
      <Select
        {...searchableSelect(t)}
        label={t(
          purpose === "pallet_sheet"
            ? "office.templateDefaults.fields.sheet"
            : "office.templateDefaults.fields.template",
        )}
        options={choices}
        value={templateId}
        onValueChange={(next) => {
          setTemplateId(next);
          setTemplateError(null);
        }}
        disabled={purpose === ""}
        {...(nothingFits ? { hint: t(noFitText) } : {})}
        {...errorProp(templateError === null ? undefined : t(templateError))}
      />
    </FormDialog>
  );
}
