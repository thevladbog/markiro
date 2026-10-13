import type { SqlExecutor } from "../../lib/mirror.js";
import type { CredentialGeneration } from "../../lib/credential-recovery.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type {
  PalletTemplateChoice,
  PalletTemplateCatalogV2,
  LabelTemplateSpec,
  PrinterDpi,
  WarehouseTemplate,
  WarehouseTemplateCatalog,
} from "@markiro/domain";
import { TemplateChoiceList } from "../labels/TemplateChoiceList.js";
import { LabelPreview } from "./LabelPreview.js";
import { PalletChoicePreview } from "./PalletChoicePreview.js";
export function TemplatePicker({
  catalog,
  logoOwner,
  unitTemplate,
  boxTemplate,
  palletTemplate = null,
  palletCatalog,
  palletPaper,
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
  logoOwner?: { exec: SqlExecutor; generation: CredentialGeneration };
  defaultBoxId?: string | null;
  loading?: boolean;
  error?: string | null;
  catalog: WarehouseTemplateCatalog;
  unitTemplate: WarehouseTemplate | null;
  boxTemplate: WarehouseTemplate | null;
  palletTemplate?: PalletTemplateChoice | null;
  palletCatalog?: PalletTemplateCatalogV2 | null;
  palletPaper?: "a4" | "thermal";
  onApply: (unit: WarehouseTemplate, box: WarehouseTemplate, pallet?: PalletTemplateChoice) => void;
  onCancel: () => void;
  unitDpi: PrinterDpi | null;
  boxDpi: PrinterDpi | null;
  unitLanguage: LabelTemplateSpec["language"] | null;
  boxLanguage: LabelTemplateSpec["language"] | null;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"product_duplicate" | "box" | "pallet">("product_duplicate");
  const [unit, setUnit] = useState(unitTemplate);
  const [box, setBox] = useState(boxTemplate);
  const [pallet, setPallet] = useState(palletTemplate);
  const pallets = (palletCatalog?.templates ?? []).filter(
    (c) => c.id !== null && c.kind === (palletPaper ?? "thermal"),
  );
  const selectedPallet =
    pallets.find((c) => c.id === pallet?.id && c.snapshotDigest === pallet.snapshotDigest) ?? null;
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
            loading ||
            Boolean(error) ||
            !valid(unit, "product_duplicate") ||
            !valid(box, "box") ||
            (palletCatalog != null && !selectedPallet)
          }
          onClick={() => {
            if (unit && box) {
              if (palletCatalog != null && selectedPallet) onApply(unit, box, selectedPallet);
              else if (palletCatalog == null) onApply(unit, box);
            }
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
        {palletCatalog != null ? (
          <Button
            size="floor"
            variant={tab === "pallet" ? "primary" : "secondary"}
            onClick={() => {
              setTab("pallet");
              setSearch("");
            }}
          >
            {t("warehouse.palletTab")}
          </Button>
        ) : null}
      </div>
      <div className="warehouse-template-grid">
        <TemplateChoiceList
          disabled={loading || Boolean(error)}
          radio
          choices={
            tab === "pallet"
              ? pallets.map((c) => ({
                  id: c.id ?? "",
                  name: c.name,
                  widthMm:
                    c.kind === "thermal"
                      ? c.snapshot.widthMm
                      : c.snapshot.spec.page.orientation === "portrait"
                        ? 210
                        : 297,
                  heightMm:
                    c.kind === "thermal"
                      ? c.snapshot.heightMm
                      : c.snapshot.spec.page.orientation === "portrait"
                        ? 297
                        : 210,
                }))
              : available.map((template) => ({
                  id: template.id,
                  name: template.name,
                  widthMm: template.spec.widthMm,
                  heightMm: template.spec.heightMm,
                }))
          }
          selectedId={tab === "pallet" ? (selectedPallet?.id ?? null) : (selected?.id ?? null)}
          defaultId={tab === "box" ? defaultBoxId : null}
          ariaLabel={t(
            tab === "pallet"
              ? "warehouse.palletTab"
              : tab === "box"
                ? "warehouse.boxTab"
                : "warehouse.unitTab",
          )}
          search={search}
          onSearch={setSearch}
          onSelect={(id) => {
            if (tab === "pallet") {
              setPallet(pallets.find((c) => c.id === id) ?? null);
              return;
            }
            const template = available.find((t) => t.id === id);
            if (template) {
              if (tab === "box") setBox(template);
              else setUnit(template);
            }
          }}
        />
        <div>
          {tab === "pallet" ? (
            selectedPallet ? (
              <PalletChoicePreview choice={selectedPallet} {...(logoOwner ? { logoOwner } : {})} />
            ) : (
              <p>{t("warehouse.pickPreview")}</p>
            )
          ) : selected ? (
            <LabelPreview
              {...(logoOwner ? { logoOwner } : {})}
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
          {palletCatalog != null
            ? ` · ${t("warehouse.palletSelected", { name: selectedPallet?.name ?? "—" })}`
            : null}
        </p>
      </div>
    </FullScreenDialog>
  );
}
