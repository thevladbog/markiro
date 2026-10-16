import { Button, Combobox, type ComboboxOption } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { CatalogVersionDto } from "../catalog/api.js";

export function CatalogPositionPicker({
  catalog,
  loading,
  separate,
  offlineTenant = false,
  onSeparateChange,
  onSelected,
}: {
  catalog: readonly CatalogVersionDto[];
  loading: boolean;
  separate: boolean;
  /** A tenant without a cabinet: services and offline-flagged items only (spec 2026-10-16). */
  offlineTenant?: boolean;
  onSeparateChange: (separate: boolean) => void;
  onSelected: (version: CatalogVersionDto) => void;
}) {
  const { t } = useTranslation();
  const selectableCatalog = catalog.filter(
    (version) =>
      version.unitPrice !== undefined &&
      (!offlineTenant || version.kind === "service" || version.offlineAvailable),
  );
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
