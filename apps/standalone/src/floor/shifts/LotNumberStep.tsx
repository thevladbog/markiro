import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";

import { optionalLotNumber } from "../../lib/lot-number.js";
import { TextKeyboardInput } from "../kit/TextKeyboardInput.js";
import type { ScanSource } from "../scan-source.js";

interface Props {
  source: ScanSource;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  disabled: boolean;
}

export function LotNumberStep({ source, value, onChange, invalid, disabled }: Props) {
  const { t } = useTranslation();
  useLayoutEffect(() => () => source.setManualTextEntryActive(false), [source]);

  return (
    <div className="new-shift__lot">
      <TextKeyboardInput
        label={t("floor.newShift.lotNumber.field")}
        hint={t("floor.newShift.lotNumber.hint")}
        value={value}
        disabled={disabled}
        {...(invalid ? { error: t("rules.lotNumber") } : {})}
        onFocus={() => source.setManualTextEntryActive(true)}
        onBlur={() => source.setManualTextEntryActive(false)}
        onChange={onChange}
        normalizePaste={optionalLotNumber}
      />
    </div>
  );
}
