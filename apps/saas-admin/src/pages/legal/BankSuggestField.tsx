import type { DadataBankSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionField } from "./SuggestionField.js";
import { useDadataSuggestions } from "./dadata.js";

const EXACT_BIC = /^\d{9}$/;

export function BankSuggestField({
  value,
  onValueChange,
  onSelect,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSelect: (suggestion: DadataBankSuggestion) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const suggestions = useDadataSuggestions("banks", value, EXACT_BIC);
  return (
    <SuggestionField
      label={t("legal.fields.bankSearch")}
      hint={t("legal.dadata.bankHint")}
      value={value}
      result={suggestions.data}
      pending={suggestions.isFetching}
      error={suggestions.error}
      disabled={disabled}
      getKey={(item) => item.bic}
      getLabel={(item) => `${item.bankName} · ${item.bic}`}
      getSelectedValue={(item) => item.value}
      onValueChange={onValueChange}
      onSelect={onSelect}
    />
  );
}
