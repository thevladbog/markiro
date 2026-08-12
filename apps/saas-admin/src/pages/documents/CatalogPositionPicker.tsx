import { Button, Combobox, type ComboboxOption } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { CatalogVersionDto } from "../catalog/api.js";

export function CatalogPositionPicker({
  catalog,
  loading,
  separate,
  onSeparateChange,
  onSelected,
}: {
  catalog: readonly CatalogVersionDto[];
  loading: boolean;
  separate: boolean;
  onSeparateChange: (separate: boolean) => void;
  onSelected: (version: CatalogVersionDto) => void;
}) {
  const { t } = useTranslation();
  const selectableCatalog = catalog.filter((version) => version.unitPrice !== undefined);
  const options: ComboboxOption[] = selectableCatalog.map((version) => ({
    value: version.id,
    label: `${version.nameRu} · ${version.catalogItemCode} · v${version.version}`,
    description: version.nameEn,
    group: t(`documents.kinds.${version.kind}`),
    keywords: [version.nameRu, version.nameEn, version.catalogItemCode, `v${version.version}`],
  }));

  return (
    <div className="document-catalog-picker">
      <Combobox
        label={t("documents.catalogPosition")}
        options={options}
        onValueChange={(id) => {
          const version = selectableCatalog.find((candidate) => candidate.id === id);
          if (version) onSelected(version);
        }}
        placeholder={t("documents.catalogPlaceholder")}
        searchPlaceholder={t("documents.catalogSearch")}
        emptyText={t("documents.catalogEmpty")}
        loadingText={t("documents.catalogLoading")}
        loading={loading}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => onSeparateChange(!separate)}
        aria-pressed={separate}
      >
        {t("documents.addSeparate")}
      </Button>
    </div>
  );
}
