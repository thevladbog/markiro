import { useTranslation } from "react-i18next";
import { Alert, Checkbox } from "@markiro/ui";
import { useChzProductGroups } from "../../../catalog/api.js";
export function SheetScopePicker({
  value,
  onChange,
}: {
  value: number[] | null;
  onChange: (value: number[] | null) => void;
}) {
  const { t } = useTranslation();
  const groups = useChzProductGroups({ enabled: value !== null });
  return (
    <section aria-label={t("pages.labels.sheet.scopeTitle")}>
      <Checkbox
        label={t("pages.labels.sheet.scopeAll")}
        checked={value === null}
        onCheckedChange={(all) => onChange(all ? null : [])}
      />
      {value !== null ? (
        <>
          {groups.isError ? (
            <Alert tone="error">{t("pages.labels.sheet.scopeLoadError")}</Alert>
          ) : null}
          {value.length === 0 ? (
            <Alert tone="warn">{t("pages.labels.sheet.scopeEmpty")}</Alert>
          ) : null}
          {(groups.data ?? []).map((group) => (
            <Checkbox
              key={group.code}
              label={group.name}
              checked={value.includes(group.code)}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...value, group.code] : value.filter((code) => code !== group.code),
                )
              }
            />
          ))}
          {value
            .filter((code) => !groups.data?.some((group) => group.code === code))
            .map((code) => (
              <Checkbox
                key={code}
                label={String(code)}
                checked
                onCheckedChange={() => onChange(value.filter((c) => c !== code))}
              />
            ))}
        </>
      ) : null}
    </section>
  );
}
