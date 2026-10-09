import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type {
  LabelTemplateSpec,
  PrinterDpi,
  WarehouseTemplate,
  WarehouseTemplateCatalog,
} from "@markiro/domain";
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
}: {
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
  const [tab, setTab] = useState<"product_duplicate" | "box">("product_duplicate");
  const [unit, setUnit] = useState(unitTemplate);
  const [box, setBox] = useState(boxTemplate);
  const selected = tab === "box" ? box : unit;
  const available = catalog.templates.filter(
    (template) => template.enabled && template.purpose === tab,
  );
  const valid = (template: WarehouseTemplate | null) =>
    template !== null &&
    catalog.templates.some(
      (t) => t.id === template.id && t.digest === template.digest && t.enabled,
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
          disabled={!valid(unit) || !valid(box)}
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
          onClick={() => setTab("product_duplicate")}
        >
          {t("warehouse.unitTab")}
        </Button>
        <Button
          size="floor"
          variant={tab === "box" ? "primary" : "secondary"}
          onClick={() => setTab("box")}
        >
          {t("warehouse.boxTab")}
        </Button>
      </div>
      <div className="warehouse-template-grid">
        <div
          className="warehouse-template-list"
          role="radiogroup"
          aria-label={t(tab === "box" ? "warehouse.boxTab" : "warehouse.unitTab")}
        >
          {available.length === 0 ? (
            <p>{t("warehouse.noTemplates")}</p>
          ) : (
            available.map((template) => (
              <label className="warehouse-template-option" key={template.id}>
                <input
                  type="radio"
                  name="warehouse-template"
                  checked={selected?.id === template.id && selected.digest === template.digest}
                  onChange={() => (tab === "box" ? setBox(template) : setUnit(template))}
                />
                <span>
                  <strong>{template.name}</strong>
                  <small>
                    {template.spec.widthMm} × {template.spec.heightMm} {t("warehouse.mm")}
                  </small>
                </span>
              </label>
            ))
          )}
        </div>
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
      <p>
        {t("warehouse.unitSelected", { name: unit?.name ?? "—" })} ·{" "}
        {t("warehouse.boxSelected", { name: box?.name ?? "—" })}
      </p>
    </FullScreenDialog>
  );
}
