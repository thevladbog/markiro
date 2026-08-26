import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import {
  AdminPage,
  Alert,
  Button,
  Card,
  Combobox,
  DatePicker,
  PageHeader,
  RadioGroup,
  Select,
  Spinner,
} from "@markiro/ui";

import { useProducts } from "../catalog/api.js";
import { useLabelTemplates } from "../labels/api.js";
import { useLines, useShiftPlanningConfig } from "../shifts/api.js";
import { useCreateInventory } from "./api.js";
import { PreparationSteps } from "./PreparationSteps.js";
import type { InventoryMode } from "./schemas.js";
import "./inventory.css";

export function InventoryCreatePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const products = useProducts();
  const lines = useLines();
  const templates = useLabelTemplates();
  const planning = useShiftPlanningConfig();
  const create = useCreateInventory();
  const [productId, setProductId] = useState("");
  const [lineId, setLineId] = useState("");
  const [mode, setMode] = useState<InventoryMode>("check");
  const [templateId, setTemplateId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!lineId && lines.data?.length === 1) setLineId(lines.data[0]!.id);
  }, [lineId, lines.data]);
  useEffect(() => {
    if (!templateId && planning.data?.defaultBoxLabelTemplateId) {
      setTemplateId(planning.data.defaultBoxLabelTemplateId);
    }
  }, [planning.data, templateId]);

  const productOptions = useMemo(
    () =>
      (products.data ?? []).map((product) => ({
        value: product.id,
        label: product.name,
        description: `GTIN ${product.gtin14}`,
        disabled: product.status !== "active",
      })),
    [products.data],
  );
  const loading =
    products.isPending || lines.isPending || templates.isPending || planning.isPending;
  const loadError = products.isError || lines.isError || templates.isError || planning.isError;

  const submit = () => {
    if (!productId || !lineId || !from || !to || (mode === "repack" && !templateId)) {
      setValidationError(t("pages.inventory.create.requiredError"));
      return;
    }
    if (from > to) {
      setValidationError(t("pages.inventory.create.dateError"));
      return;
    }
    setValidationError(null);
    create.mutate(
      {
        productId,
        lineId,
        mode,
        productionDateFrom: from,
        productionDateTo: to,
        boxLabelTemplateId: mode === "repack" ? templateId : null,
      },
      { onSuccess: (inventory) => void navigate(`/inventory/${inventory.id}`) },
    );
  };

  return (
    <AdminPage className="mk-inventory-page">
      <PageHeader title={t("pages.inventory.create.title")} />
      <PreparationSteps current={1} />
      {loading ? (
        <Spinner label={t("common.loading")} />
      ) : loadError ? (
        <Alert tone="error">{t("pages.inventory.create.dependenciesError")}</Alert>
      ) : (
        <div className="mk-inventory-workspace">
          <Card title={t("pages.inventory.create.cardTitle")} titleAs="h2">
            <div className="mk-inventory-form">
              <Combobox
                label={t("pages.inventory.create.product")}
                options={productOptions}
                value={productId}
                onValueChange={setProductId}
                placeholder={t("pages.inventory.create.productPlaceholder")}
                searchPlaceholder={t("pages.inventory.create.productSearch")}
                emptyText={t("pages.inventory.create.productEmpty")}
                loadingText={t("common.loading")}
              />
              <RadioGroup
                label={t("pages.inventory.create.mode")}
                value={mode}
                onValueChange={(value) => setMode(value as InventoryMode)}
                options={[
                  { value: "check", label: t("pages.inventory.mode.check") },
                  { value: "repack", label: t("pages.inventory.mode.repack") },
                ]}
              />
              <Select
                label={t("pages.inventory.create.line")}
                value={lineId}
                onValueChange={setLineId}
                options={(lines.data ?? []).map((line) => ({ value: line.id, label: line.name }))}
                placeholder={t("pages.inventory.create.linePlaceholder")}
              />
              {mode === "repack" ? (
                <Select
                  label={t("pages.inventory.create.template")}
                  value={templateId}
                  onValueChange={setTemplateId}
                  options={(templates.data ?? []).map((template) => ({
                    value: template.id,
                    label: template.name,
                  }))}
                  placeholder={t("pages.inventory.create.templatePlaceholder")}
                />
              ) : null}
              <div className="mk-inventory-form__dates">
                <DatePicker
                  label={t("pages.inventory.create.dateFrom")}
                  value={from}
                  onValueChange={(value) => setFrom(value ?? "")}
                  locale={i18n.language}
                />
                <DatePicker
                  label={t("pages.inventory.create.dateTo")}
                  value={to}
                  onValueChange={(value) => setTo(value ?? "")}
                  locale={i18n.language}
                />
              </div>
              <p className="mk-inventory-note">{t("pages.inventory.create.inclusive")}</p>
              {validationError || create.isError ? (
                <Alert tone="error">{validationError ?? create.error?.message}</Alert>
              ) : null}
              <div className="mk-inventory-actions">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void navigate("/inventory")}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="button" loading={create.isPending} onClick={submit}>
                  {t("pages.inventory.create.next")}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </AdminPage>
  );
}
