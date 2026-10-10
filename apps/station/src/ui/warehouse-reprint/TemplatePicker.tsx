import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type {
  LabelTemplateSpec,
  PrinterDpi,
  WarehouseTemplate,
  WarehouseTemplateCatalog,
} from "@markiro/domain";
import { TemplateChoiceList } from "../labels/TemplateChoiceList.js";
import { LabelPreview } from "./LabelPreview.js";
export function TemplatePicker({
  catalog,
  unitTemplate,
  boxTemplate,
  onApply,
  onCancel,
  unitDpi,
  boxDpi,
  unitLanguage,
  boxLanguage,
  defaultBoxId = null,
  loading = false,
  error = null,
}: {
  defaultBoxId?: string | null;
  loading?: boolean;
  error?: string | null;
  catalog: WarehouseTemplateCatalog;
  unitTemplate: WarehouseTemplate | null;
  boxTemplate: WarehouseTemplate | null;
  onApply: (unit: WarehouseTemplate, box: WarehouseTemplate) => void;
  onCancel: () => void;
  unitDpi: PrinterDpi | null;
  boxDpi: PrinterDpi | null;
  unitLanguage: LabelTemplateSpec["language"] | null;
  boxLanguage: LabelTemplateSpec["language"] | null;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"product_duplicate" | "box">("product_duplicate");
  const [unit, setUnit] = useState(unitTemplate);
  const [box, setBox] = useState(boxTemplate);
  const draft = tab === "box" ? box : unit;
  const selected =
    catalog.templates.find(
      (t) => t.enabled && t.purpose === tab && t.id === draft?.id && t.digest === draft.digest,
    ) ?? null;
  const available = catalog.templates.filter(
    (template) => template.enabled && template.purpose === tab,
  );
  const valid = (template: WarehouseTemplate | null, purpose: WarehouseTemplate["purpose"]) =>
    template !== null &&
    catalog.templates.some(
      (t) =>
        t.id === template.id && t.digest === template.digest && t.enabled && t.purpose === purpose,
    );
  return (
    <FullScreenDialog
      open
      title={t("warehouse.templateTitle")}
      onClose={onCancel}
      backLabel={t("warehouse.cancel")}
      className="warehouse-template-dialog"
      footer={
        <Button
          size="floor"
          disabled={
            loading || Boolean(error) || !valid(unit, "product_duplicate") || !valid(box, "box")
          }
          onClick={() => {
            if (unit && box) onApply(unit, box);
          }}
        >
          {t("warehouse.applyTemplates")}
        </Button>
      }
    >
      <div className="warehouse-template-tabs">
        <Button
          size="floor"
          variant={tab === "product_duplicate" ? "primary" : "secondary"}
          onClick={() => {
            setTab("product_duplicate");
            setSearch("");
          }}
        >
          {t("warehouse.unitTab")}
        </Button>
        <Button
          size="floor"
          variant={tab === "box" ? "primary" : "secondary"}
          onClick={() => {
            setTab("box");
            setSearch("");
          }}
        >
          {t("warehouse.boxTab")}
        </Button>
      </div>
      <div className="warehouse-template-grid">
        <TemplateChoiceList
          disabled={loading || Boolean(error)}
          radio
          choices={available.map((template) => ({
            id: template.id,
            name: template.name,
            widthMm: template.spec.widthMm,
            heightMm: template.spec.heightMm,
          }))}
          selectedId={selected?.id ?? null}
          defaultId={tab === "box" ? defaultBoxId : null}
          ariaLabel={t(tab === "box" ? "warehouse.boxTab" : "warehouse.unitTab")}
          search={search}
          onSearch={setSearch}
          onSelect={(id) => {
            const template = available.find((t) => t.id === id);
            if (template) {
              if (tab === "box") setBox(template);
              else setUnit(template);
            }
          }}
        />
        <div>
          {selected ? (
            <LabelPreview
              template={selected}
              language={(tab === "box" ? boxLanguage : unitLanguage) ?? selected.spec.language}
              dpi={(tab === "box" ? boxDpi : unitDpi) ?? selected.spec.dpi}
            />
          ) : (
            <p>{t("warehouse.pickPreview")}</p>
          )}
        </div>
      </div>
      <div className="warehouse-template-summary">
        {error ? (
          <Alert tone="error">
            {t(`warehouse.errors.${error}`, {
              defaultValue: t("warehouse.errors.WAREHOUSE_OPERATION_FAILED"),
            })}
          </Alert>
        ) : null}
        {loading ? <p role="status">{t("warehouse.working")}</p> : null}
        <p>
          {t("warehouse.unitSelected", { name: unit?.name ?? "—" })} ·{" "}
          {t("warehouse.boxSelected", { name: box?.name ?? "—" })}
        </p>
      </div>
    </FullScreenDialog>
  );
}
