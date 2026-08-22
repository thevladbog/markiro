import type { DadataAddressSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionField } from "./SuggestionField.js";
import { useDadataSuggestions } from "./dadata.js";

export function AddressSuggestField({
  label,
  value,
  onValueChange,
  onSelect,
  disabled = false,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onSelect: (suggestion: DadataAddressSuggestion) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const suggestions = useDadataSuggestions("addresses", value);
  return (
    <SuggestionField
      label={label}
      hint={t("legal.dadata.addressHint")}
      value={value}
      result={suggestions.data}
      pending={suggestions.isFetching}
      error={suggestions.error}
      disabled={disabled}
      getKey={(item) => item.fiasId ?? item.value}
      getLabel={(item) => item.value}
      getSelectedValue={(item) => item.value}
      onValueChange={onValueChange}
      onSelect={onSelect}
    />
  );
}
