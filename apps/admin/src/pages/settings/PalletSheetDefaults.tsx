import type { UseQueryResult } from "@tanstack/react-query";
import type { LabelTemplateSummaryDto } from "../labels/api.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isPalletLabelTemplateEligible } from "@markiro/domain";
import { Alert, Button, Card, Select } from "@markiro/ui";
import { useChzProductGroups } from "../catalog/api.js";
import { useLabelTemplates } from "../labels/api.js";
import { useUpdateOrgProfile, type OrgProfileDto } from "./api.js";
export function PalletSheetDefaults({ profile }: { profile: OrgProfileDto }) {
  const templates = useLabelTemplates({ includeSheets: true });
  return <PalletSheetDefaultsForm profile={profile} templates={templates} />;
}
export function PalletSheetDefaultsForm({
  profile,
  templates,
}: {
  profile: OrgProfileDto;
  templates: UseQueryResult<LabelTemplateSummaryDto[]>;
}) {
  const { t } = useTranslation();
  const groups = useChzProductGroups(),
    update = useUpdateOrgProfile();
  const [defaultId, setDefaultId] = useState(profile.defaultPalletSheetTemplateId ?? "");
  const [categories, setCategories] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (profile.categoryPalletSheetTemplateDefaults ?? []).map((row) => [
        String(row.chzProductGroupCode),
        row.templateId,
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sheets = (templates.data ?? []).filter((item) => item.format === "pallet_sheet_v2");
  const available = (category: number | null) =>
    sheets.filter((item) => isPalletLabelTemplateEligible(item, category));
  const options = (category: number | null, value: string) => [
    {
      value: "",
      label: t(
        category === null
          ? "pages.labels.sheet.defaults.unset"
          : "pages.labels.sheet.defaults.inherit",
      ),
    },
    ...available(category).map((item) => ({ value: item.id, label: item.name })),
    ...(value && !available(category).some((item) => item.id === value)
      ? [{ value, label: t("pages.labels.sheet.defaults.unavailable"), disabled: true }]
      : []),
  ];
  const rows = Array.from(
    new Set([...(groups.data ?? []).map((g) => g.code), ...Object.keys(categories).map(Number)]),
  ).sort((a, b) => a - b);
  const stale =
    (defaultId !== "" && !available(null).some((item) => item.id === defaultId)) ||
    Object.entries(categories).some(
      ([code, value]) => value !== "" && !available(Number(code)).some((item) => item.id === value),
    );
  async function save() {
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        defaultPalletSheetTemplateId: defaultId || null,
        categoryPalletSheetTemplateDefaults: Object.entries(categories)
          .filter(([, id]) => id !== "")
          .map(([code, templateId]) => ({ chzProductGroupCode: Number(code), templateId })),
      });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return (
    <Card title={t("pages.labels.sheet.defaults.title")} titleAs="h2">
      <p>{t("pages.labels.sheet.defaults.hint")}</p>
      <Select
        label={t("pages.labels.sheet.defaults.organization")}
        options={options(null, defaultId)}
        value={defaultId}
        onValueChange={(value) => {
          setDefaultId(value);
          setSaved(false);
        }}
      />
      {rows.map((code) => (
        <Select
          key={code}
          label={`${t("pages.labels.sheet.defaults.category")} ${groups.data?.find((g) => g.code === code)?.name ?? code}`}
          options={options(code, categories[String(code)] ?? "")}
          value={categories[String(code)] ?? ""}
          onValueChange={(value) => {
            setCategories({ ...categories, [String(code)]: value });
            setSaved(false);
          }}
        />
      ))}
      {templates.isError || groups.isError ? (
        <Alert tone="error">{t("pages.labels.sheet.scopeLoadError")}</Alert>
      ) : null}
      {stale && !templates.isPending ? (
        <Alert tone="warn">{t("pages.labels.sheet.defaults.unavailable")}</Alert>
      ) : null}
      {saved ? <Alert tone="info">{t("pages.labels.sheet.defaults.saved")}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button
        type="button"
        loading={update.isPending}
        disabled={stale || templates.isPending || templates.isError}
        onClick={() => void save()}
      >
        {t("pages.labels.sheet.defaults.save")}
      </Button>
    </Card>
  );
}
