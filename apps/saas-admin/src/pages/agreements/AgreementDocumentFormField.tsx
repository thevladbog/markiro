import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";
import type { AgreementDocumentForm } from "@markiro/platform-contracts";

const FORMS: readonly AgreementDocumentForm[] = ["ru", "ru_en"];

export interface AgreementDocumentFormFieldProps {
  readonly value: AgreementDocumentForm;
  readonly onChange: (value: AgreementDocumentForm) => void;
  readonly disabled?: boolean;
}

/**
 * The printed form is a property of the agreement, not a download option, so
 * it is edited beside the other fields and locked by the same `editable` flag.
 */
export function AgreementDocumentFormField({
  value,
  onChange,
  disabled,
}: AgreementDocumentFormFieldProps) {
  const { t } = useTranslation();
  return (
    <Select
      native
      id="agreement-document-form"
      label={t("agreements.documentForm.label")}
      value={value}
      disabled={disabled ?? false}
      options={FORMS.map((form) => ({
        value: form,
        label: t(`agreements.documentForm.${form}`),
      }))}
      onValueChange={onChange}
    />
  );
}
