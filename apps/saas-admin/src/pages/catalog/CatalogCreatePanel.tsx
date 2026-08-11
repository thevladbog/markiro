import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { createCatalogVersion, type CatalogCreateInput, type CatalogVersionDto } from "./api.js";

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
  const [unit, setUnit] = useState(
    kind === "plan" ? "month" : kind === "service" ? "project" : "unit",
  );
  const [price, setPrice] = useState("0.00");
  const [lines, setLines] = useState("");
  const [stations, setStations] = useState("");
  const [kiosks, setKiosks] = useState("");
  const [users, setUsers] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const base = {
        nameRu: nameRu.trim(),
        nameEn: nameEn.trim(),
        unit: unit.trim(),
        billingMode: kind === "service" ? ("one_time" as const) : ("recurring" as const),
        billingPeriod: kind === "service" ? null : ("month" as const),
        unitPrice: price,
        vatRateBps: 2000,
        vatIncluded: true,
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
                labelEditorEnabled: false,
                publicApiEnabled: false,
                palletsEnabled: false,
                demoDurationDays: null,
              },
            }
          : kind === "addon"
            ? { ...base, addon: { effects: [{ key: "stations", quotaIncrement: 1 }] } }
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
          create.mutate();
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
            <Input
              label={t("catalog.form.unit")}
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              required
            />
            <Input
              label={t("catalog.form.unitPrice")}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              required
            />
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
            </div>
          </fieldset>
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
