import { planEntitlementsV3Schema } from "@markiro/platform-contracts";
import { CatalogP1Fields, UNKNOWN_P1_FEATURES, type P1DraftFeatures } from "./CatalogP1Fields.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Select, Textarea } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  getCatalogEditorContext,
  createCatalogVersion,
  type CatalogCreateInput,
  type CatalogVersionDto,
} from "./api.js";
import {
  AddonEffectsEditor,
  newAddonEffect,
  toAddonEffects,
  type EditableAddonEffect,
} from "./AddonEffectsEditor.js";
import { CatalogQuotaField } from "./CatalogQuotaField.js";
import { CatalogUnitField } from "./CatalogUnitField.js";
import { CatalogVatField } from "./CatalogVatField.js";
import { useCatalogDrawerClose } from "./CatalogDrawer.js";

export function CatalogCreatePanel({
  kind,
  onClose,
  onCreated,
  onDirtyChange,
}: {
  kind: CatalogVersionDto["kind"];
  onClose: () => void;
  onCreated: (item: CatalogVersionDto) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const requestClose = useCatalogDrawerClose(onClose);
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ["platform", "catalog", "editor-context"],
    queryFn: getCatalogEditorContext,
  });
  const [documentNameRu, setDocumentNameRu] = useState("");
  const [documentNameEn, setDocumentNameEn] = useState("");
  const [subject, setSubject] = useState<"service" | "development_work">("service");
  const [vatIncluded, setVatIncluded] = useState(false);
  const [taxTouched, setTaxTouched] = useState(false);
  useEffect(() => {
    if (context.data?.taxDefaults && !taxTouched) {
      setVatRateBps(context.data.taxDefaults.vatRateBps);
      setVatIncluded(context.data.taxDefaults.vatIncluded);
    }
  }, [context.data, taxTouched]);
  const [code, setCode] = useState("");
  const [nameRu, setNameRu] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [descriptionRu, setDescriptionRu] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [unit, setUnit] = useState(kind === "service" ? "project" : "month");
  const [price, setPrice] = useState("0.00");
  const [vatRateBps, setVatRateBps] = useState<number | null>(null);
  const [addonEffects, setAddonEffects] = useState<EditableAddonEffect[]>(() => [newAddonEffect()]);
  const [lines, setLines] = useState("");
  const [stations, setStations] = useState("");
  const [kiosks, setKiosks] = useState("");
  const [users, setUsers] = useState("");
  const [demoDurationDays, setDemoDurationDays] = useState("");
  const [labelEditorEnabled, setLabelEditorEnabled] = useState(false);
  const [publicApiEnabled, setPublicApiEnabled] = useState(false);
  const [palletsEnabled, setPalletsEnabled] = useState(false);
  const [p1Features, setP1Features] = useState<P1DraftFeatures>(UNKNOWN_P1_FEATURES);
  const [lifecyclePolicyId, setLifecyclePolicyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange?.(
      Boolean(
        (kind === "addon" &&
          JSON.stringify(addonEffects.map(({ key, value }) => ({ key, value }))) !==
            JSON.stringify([{ key: "stations", value: "1" }])) ||
        code ||
        nameRu ||
        nameEn ||
        descriptionRu ||
        descriptionEn ||
        price !== "0.00" ||
        unit !== (kind === "service" ? "project" : "month") ||
        taxTouched ||
        documentNameRu ||
        documentNameEn ||
        subject !== "service" ||
        lines ||
        stations ||
        kiosks ||
        users ||
        demoDurationDays ||
        labelEditorEnabled ||
        publicApiEnabled ||
        palletsEnabled ||
        lifecyclePolicyId ||
        Object.values(p1Features).some((value) => value !== null),
      ),
    );
  }, [
    code,
    nameRu,
    nameEn,
    descriptionRu,
    descriptionEn,
    price,
    unit,
    kind,
    vatRateBps,
    taxTouched,
    documentNameRu,
    documentNameEn,
    subject,
    addonEffects,
    lines,
    stations,
    kiosks,
    users,
    demoDurationDays,
    labelEditorEnabled,
    publicApiEnabled,
    palletsEnabled,
    p1Features,
    lifecyclePolicyId,
    onDirtyChange,
  ]);

  const create = useMutation({
    mutationFn: () => {
      const base = {
        lifecyclePolicyId,
        documentNameRu: documentNameRu.trim() || null,
        documentNameEn: documentNameEn.trim() || null,
        sellerPolicyRevision: context.data?.sellerPolicyRevision || null,
        nameRu: nameRu.trim(),
        nameEn: nameEn.trim(),
        descriptionRu: descriptionRu.trim() || null,
        descriptionEn: descriptionEn.trim() || null,
        unit: unit.trim(),
        unitPrice: price,
        vatRateBps,
        vatIncluded: vatRateBps !== null && vatIncluded,
      };
      const input: CatalogCreateInput =
        kind === "plan"
          ? {
              ...base,
              billingMode: "recurring",
              subject: "software_license",
              billingPeriod: unit === "year" ? "year" : "month",
              plan: planEntitlementsV3Schema.parse({
                chzIntegrationEnabled: p1Features.chzIntegration,
                inventoryEnabled: p1Features.inventory,
                commerceMlEnabled: p1Features.commerceMl,
                handheldEnabled: p1Features.handheld,
                maxLines: lines ? Number(lines) : null,
                maxStations: stations ? Number(stations) : null,
                maxKiosks: kiosks ? Number(kiosks) : null,
                maxCabinetUsers: users ? Number(users) : null,
                demoDurationDays: demoDurationDays ? Number(demoDurationDays) : null,
                labelEditorEnabled,
                publicApiEnabled,
                palletsEnabled,
              }),
            }
          : kind === "addon"
            ? {
                ...base,
                billingMode: "recurring",
                subject: "software_license",
                billingPeriod: unit === "year" ? "year" : "month",
                addon: { effects: toAddonEffects(addonEffects) },
              }
            : { ...base, subject, billingMode: "one_time", billingPeriod: null, service: {} };
      return createCatalogVersion(code.trim(), input);
    },
    onSuccess: (created) => {
      queryClient.setQueryData<{ items: CatalogVersionDto[] }>(
        ["platform", "catalog"],
        (current) => (current ? { items: [...current.items, created] } : { items: [created] }),
      );
      onCreated(created);
      onClose();
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiRequestError && cause.kind === "domain" && cause.status === 409
          ? t("catalog.createConflict")
          : t("catalog.createError"),
      ),
  });

  return (
    <section
      className="version-panel catalog-create-panel"
      role="region"
      aria-label={t("catalog.createTitle")}
    >
      <header className="version-panel__header">
        <div>
          <span className="panel-coordinate">NEW · {kind.toUpperCase()}</span>
          <h2>{t("catalog.createTitle")}</h2>
        </div>
        <Button variant="secondary" onClick={requestClose}>
          {t("catalog.close")}
        </Button>
      </header>
      <form
        className="catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (create.isPending) return;
          setError(null);
          if (
            kind === "plan" &&
            [lines, stations, kiosks, users].some(
              (value) => value !== "" && !/^(0|[1-9]\d*)$/.test(value),
            )
          ) {
            setError(t("catalog.validation.quota"));
            return;
          }
          if (!code.trim() || !nameRu.trim() || !nameEn.trim() || !unit.trim()) {
            setError(t("catalog.createRequired"));
            return;
          }
          if (kind === "plan" && Object.values(p1Features).some((value) => value === null)) {
            setError(t("entitlements.mappingRequired"));
            return;
          }
          try {
            if (kind === "addon") toAddonEffects(addonEffects);
            create.mutate();
          } catch (cause) {
            setError(
              cause instanceof Error && cause.message === "effectDuplicate"
                ? t("catalog.validation.effectDuplicate")
                : t("catalog.validation.effectRequired"),
            );
          }
        }}
      >
        <fieldset>
          <legend>{t("catalog.form.identity")}</legend>
          <div className="form-grid form-grid--two">
            <Input
              label={t("catalog.form.code")}
              className="catalog-form__full-width"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="plan-pro"
              required
            />
            <Input
              label={t("catalog.form.nameRu")}
              value={nameRu}
              onChange={(event) => setNameRu(event.target.value)}
              required
            />
            <Input
              label={t("catalog.form.nameEn")}
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              required
            />
            <Textarea
              label={t("catalog.form.descriptionRu")}
              value={descriptionRu}
              onChange={(event) => setDescriptionRu(event.target.value)}
              rows={3}
            />
            <Textarea
              label={t("catalog.form.descriptionEn")}
              value={descriptionEn}
              onChange={(event) => setDescriptionEn(event.target.value)}
              rows={3}
            />
            <Input
              label={t("catalog.form.documentNameRu")}
              value={documentNameRu}
              onChange={(event) => setDocumentNameRu(event.target.value)}
            />
            <Input
              label={t("catalog.form.documentNameEn")}
              value={documentNameEn}
              onChange={(event) => setDocumentNameEn(event.target.value)}
            />
            {kind === "service" ? (
              <Select
                label={t("catalog.form.subject")}
                value={subject}
                onValueChange={setSubject}
                options={[
                  { value: "service", label: t("commercial.subject.service") },
                  { value: "development_work", label: t("commercial.subject.development_work") },
                ]}
              />
            ) : (
              <Input
                label={t("catalog.form.subject")}
                value={t("commercial.subject.software_license")}
                readOnly
              />
            )}
            <CatalogUnitField kind={kind} value={unit} onChange={setUnit} />
            <Input
              label={t("catalog.form.unitPrice")}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              required
            />
            <CatalogVatField
              value={vatRateBps}
              policy={context.data?.taxPolicy}
              onChange={(value) => {
                setTaxTouched(true);
                setVatRateBps(value);
              }}
            />
            {vatRateBps !== null ? (
              <Checkbox
                className="catalog-form__full-width"
                label={t("catalog.vat.includedHint")}
                checked={vatIncluded}
                onCheckedChange={(value) => {
                  setTaxTouched(true);
                  setVatIncluded(value);
                }}
              />
            ) : null}
          </div>
        </fieldset>
        {kind === "plan" ? (
          <fieldset>
            <legend>{t("catalog.form.planLimits")}</legend>
            <div className="form-grid form-grid--four">
              <CatalogQuotaField
                label={t("catalog.form.maxLines")}
                value={lines}
                onChange={setLines}
              />
              <CatalogQuotaField
                label={t("catalog.form.maxStations")}
                value={stations}
                onChange={setStations}
              />
              <CatalogQuotaField
                label={t("catalog.form.maxKiosks")}
                value={kiosks}
                onChange={setKiosks}
              />
              <CatalogQuotaField
                label={t("catalog.form.maxUsers")}
                value={users}
                onChange={setUsers}
              />
              <Input
                label={t("catalog.form.demoDays")}
                value={demoDurationDays}
                onChange={(event) => setDemoDurationDays(event.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="feature-grid">
              <Checkbox
                label={t("catalog.form.labelEditor")}
                checked={labelEditorEnabled}
                onCheckedChange={setLabelEditorEnabled}
              />
              <Checkbox
                label={t("catalog.form.publicApi")}
                checked={publicApiEnabled}
                onCheckedChange={setPublicApiEnabled}
              />
              <Checkbox
                label={t("catalog.form.pallets")}
                checked={palletsEnabled}
                onCheckedChange={setPalletsEnabled}
              />
            </div>
          </fieldset>
        ) : null}
        {kind === "addon" ? (
          <AddonEffectsEditor effects={addonEffects} onChange={setAddonEffects} />
        ) : null}
        <fieldset>
          <legend>{t("catalog.effectsLabel")}</legend>
          <p>
            {nameRu || nameEn || "—"} · {kind === "service" ? unit : t(`catalog.units.${unit}`)} ·{" "}
            {price} ₽
          </p>
          <p>{documentNameRu || t("catalog.form.documentNameRu")}</p>
          {kind === "plan" ? (
            <ul>
              {[
                ["maxLines", lines],
                ["maxStations", stations],
                ["maxKiosks", kiosks],
                ["maxUsers", users],
              ].map(([key, value]) => (
                <li key={key}>
                  {t(`catalog.form.${key}`)}:{" "}
                  {value === ""
                    ? t("catalog.quota.unlimited")
                    : value === "0"
                      ? t("catalog.quota.none")
                      : value === "__limited__"
                        ? t("catalog.quota.required")
                        : value}
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
        {context.isError ? <Alert tone="error">{t("catalog.reviewError")}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <CatalogP1Fields
          values={kind === "plan" ? p1Features : null}
          policyId={lifecyclePolicyId}
          policies={context.data?.lifecyclePolicies}
          onFeatureChange={(key, value) =>
            setP1Features((current) => ({ ...current, [key]: value }))
          }
          onPolicyChange={setLifecyclePolicyId}
          disabled={create.isPending}
        />
        <div className="form-actions">
          <Button
            type="submit"
            loading={create.isPending}
            disabled={create.isPending || context.isPending || !context.data?.canWrite}
          >
            {t("catalog.create")}
          </Button>
          <Button type="button" variant="secondary" onClick={requestClose}>
            {t("catalog.cancel")}
          </Button>
        </div>
      </form>
    </section>
  );
}
