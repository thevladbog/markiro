import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input, Select } from "@markiro/ui";

/** What the list holds for «ввести вручную»: never a port's name. */
const MANUAL = "__manual__";

export interface ComPortFieldProps {
  /** The field's name (the select's label, or the text field's when no list is there). */
  label: string;
  value: string;
  onChange: (port: string) => void;
  /** The ports the system lists; `null` until it has answered. */
  ports: readonly string[] | null;
  /** The text field's focus handlers: its keys are not a scan. */
  manualEntry: { onFocus: () => void; onBlur: () => void };
}

/**
 * A COM port: chosen from the ports of this computer in the product's own searchable list, or
 * typed when the list is empty, did not come, or the port is not on it (a port the system does not
 * list yet, a virtual one). The list is asked for by the screen; this only shows it.
 */
export function ComPortField({ label, value, onChange, ports, manualEntry }: ComPortFieldProps) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const listed = ports ?? [];
  const typedOnly = listed.length === 0;
  const chosen = manual ? MANUAL : listed.includes(value) ? value : "";
  const field = (text: string) => (
    <Input
      {...manualEntry}
      size="floor"
      label={text}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  if (typedOnly) return field(label);
  return (
    <>
      <Select
        custom
        searchable
        size="floor"
        label={label}
        value={chosen}
        searchLabel={t("floor.setup.comPort.searchLabel")}
        searchPlaceholder={t("floor.setup.comPort.searchPlaceholder")}
        searchEmptyLabel={t("floor.setup.comPort.searchEmpty")}
        options={[
          { value: "", label: t("floor.setup.comPort.choose") },
          ...listed.map((port) => ({ value: port, label: port })),
          { value: MANUAL, label: t("floor.setup.comPort.manual") },
        ]}
        onValueChange={(next) => {
          if (next === MANUAL) {
            setManual(true);
            return;
          }
          setManual(false);
          onChange(next);
        }}
      />
      {manual && field(t("floor.setup.comPort.manualLabel"))}
    </>
  );
}
