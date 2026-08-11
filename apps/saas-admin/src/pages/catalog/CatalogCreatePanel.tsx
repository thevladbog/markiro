import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { createCatalogVersion, type CatalogCreateInput, type CatalogVersionDto } from "./api.js";
import {
  AddonEffectsEditor,
  newAddonEffect,
  toAddonEffects,
  type EditableAddonEffect,
} from "./AddonEffectsEditor.js";
import { CatalogUnitField } from "./CatalogUnitField.js";
import { CatalogVatField } from "./CatalogVatField.js";

export function CatalogCreatePanel({
  kind,
  onClose,
  onCreated,
}: {
  kind: CatalogVersionDto["kind"];
  onClose: () => void;
  onCreated: (item: CatalogVersionDto) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [nameRu, setNameRu] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [descriptionRu, setDescriptionRu] = useState("");
  const [descriptionEn, setDescriptionEn] = useState("");
  const [unit, setUnit] = useState(
    kind === "service" ? "project" : "month",
  );
  const [price, setPrice] = useState("0.00");
  const [vatRateBps, setVatRateBps] = useState<number | null>(2200);
  const [addonEffects, setAddonEffects] = useState<EditableAddonEffect[]>(() => [newAddonEffect()]);
  const [lines, setLines] = useState("");
  const [stations, setStations] = useState("");
  const [kiosks, setKiosks] = useState("");
  const [users, setUsers] = useState("");
  const [demoDurationDays, setDemoDurationDays] = useState("");
  const [labelEditorEnabled, setLabelEditorEnabled] = useState(false);
  const [publicApiEnabled, setPublicApiEnabled] = useState(false);
  const [palletsEnabled, setPalletsEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const base = {
        nameRu: nameRu.trim(),
        nameEn: nameEn.trim(),
        descriptionRu: descriptionRu.trim() || null,
        descriptionEn: descriptionEn.trim() || null,
        unit: unit.trim(),
        billingMode: kind === "service" ? ("one_time" as const) : ("recurring" as const),
        billingPeriod: kind === "service" ? null : ("month" as const),
        unitPrice: price,
        vatRateBps,
        vatIncluded: vatRateBps !== null,
      };
      const input: CatalogCreateInput =
        kind === "plan"
          ? {
              ...base,
              plan: {
                maxLines: lines ? Number(lines) : null,
                maxStations: stations ? Number(stations) : null,
                maxKiosks: kiosks ? Number(kiosks) : null,
                maxCabinetUsers: users ? Number(users) : null,
                demoDurationDays: demoDurationDays ? Number(demoDurationDays) : null,
                labelEditorEnabled,
                publicApiEnabled,
                palletsEnabled,
              },
            }
          : kind === "addon"
            ? { ...base, addon: { effects: toAddonEffects(addonEffects) } }
            : { ...base, service: {} };
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
        cause instanceof ApiRequestError && cause.status === 409
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
        <Button variant="secondary" onClick={onClose}>
          {t("catalog.close")}
        </Button>
      </header>
      <form
        className="catalog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (!code.trim() || !nameRu.trim() || !nameEn.trim() || !unit.trim()) {
            setError(t("catalog.createRequired"));
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
            <label className="native-field">
              <span>{t("catalog.form.descriptionRu")}</span>
              <textarea
                aria-label={t("catalog.form.descriptionRu")}
                value={descriptionRu}
                onChange={(event) => setDescriptionRu(event.target.value)}
                rows={3}
              />
            </label>
            <label className="native-field">
              <span>{t("catalog.form.descriptionEn")}</span>
              <textarea
                aria-label={t("catalog.form.descriptionEn")}
                value={descriptionEn}
                onChange={(event) => setDescriptionEn(event.target.value)}
                rows={3}
              />
            </label>
            <CatalogUnitField kind={kind} value={unit} onChange={setUnit} />
            <Input
              label={t("catalog.form.unitPrice")}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              required
            />
            <CatalogVatField value={vatRateBps} onChange={setVatRateBps} />
          </div>
        </fieldset>
        {kind === "plan" ? (
          <fieldset>
            <legend>{t("catalog.form.planLimits")}</legend>
            <div className="form-grid form-grid--four">
              <Input
                label={t("catalog.form.maxLines")}
                value={lines}
                onChange={(event) => setLines(event.target.value)}
                inputMode="numeric"
              />
              <Input
                label={t("catalog.form.maxStations")}
                value={stations}
                onChange={(event) => setStations(event.target.value)}
                inputMode="numeric"
              />
              <Input
                label={t("catalog.form.maxKiosks")}
                value={kiosks}
                onChange={(event) => setKiosks(event.target.value)}
                inputMode="numeric"
              />
              <Input
                label={t("catalog.form.maxUsers")}
                value={users}
                onChange={(event) => setUsers(event.target.value)}
                inputMode="numeric"
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
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="form-actions">
          <Button type="submit" loading={create.isPending}>
            {t("catalog.create")}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("catalog.cancel")}
          </Button>
        </div>
      </form>
    </section>
  );
}
