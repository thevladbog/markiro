import { Input } from "@markiro/ui";
import type { DadataAddressSuggestion } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

import { SuggestionMenu } from "./SuggestionMenu.js";
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
    <div className="suggest-field">
      <Input
        label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        hint={t("legal.dadata.addressHint")}
        disabled={disabled}
      />
      <SuggestionMenu
        result={suggestions.data}
        pending={suggestions.isFetching}
        error={suggestions.error}
        getKey={(item) => item.fiasId ?? item.value}
        getLabel={(item) => item.value}
        onSelect={onSelect}
      />
    </div>
  );
}
