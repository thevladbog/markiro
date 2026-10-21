import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, Button, Input, Modal, RadioGroup } from "@markiro/ui";
import {
  STANDALONE_DEMO_TERM_MAX_DAYS,
  type StandaloneIssuanceSource,
  type StandaloneSite,
} from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { confirmStandaloneLicense, previewStandaloneLicense } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import {
  standaloneErrorKey,
  standaloneSitesKey,
  standaloneWarningText,
} from "./standalone-format.js";
import {
  assignmentsDiffer,
  StandaloneAssignmentsSummary,
  tenantAssignmentsKey,
  useTenantAssignments,
} from "./StandaloneAssignmentsSummary.js";
import { StandaloneLicenseComparison } from "./StandaloneLicenseComparison.js";

/** The trial's 14 days are the usual demo term: a trial extension or a payment bridge. */
const DEFAULT_DEMO_TERM_DAYS = "14";

/**
 * Spec §6.2 steps 2–3: preview «before → after», then confirm and download the
 * `.mklic`. The rights of a tenant without a cabinet are its direct plan and
 * add-on assignments (spec 2026-10-16); the manual offline terms are gone. Such a
 * tenant may also get a demo file of 1 to 45 days (spec 2026-10-20 §4.2–4.3).
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
  const [kind, setKind] = useState<"subscription" | "demo">("subscription");
  const [term, setTerm] = useState(DEFAULT_DEMO_TERM_DAYS);
  const demoKind = assignmentsPath && kind === "demo";
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [issuedSequence, setIssuedSequence] = useState<number | null>(null);
  const graceDays = grace.trim() === "" ? null : Number(grace.trim());
  const graceValid =
    graceDays === null || (Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= 60);
  const termDays = term.trim() === "" ? Number.NaN : Number(term.trim());
  const termValid =
    Number.isInteger(termDays) && termDays >= 1 && termDays <= STANDALONE_DEMO_TERM_MAX_DAYS;
  // A demo has no grace; its term is the only thing the operator types.
  const terms = demoKind
    ? { graceDays: null, offline: null, demo: { termDays } }
    : { graceDays, offline: null };
  const termsValid = demoKind ? termValid : graceValid;
  const preview = useMutation({
    mutationFn: () => previewStandaloneLicense(tenantId, site.id, terms),
    onSuccess: () => {
      setRequestId(crypto.randomUUID());
      setIssuedSequence(null);
      // Compare the preview with the tenant as it is now, not with an older read.
      if (assignmentsPath)
        void queryClient.invalidateQueries({ queryKey: tenantAssignmentsKey(tenantId) });
    },
  });
  const tenant = useTenantAssignments(tenantId, assignmentsPath);
  const previewed = assignmentsPath ? (preview.data?.next.sourceAssignments ?? null) : null;
  // After the refetch the card must show what the API will issue from; until then, or
  // when it cannot be read, the server's terms digest still refuses a moved preview.
  const assignmentsChanged =
    previewed !== null &&
    tenant.data !== undefined &&
    !tenant.isFetching &&
    !tenant.isError &&
    assignmentsDiffer(previewed, tenant.data, new Date(preview.data?.next.validFrom ?? 0));
  const awaitingAssignments = previewed !== null && tenant.isFetching;
  const confirm = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error("preview required");
      return confirmStandaloneLicense(tenantId, site.id, {
        requestId,
        ...terms,
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
            disabled={!termsValid || preview.isPending}
            onClick={() => {
              confirm.reset();
              preview.mutate();
            }}
          >
            {t("tenants.detail.standalone.issue.preview")}
          </Button>
          <Button
            disabled={
              !preview.data || confirm.isPending || assignmentsChanged || awaitingAssignments
            }
            onClick={() => confirm.mutate()}
          >
            {t("tenants.detail.standalone.issue.confirm")}
          </Button>
        </div>
      }
    >
      {assignmentsPath ? (
        <StandaloneAssignmentsSummary
          tenantId={tenantId}
          detail={tenant.data}
          isError={tenant.isError}
          previewed={previewed}
          changed={assignmentsChanged}
          demo={demoKind}
        />
      ) : null}
      {assignmentsPath ? (
        <RadioGroup
          label={t("tenants.detail.standalone.issue.kind.label")}
          value={kind}
          onValueChange={(value) => {
            setKind(value === "demo" ? "demo" : "subscription");
            preview.reset();
            confirm.reset();
          }}
          options={[
            {
              value: "subscription",
              label: t("tenants.detail.standalone.issue.kind.subscription"),
            },
            { value: "demo", label: t("tenants.detail.standalone.issue.kind.demo") },
          ]}
        />
      ) : null}
      {demoKind ? (
        <Input
          label={t("tenants.detail.standalone.issue.demoTerm")}
          hint={t("tenants.detail.standalone.issue.demoTermHint")}
          inputMode="numeric"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            preview.reset();
          }}
          {...(termValid ? {} : { error: t("tenants.detail.standalone.issue.demoTermInvalid") })}
        />
      ) : (
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
      )}
      {issuedSequence !== null ? (
        <Alert tone="ok" role="status">
          {t("tenants.detail.standalone.issue.issued", { sequence: issuedSequence })}
        </Alert>
      ) : null}
      {preview.isError ? (
        <>
          <Alert tone="error" role="alert">
            {t(standaloneErrorKey(preview.error))}
          </Alert>
          {needsAssignments(preview.error) ? changeRightsLink : null}
        </>
      ) : null}
      {confirm.isError ? (
        <>
          <Alert tone="error" role="alert">
            {t(standaloneErrorKey(confirm.error))}
          </Alert>
          {needsAssignments(confirm.error) ? changeRightsLink : null}
        </>
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
          {preview.data.next.source === "offline_demo" ? (
            <Alert tone="info">
              {t(
                preview.data.next.sourceAssignments === null
                  ? "tenants.detail.standalone.issue.demoExtension"
                  : "tenants.detail.standalone.issue.demoBridge",
              )}
            </Alert>
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
