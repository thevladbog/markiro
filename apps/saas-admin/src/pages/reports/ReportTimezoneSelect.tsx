import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Combobox } from "@markiro/ui";

// Keep UTC explicit: supportedValuesOf returns named IANA zones, not UTC itself.
const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function ReportTimezoneSelect({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      timezones.map((zone) => {
        const city = zone.split("/").at(-1) ?? zone;
        const readableCity = city.replaceAll("_", " ");
        return {
          value: zone,
          label:
            zone === "UTC"
              ? "UTC"
              : `${t(`reports.timezones.cities.${city}`, { defaultValue: readableCity })} — ${zone}`,
          keywords: [readableCity],
        };
      }),
    [t],
  );
  return (
    <Combobox
      label={t("reports.fields.timezone")}
      value={value}
      onValueChange={onValueChange}
      options={options}
      placeholder={t("reports.timezones.placeholder")}
      searchPlaceholder={t("reports.timezones.search")}
      emptyText={t("reports.timezones.empty")}
      loadingText={t("reports.timezones.loading")}
    />
  );
}
