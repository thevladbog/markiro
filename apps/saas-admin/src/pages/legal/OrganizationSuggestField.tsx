import { Input } from "@markiro/ui";
import type { DadataOrganizationSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionMenu } from "./SuggestionMenu.js";
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
    <div className="suggest-field">
      <Input
        label={t("legal.fields.organizationSearch")}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        hint={t("legal.dadata.organizationHint")}
        disabled={disabled}
      />
      <SuggestionMenu
        result={suggestions.data}
        pending={suggestions.isFetching}
        error={suggestions.error}
        getKey={(item) => `${item.inn}:${item.kpp ?? ""}`}
        getLabel={(item) => item.value}
        onSelect={onSelect}
      />
    </div>
  );
}
