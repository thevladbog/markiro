import type { DadataOrganizationSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionField } from "./SuggestionField.js";
import { useDadataSuggestions } from "./dadata.js";

const EXACT_INN = /^(?:\d{10}|\d{12})$/;

export function OrganizationSuggestField({
  value,
  onValueChange,
  onSelect,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSelect: (suggestion: DadataOrganizationSuggestion) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const suggestions = useDadataSuggestions("organizations", value, EXACT_INN);

  return (
    <SuggestionField
      label={t("legal.fields.organizationSearch")}
      hint={t("legal.dadata.organizationHint")}
      value={value}
      result={suggestions.data}
      pending={suggestions.isFetching}
      error={suggestions.error}
      disabled={disabled}
      getKey={(item) => `${item.inn}:${item.kpp ?? ""}`}
      getLabel={(item) => item.value}
      getSelectedValue={(item) => item.value}
      onValueChange={onValueChange}
      onSelect={onSelect}
    />
  );
}
