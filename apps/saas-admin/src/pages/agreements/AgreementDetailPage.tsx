import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { AGREEMENT_TRANSITIONS, type AgreementStatus } from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Input,
  SectionHeader,
  Spinner,
  StatusChip,
  Table,
  type StatusChipStatus,
} from "@markiro/ui";

import {
  agreementTenantCandidates,
  deleteAgreementAttachment,
  downloadAgreementDocument,
  getAgreement,
  linkAgreementTenant,
  renderAgreementDraft,
  transitionAgreement,
  unlinkAgreementTenant,
  uploadAgreementAttachment,
} from "./api.js";
import { AgreementRequisitesForm, fromRequisites } from "./AgreementRequisitesForm.js";

const STATUS_CHIP: Record<AgreementStatus, StatusChipStatus> = {
  draft: "neutral",
  in_review: "info",
  sent: "info",
  signed: "ok",
  terminated: "warn",
};

const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);

export function AgreementDetailPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const client = useQueryClient();
  const [terminationReason, setTerminationReason] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const agreement = useQuery({
    queryKey: ["platform", "agreements", id],
    queryFn: () => getAgreement(id),
    enabled: id !== "",
  });
  const candidates = useQuery({
    queryKey: ["platform", "agreements", id, "tenant-candidates"],
    queryFn: () => agreementTenantCandidates(id),
    enabled: id !== "",
  });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["platform", "agreements"] });
  };
  const transition = useMutation({
    mutationFn: (status: AgreementStatus) =>
      transitionAgreement(
        id,
        status,
        status === "terminated" ? terminationReason.trim() : undefined,
      ),
    onSuccess: invalidate,
  });
  const link = useMutation({
    mutationFn: (tenantId: string) => linkAgreementTenant(id, tenantId),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: () => unlinkAgreementTenant(id),
    onSuccess: invalidate,
  });
  const render = useMutation({ mutationFn: () => renderAgreementDraft(id), onSuccess: invalidate });
  const upload = useMutation({
    mutationFn: (file: File) => uploadAgreementAttachment(id, file),
    onSuccess: invalidate,
  });
  const removeAttachment = useMutation({
    mutationFn: (documentId: string) => deleteAgreementAttachment(id, documentId),
    onSuccess: invalidate,
  });

  if (agreement.isPending) return <Spinner label={t("shell.routeLoading")} />;
  if (agreement.error || !agreement.data)
    return <Alert tone="error">{t("agreements.loadError")}</Alert>;

  const detail = agreement.data.agreement;
  const nextStatuses: readonly AgreementStatus[] = AGREEMENT_TRANSITIONS[detail.status];

  const openDocument = async (documentId: string) => {
    const { url } = await downloadAgreementDocument(id, documentId);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <section className="catalog-page">
      <SectionHeader
        eyebrow="COMMERCE / AGREEMENTS"
        title={detail.number}
        description={detail.counterpartyName}
      />

      <StatusChip
        status={STATUS_CHIP[detail.status]}
        label={t(`agreements.statuses.${detail.status}`)}
      />

      {!detail.editable && <Alert tone="info">{t("agreements.detail.frozen")}</Alert>}

      <h3>{t("agreements.sections.transitions")}</h3>
      {nextStatuses.includes("terminated") && (
        <Input
          id="agreement-termination"
          label={t("agreements.fields.terminationReason")}
          value={terminationReason}
          onChange={(event) => setTerminationReason(event.target.value)}
        />
      )}
      <div className="agreement-transitions">
        {nextStatuses.length === 0 && <p>{t("agreements.detail.noTransitions")}</p>}
        {nextStatuses.map((status) => (
          <Button
            key={status}
            type="button"
            disabled={
              transition.isPending || (status === "terminated" && terminationReason.trim() === "")
            }
            onClick={() => transition.mutate(status)}
          >
            {t(`agreements.transitions.${status}`)}
          </Button>
        ))}
      </div>
      {transition.error && <Alert tone="error">{transition.error.message}</Alert>}

      <h3>{t("agreements.sections.tenant")}</h3>
      {detail.tenantId ? (
        <p>
          {detail.tenantId}{" "}
          <Button type="button" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
            {t("agreements.detail.unlinkTenant")}
          </Button>
        </p>
      ) : (
        <>
          <p>{t("agreements.list.noTenant")}</p>
          {candidates.data?.candidates.length === 0 && (
            <Alert tone="info">{t("agreements.detail.noCandidates")}</Alert>
          )}
          {candidates.data?.candidates.map((candidate) => (
            <Button
              key={candidate.tenantId}
              type="button"
              disabled={link.isPending}
              onClick={() => link.mutate(candidate.tenantId)}
            >
              {t("agreements.detail.linkTenant", { name: candidate.name })}
            </Button>
          ))}
        </>
      )}

      <h3>{t("agreements.sections.counterparty")}</h3>
      <AgreementRequisitesForm
        value={fromRequisites(detail.counterparty)}
        onChange={() => undefined}
        disabled={!detail.editable}
      />

      <h3>{t("agreements.sections.documents")}</h3>
      <Button type="button" onClick={() => render.mutate()} disabled={render.isPending}>
        {t("agreements.detail.renderDraft")}
      </Button>

      <Input
        id="agreement-attachment"
        label={t("agreements.detail.attach")}
        type="file"
        accept=".pdf,.docx,.png,.jpg,.jpeg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          // A courtesy check that saves a round trip; the byte-level check in
          // the API is the real control.
          if (!ALLOWED_UPLOAD_TYPES.has(file.type)) {
            setUploadError(t("agreements.detail.badAttachmentType"));
            return;
          }
          setUploadError(null);
          upload.mutate(file);
        }}
      />
      {uploadError && <Alert tone="error">{uploadError}</Alert>}
      {upload.error && <Alert tone="error">{upload.error.message}</Alert>}

      <Table<(typeof detail.documents)[number]>
        scrollLabel={t("agreements.sections.documents")}
        empty={t("agreements.detail.noDocuments")}
        rows={[...detail.documents]}
        getRowKey={(row) => row.id}
        columns={[
          {
            key: "kind",
            title: t("agreements.columns.documentKind"),
            render: (row) => t(`agreements.documentKinds.${row.kind}`),
          },
          { key: "filename", title: t("agreements.columns.filename"), wrap: true },
          {
            key: "size",
            title: t("agreements.columns.size"),
            mono: true,
            align: "right",
            render: (row) => `${Math.ceil(row.byteSize / 1024)} КБ`,
          },
          {
            key: "actions",
            title: t("agreements.columns.actions"),
            render: (row) => (
              <>
                <Button type="button" onClick={() => void openDocument(row.id)}>
                  {t("agreements.detail.download")}
                </Button>
                {row.kind === "attachment" && (
                  <Button
                    type="button"
                    disabled={removeAttachment.isPending}
                    onClick={() => removeAttachment.mutate(row.id)}
                  >
                    {t("agreements.detail.deleteAttachment")}
                  </Button>
                )}
              </>
            ),
          },
        ]}
      />
    </section>
  );
}
