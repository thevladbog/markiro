import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, Button, Input, Modal } from "@markiro/ui";
import type { StandaloneIssuanceSource, StandaloneSite } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { confirmStandaloneLicense, previewStandaloneLicense } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import {
  standaloneErrorKey,
  standaloneSitesKey,
  standaloneWarningText,
} from "./standalone-format.js";
import { StandaloneAssignmentsSummary } from "./StandaloneAssignmentsSummary.js";
import { StandaloneLicenseComparison } from "./StandaloneLicenseComparison.js";

/**
 * Spec §6.2 steps 2–3: preview «before → after», then confirm and download the
 * `.mklic`. The rights of a tenant without a cabinet are its direct plan and
 * add-on assignments (spec 2026-10-16); the manual offline terms are gone.
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
  const { t } = useTranslation();
  const assignmentsPath = source === "offline_assignments";
  const translate = (key: string, options: Record<string, unknown> = {}) => t(key, options);
  const changeRightsLink = (
    <Link to={`/tenants/${tenantId}#tenant-subscription`}>
      {t("tenants.detail.standalone.assignments.change")}
    </Link>
  );
  const queryClient = useQueryClient();
  const [grace, setGrace] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [issuedSequence, setIssuedSequence] = useState<number | null>(null);
  const graceDays = grace.trim() === "" ? null : Number(grace.trim());
  const graceValid =
    graceDays === null || (Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 60);
  const preview = useMutation({
    mutationFn: () => previewStandaloneLicense(tenantId, site.id, { graceDays, offline: null }),
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
        offline: null,
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
      className="standalone-license-dialog"
      width={720}
      title={t("tenants.detail.standalone.issue.title", { name: site.name })}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.issue.cancel")}
      footer={
        <div className="standalone-license-dialog__actions">
          <Button variant="secondary" onClick={onClose}>
            {t("tenants.detail.standalone.issue.cancel")}
          </Button>
          <Button
            variant="secondary"
            disabled={!graceValid || preview.isPending}
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
        </div>
      }
    >
      {assignmentsPath ? <StandaloneAssignmentsSummary tenantId={tenantId} /> : null}
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
        <Alert
          tone="error"
          role="alert"
          {...(needsAssignments(preview.error) ? { action: changeRightsLink } : {})}
        >
          {t(standaloneErrorKey(preview.error))}
        </Alert>
      ) : null}
      {confirm.isError ? (
        <Alert
          tone="error"
          role="alert"
          {...(needsAssignments(confirm.error) ? { action: changeRightsLink } : {})}
        >
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

function needsAssignments(error: unknown): boolean {
  return (
    error instanceof ApiRequestError && error.code === "standalone_license_assignments_required"
  );
}
