import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Combobox,
  DatePicker,
  RadioGroup,
  Select,
  Spinner,
} from "@markiro/ui";

import { isBoxLabelTemplateEligible } from "@markiro/domain";

import { useProducts } from "../catalog/api.js";
import { useLabelTemplates } from "../labels/api.js";
import { useLines, useShiftPlanningConfig } from "../shifts/api.js";
import type { CreateInventoryInput, InventoryMode } from "./schemas.js";

export function InventoryParametersForm({
  initialValue,
  submitLabel,
  cancelLabel,
  pending,
  requestError,
  onCancel,
  onSubmit,
}: {
  initialValue?: CreateInventoryInput;
  submitLabel: string;
  cancelLabel: string;
  pending: boolean;
  requestError: string | null;
  onCancel: () => void;
  onSubmit: (value: CreateInventoryInput) => void;
}) {
  const { t, i18n } = useTranslation();
  // Inventory is the one selection surface where archived ("do not use")
  // products stay selectable: counting leftover stock of a product pulled
  // from production is the flag's core scenario.
  const products = useProducts({ archived: "all" });
  const lines = useLines();
  const templates = useLabelTemplates();
  const [productId, setProductId] = useState(initialValue?.productId ?? "");
  const [lineId, setLineId] = useState(initialValue?.lineId ?? "");
  const [mode, setMode] = useState<InventoryMode>(initialValue?.mode ?? "check");
  const [templateId, setTemplateId] = useState(initialValue?.boxLabelTemplateId ?? "");
  // A manual choice survives product changes only while it stays eligible;
  // the default is re-applied whenever the operator has not chosen by hand.
  const [templateTouched, setTemplateTouched] = useState(Boolean(initialValue?.boxLabelTemplateId));
  const [from, setFrom] = useState(initialValue?.productionDateFrom ?? "");
  const [to, setTo] = useState(initialValue?.productionDateTo ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  // The box-template default is resolved per product (category default,
  // then organisation default), so it is only asked once a product is chosen.
  const planning = useShiftPlanningConfig(productId ? productId : null);

  const selectedProduct = (products.data ?? []).find((product) => product.id === productId) ?? null;
  const productGroupCode = selectedProduct?.chzProductGroupCode ?? null;
  const eligibleTemplates = !productId
    ? []
    : selectedProduct
      ? (templates.data ?? []).filter((template) =>
          isBoxLabelTemplateEligible(template, productGroupCode),
        )
      : (templates.data ?? []);

  useEffect(() => {
    if (!lineId && lines.data?.length === 1) setLineId(lines.data[0]!.id);
  }, [lineId, lines.data]);
  useEffect(() => {
    if (templateTouched) return;
    setTemplateId(planning.data?.defaultBoxLabelTemplateId ?? "");
  }, [planning.data, templateTouched]);

  function handleProductChange(next: string): void {
    setProductId(next);
    const nextProduct = (products.data ?? []).find((product) => product.id === next) ?? null;
    const stillEligible =
      templateId !== "" &&
      (templates.data ?? []).some(
        (template) =>
          template.id === templateId &&
          isBoxLabelTemplateEligible(template, nextProduct?.chzProductGroupCode ?? null),
      );
    if (!stillEligible) {
      setTemplateId("");
      setTemplateTouched(false);
    }
  }

  const productOptions = useMemo(
    () =>
      (products.data ?? []).map((product) => ({
        value: product.id,
        label: product.name,
        description: product.archived
          ? `GTIN ${product.gtin14} · ${t("pages.inventory.create.archivedProductHint")}`
          : `GTIN ${product.gtin14}`,
        disabled: product.status !== "active",
      })),
    [products.data, t],
  );
  const loading = products.isPending || lines.isPending || templates.isPending;
  const loadError = products.isError || lines.isError || templates.isError;

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
    onSubmit({
      productId,
      lineId,
      mode,
      productionDateFrom: from,
      productionDateTo: to,
      boxLabelTemplateId: mode === "repack" ? templateId : null,
    });
  };

  if (loading) return <Spinner label={t("common.loading")} />;
  if (loadError) return <Alert tone="error">{t("pages.inventory.create.dependenciesError")}</Alert>;

  return (
    <Card title={t("pages.inventory.create.cardTitle")} titleAs="h2">
      <div className="mk-inventory-form">
        <Combobox
          label={t("pages.inventory.create.product")}
          options={productOptions}
          value={productId}
          onValueChange={handleProductChange}
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
            searchable
            searchLabel={t("pages.inventory.create.templateSearch")}
            searchPlaceholder={t("pages.inventory.create.templateSearch")}
            onValueChange={(value) => {
              setTemplateId(value);
              setTemplateTouched(true);
            }}
            options={eligibleTemplates.map((template) => ({
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
        {validationError || requestError ? (
          <Alert tone="error">{validationError ?? requestError}</Alert>
        ) : null}
        <div className="mk-inventory-actions">
          <Button variant="secondary" type="button" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="button" loading={pending} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}
