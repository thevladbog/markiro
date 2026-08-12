import { Combobox } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { CatalogVersionDto } from "../catalog/api.js";

export interface CatalogPositionPickerProps {
  catalog: readonly CatalogVersionDto[];
  loading: boolean;
  disabled?: boolean;
  onAdd: (version: CatalogVersionDto) => void;
}

export function CatalogPositionPicker({
  catalog,
  loading,
  disabled = false,
  onAdd,
}: CatalogPositionPickerProps) {
  const { t } = useTranslation();
  const available = catalog.filter((version) => version.status === "published");

  return (
    <Combobox
      label={t("documents.addPosition")}
      loading={loading}
      disabled={disabled}
      options={available.map((version) => ({
        value: version.id,
        label: version.nameRu,
        description: `${version.catalogItemCode} · v${version.version}`,
        group: t(`documents.catalogGroups.${version.kind}`),
        keywords: [version.nameRu, version.nameEn, version.catalogItemCode, `v${version.version}`],
      }))}
      placeholder={t("documents.catalogPlaceholder")}
      searchPlaceholder={t("documents.catalogSearch")}
      emptyText={t("documents.catalogEmpty")}
      onValueChange={(id) => {
        const version = available.find((candidate) => candidate.id === id);
        if (version) onAdd(version);
      }}
    />
  );
}
