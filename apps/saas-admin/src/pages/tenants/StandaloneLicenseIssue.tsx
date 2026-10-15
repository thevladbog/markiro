import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Combobox, Input, Modal, type ComboboxOption } from "@markiro/ui";
import type {
  StandaloneIssuanceSource,
  StandaloneOfflineTerms,
  StandaloneSite,
} from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { listAssignableCatalogVersions } from "./api.js";
import { confirmStandaloneLicense, previewStandaloneLicense } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import {
  standaloneErrorKey,
  standaloneSitesKey,
  standaloneWarningText,
} from "./standalone-format.js";
import { StandaloneLicenseComparison } from "./StandaloneLicenseComparison.js";

const MAX_OFFLINE_TERM_DAYS = 365;

/**
 * Spec §6.2 steps 2–3: preview «before → after», then confirm and download the
 * `.mklic`. A tenant without a cabinet issues from the «Офлайн» terms — a
 * published plan and a term of 1-365 days (owner decision 2026-10-13).
 */
export function StandaloneLicenseIssue({
  tenantId,
  site,
  source,
  onClose,
}: {
  tenantId: string;
  site: StandaloneSite;
  source: StandaloneIssuanceSource;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const offlinePath = source === "offline";
  const [planVersionId, setPlanVersionId] = useState("");
  const [term, setTerm] = useState(String(MAX_OFFLINE_TERM_DAYS));
  const termDays = Number(term.trim());
  const termValid =
    term.trim() !== "" &&
    Number.isInteger(termDays) &&
    termDays >= 1 &&
    termDays <= MAX_OFFLINE_TERM_DAYS;
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "assignable"],
    queryFn: listAssignableCatalogVersions,
    enabled: offlinePath,
  });
  const english = i18n.resolvedLanguage?.startsWith("en") ?? false;
  const planOptions: ComboboxOption[] = (catalog.data?.items ?? [])
    .filter((item) => item.kind === "plan" && item.status === "published")
    .map((item) => ({
      value: item.id,
      label: `${english ? item.nameEn : item.nameRu} · ${item.catalogItemCode ?? "—"} · ${t(
        "tenants.detail.standalone.issue.offline.version",
        { version: item.version },
      )}`,
      keywords: [item.nameRu, item.nameEn, item.catalogItemCode ?? ""],
    }));
  const offline: StandaloneOfflineTerms | null =
    offlinePath && planVersionId !== "" && termValid ? { planVersionId, termDays } : null;
  const termsReady = !offlinePath || offline !== null;
  const translate = (key: string, options: Record<string, unknown> = {}) => t(key, options);
  const queryClient = useQueryClient();
  const [grace, setGrace] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [issuedSequence, setIssuedSequence] = useState<number | null>(null);
  const graceDays = grace.trim() === "" ? null : Number(grace.trim());
  const graceValid =
    graceDays === null || (Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 60);
  const preview = useMutation({
    mutationFn: () => previewStandaloneLicense(tenantId, site.id, { graceDays, offline }),
    onSuccess: () => {
      setRequestId(crypto.randomUUID());
      setIssuedSequence(null);
    },
  });
  const confirm = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error("preview required");
      return confirmStandaloneLicense(tenantId, site.id, {
        requestId,
        graceDays,
        offline,
        expected: preview.data.expected,
      });
    },
    onSuccess: async (file) => {
      saveLicenseFile(file.fileName, file.compact);
      setIssuedSequence(file.issuance.sequence);
      preview.reset();
      await queryClient.invalidateQueries({ queryKey: standaloneSitesKey(tenantId) });
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === "standalone_license_preview_stale")
        preview.reset();
    },
  });
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.issue.title", { name: site.name })}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.issue.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("tenants.detail.standalone.issue.cancel")}
          </Button>
          <Button
            variant="secondary"
            disabled={!graceValid || !termsReady || preview.isPending}
            onClick={() => {
              confirm.reset();
              preview.mutate();
            }}
          >
            {t("tenants.detail.standalone.issue.preview")}
          </Button>
          <Button disabled={!preview.data || confirm.isPending} onClick={() => confirm.mutate()}>
            {t("tenants.detail.standalone.issue.confirm")}
          </Button>
        </>
      }
    >
      {offlinePath ? (
        <fieldset className="standalone-offline-terms">
          <legend>{t("tenants.detail.standalone.issue.offline.title")}</legend>
          <p>{t("tenants.detail.standalone.issue.offline.hint")}</p>
          <Combobox
            label={t("tenants.detail.standalone.issue.offline.plan")}
            options={planOptions}
            value={planVersionId}
            loading={catalog.isPending}
            onValueChange={(value) => {
              setPlanVersionId(value);
              preview.reset();
            }}
            placeholder={t("tenants.detail.standalone.issue.offline.planPlaceholder")}
            searchPlaceholder={t("tenants.detail.standalone.issue.offline.planPlaceholder")}
            emptyText={t("tenants.detail.standalone.issue.offline.planEmpty")}
            loadingText={t("tenants.detail.standalone.issue.offline.planLoading")}
          />
          {catalog.isError ? (
            <Alert tone="error" role="alert">
              {t("tenants.detail.standalone.issue.offline.catalogError")}
            </Alert>
          ) : null}
          <Input
            label={t("tenants.detail.standalone.issue.offline.termDays")}
            hint={t("tenants.detail.standalone.issue.offline.termHint")}
            inputMode="numeric"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              preview.reset();
            }}
            {...(termValid
              ? {}
              : { error: t("tenants.detail.standalone.issue.offline.termInvalid") })}
          />
        </fieldset>
      ) : null}
      <Input
        label={t("tenants.detail.standalone.issue.graceDays")}
        hint={t("tenants.detail.standalone.issue.graceHint")}
        inputMode="numeric"
        value={grace}
        onChange={(event) => {
          setGrace(event.target.value);
          preview.reset();
        }}
        {...(graceValid ? {} : { error: t("tenants.detail.standalone.issue.graceInvalid") })}
      />
      {issuedSequence !== null ? (
        <Alert tone="ok" role="status">
          {t("tenants.detail.standalone.issue.issued", { sequence: issuedSequence })}
        </Alert>
      ) : null}
      {preview.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(preview.error))}
        </Alert>
      ) : null}
      {confirm.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(confirm.error))}
        </Alert>
      ) : null}
      {preview.data ? (
        <>
          {preview.data.warnings.length ? (
            <Alert tone="warn">
              <ul>
                {preview.data.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    {standaloneWarningText(translate, warning)}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {preview.data.next.validUntilReason === "one_year_cap" ? (
            <Alert tone="info">{t("tenants.detail.standalone.issue.yearCapNote")}</Alert>
          ) : null}
          <StandaloneLicenseComparison preview={preview.data} />
        </>
      ) : null}
    </Modal>
  );
}
