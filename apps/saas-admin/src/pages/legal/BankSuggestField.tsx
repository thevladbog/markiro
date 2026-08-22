import { Input } from "@markiro/ui";
import type { DadataBankSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionMenu } from "./SuggestionMenu.js";
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
    <div className="suggest-field">
      <Input
        label={t("legal.fields.bankSearch")}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        hint={t("legal.dadata.bankHint")}
        disabled={disabled}
      />
      <SuggestionMenu
        result={suggestions.data}
        pending={suggestions.isFetching}
        error={suggestions.error}
        getKey={(item) => item.bic}
        getLabel={(item) => `${item.bankName} · ${item.bic}`}
        onSelect={onSelect}
      />
    </div>
  );
}
