import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import {
  AGREEMENT_TRANSITIONS,
  type AgreementDocumentForm,
  type AgreementStatus,
} from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  DefinitionGrid,
  EmptyState,
  Input,
  SectionHeader,
  Spinner,
  StatusChip,
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
  updateAgreement,
  uploadAgreementAttachment,
  type AgreementDetail as AgreementDetailData,
  type AgreementDocument,
} from "./api.js";
import { AGREEMENT_STATUS_TO_PHASE } from "./AgreementsPage.js";
import { AgreementDocumentFormField } from "./AgreementDocumentFormField.js";
import {
  AgreementRequisitesForm,
  fromRequisites,
  toRequisitesInput,
  type RequisitesDraft,
} from "./AgreementRequisitesForm.js";
import { AgreementRequisitesSummary } from "./AgreementRequisitesSummary.js";
import { TenantLink, useTenantName } from "./tenantNames.js";

const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);
// Mirrors MAX_ATTACHMENT_BYTES in the API; the API stays the real control.
const MAX_UPLOAD_MB = 20;

type Confirming =
  | { kind: "terminate" }
  | { kind: "unlink" }
  | { kind: "delete"; document: AgreementDocument }
  | null;

export function AgreementDetailPage() {
  const { id = "" } = useParams();
  const agreement = useQuery({
    queryKey: ["platform", "agreements", id],
    queryFn: () => getAgreement(id),
    enabled: id !== "",
  });
  const { t } = useTranslation();

  if (agreement.isPending) return <Spinner label={t("shell.routeLoading")} />;
  if (agreement.error || !agreement.data)
    return <Alert tone="error">{t("agreements.loadError")}</Alert>;
  // Keyed by the stored record so the edit form restarts from the saved values.
  return <AgreementDetail key={id} id={id} detail={agreement.data.agreement} />;
}

function AgreementDetail({ id, detail }: { id: string; detail: AgreementDetailData }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [terminationReason, setTerminationReason] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string>("");
  const [draft, setDraft] = useState<RequisitesDraft>(() => fromRequisites(detail.counterparty));
  const [documentForm, setDocumentForm] = useState<AgreementDocumentForm>(detail.documentForm);
  const [saved, setSaved] = useState(false);

  const tenantName = useTenantName(detail.tenantId);
  const candidates = useQuery({
    queryKey: ["platform", "agreements", id, "tenant-candidates"],
    queryFn: () => agreementTenantCandidates(id),
    enabled: detail.tenantId === null,
  });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["platform", "agreements"] });
  };
  const transition = useMutation({
    mutationFn: (input: { status: AgreementStatus; reason?: string }) =>
      transitionAgreement(id, input.status, input.reason),
    onSuccess: () => {
      setConfirming(null);
      setTerminationReason("");
      invalidate();
    },
  });
  const link = useMutation({
    mutationFn: (tenantId: string) => linkAgreementTenant(id, tenantId),
    onSuccess: () => {
      setCandidate("");
      invalidate();
    },
  });
  const unlink = useMutation({
    mutationFn: () => unlinkAgreementTenant(id),
    onSuccess: () => {
      setConfirming(null);
      invalidate();
    },
  });
  const render = useMutation({ mutationFn: () => renderAgreementDraft(id), onSuccess: invalidate });
  const upload = useMutation({
    mutationFn: (file: File) => uploadAgreementAttachment(id, file),
    onSuccess: invalidate,
  });
  const removeAttachment = useMutation({
    mutationFn: (documentId: string) => deleteAgreementAttachment(id, documentId),
    onSuccess: () => {
      setConfirming(null);
      invalidate();
    },
  });
  const save = useMutation({
    mutationFn: (submitted: { draft: RequisitesDraft; documentForm: AgreementDocumentForm }) =>
      updateAgreement(id, {
        documentForm: submitted.documentForm,
        counterparty: toRequisitesInput(submitted.draft),
      }),
    onSuccess: (response, submitted) => {
      // Take the server-normalised values, but only into a field the operator has not
      // touched since submitting: an edit made while the request was pending stays.
      setDraft((current) =>
        current === submitted.draft ? fromRequisites(response.agreement.counterparty) : current,
      );
      setDocumentForm((current) =>
        current === submitted.documentForm ? response.agreement.documentForm : current,
      );
      setSaved(true);
      invalidate();
    },
  });

  const nextStatuses: readonly AgreementStatus[] = AGREEMENT_TRANSITIONS[detail.status];
  const stored = fromRequisites(detail.counterparty);
  const dirty =
    documentForm !== detail.documentForm ||
    (Object.keys(stored) as (keyof RequisitesDraft)[]).some((key) => stored[key] !== draft[key]);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });
  const dash = <span className="agreement-muted">—</span>;

  const openDocument = async (documentId: string) => {
    // Opened synchronously from the click: a popup blocker refuses a
    // window.open that happens after an await. `noopener` would make the
    // call return null, so the handle is kept and its opener cleared.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const { url } = await downloadAgreementDocument(id, documentId);
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (error) {
      tab?.close();
      throw error;
    }
  };

  const tenantFact = detail.tenantId ? (
    <TenantLink tenantId={detail.tenantId} name={tenantName.data} />
  ) : (
    <span className="agreement-muted">{t("agreements.list.noTenant")}</span>
  );

  return (
    <section className="catalog-page agreement-page">
      <SectionHeader
        eyebrow="COMMERCE / AGREEMENTS"
        title={detail.number}
        description={detail.counterpartyName}
        actions={
          <StatusChip
            phase={AGREEMENT_STATUS_TO_PHASE[detail.status]}
            label={t(`agreements.statuses.${detail.status}`)}
          />
        }
      />

      <DefinitionGrid
        className="agreement-facts"
        items={[
          {
            id: "inn",
            term: t("agreements.columns.inn"),
            description: detail.counterpartyInn ?? dash,
            mono: true,
          },
          {
            id: "date",
            term: t("agreements.columns.conclusionDate"),
            description: detail.conclusionDate ?? dash,
            mono: true,
          },
          {
            id: "form",
            term: t("agreements.columns.documentForm"),
            description: t(`agreements.documentForm.${detail.documentForm}`),
          },
          { id: "tenant", term: t("agreements.columns.tenant"), description: tenantFact },
        ]}
      />

      {!detail.editable && <Alert tone="info">{t("agreements.detail.frozen")}</Alert>}

      <div className="agreement-layout">
        <aside className="agreement-layout__side">
          <Card title={t("agreements.sections.transitions")} titleAs="h2">
            <div className="agreement-panel">
              {detail.terminatedAt && (
                <p className="agreement-panel__note">
                  {t("agreements.detail.terminatedAt", {
                    date: format.format(new Date(detail.terminatedAt)),
                  })}
                  {detail.terminationReason ? ` · ${detail.terminationReason}` : ""}
                </p>
              )}
              {nextStatuses.length === 0 ? (
                <p className="agreement-panel__note">{t("agreements.detail.noTransitions")}</p>
              ) : (
                <div className="agreement-transitions">
                  {nextStatuses.map((status) => (
                    <Button
                      key={status}
                      type="button"
                      variant={
                        status === "terminated"
                          ? "destructive"
                          : status === "signed"
                            ? "primary"
                            : "secondary"
                      }
                      disabled={transition.isPending}
                      onClick={() =>
                        status === "terminated"
                          ? setConfirming({ kind: "terminate" })
                          : transition.mutate({ status })
                      }
                    >
                      {t(`agreements.transitions.${status}`)}
                    </Button>
                  ))}
                </div>
              )}
              {transition.error && confirming === null && (
                <Alert tone="error">{transition.error.message}</Alert>
              )}
            </div>
          </Card>

          <Card title={t("agreements.sections.tenant")} titleAs="h2">
            <div className="agreement-panel">
              {detail.tenantId ? (
                <>
                  <p className="agreement-panel__value">
                    {tenantName.data ?? (
                      <span className="agreement-muted">
                        {tenantName.isPending
                          ? t("agreements.detail.tenantLoading")
                          : detail.tenantId}
                      </span>
                    )}
                  </p>
                  <div className="agreement-transitions">
                    <Link className="agreement-link-button" to={`/tenants/${detail.tenantId}`}>
                      {t("agreements.detail.openTenant")}
                    </Link>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={unlink.isPending}
                      onClick={() => setConfirming({ kind: "unlink" })}
                    >
                      {t("agreements.detail.unlinkTenant")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="agreement-panel__note">{t("agreements.list.noTenant")}</p>
                  {candidates.data?.candidates.length === 0 && (
                    <Alert tone="info">{t("agreements.detail.noCandidates")}</Alert>
                  )}
                  {candidates.data && candidates.data.candidates.length > 0 && (
                    <>
                      <Combobox
                        label={t("agreements.detail.candidateLabel")}
                        value={candidate}
                        options={candidates.data.candidates.map((entry) => ({
                          value: entry.tenantId,
                          label: entry.name,
                          ...(entry.inn ? { description: entry.inn } : {}),
                        }))}
                        placeholder={t("agreements.detail.candidatePlaceholder")}
                        searchPlaceholder={t("agreements.detail.candidateSearch")}
                        emptyText={t("agreements.detail.candidateEmpty")}
                        loadingText={t("agreements.detail.candidateLoading")}
                        onValueChange={setCandidate}
                      />
                      <Button
                        type="button"
                        disabled={candidate === "" || link.isPending}
                        onClick={() => link.mutate(candidate)}
                      >
                        {t("agreements.detail.linkSubmit")}
                      </Button>
                    </>
                  )}
                  {link.error && <Alert tone="error">{link.error.message}</Alert>}
                </>
              )}
            </div>
          </Card>
        </aside>

        <div className="agreement-layout__main">
          <Card title={t("agreements.sections.requisites")} titleAs="h2">
            {detail.editable ? (
              <form
                className="agreement-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSaved(false);
                  save.mutate({ draft, documentForm });
                }}
              >
                <div
                  role="group"
                  aria-label={t("agreements.sections.contract")}
                  className="agreement-group"
                >
                  <h3 className="agreement-group__title">{t("agreements.sections.contract")}</h3>
                  <div className="agreement-group__grid">
                    <AgreementDocumentFormField
                      value={documentForm}
                      onChange={(next) => {
                        setSaved(false);
                        setDocumentForm(next);
                      }}
                    />
                  </div>
                </div>
                <AgreementRequisitesForm
                  value={draft}
                  onChange={(next) => {
                    setSaved(false);
                    setDraft(next);
                  }}
                />
                <p className="agreement-panel__note">{t("agreements.detail.editHint")}</p>
                {save.error && <Alert tone="error">{save.error.message}</Alert>}
                {saved && !dirty && <Alert tone="ok">{t("agreements.detail.saved")}</Alert>}
                <div className="agreement-transitions">
                  <Button type="submit" disabled={!dirty || save.isPending}>
                    {t("agreements.detail.save")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!dirty || save.isPending}
                    onClick={() => {
                      setDraft(stored);
                      setDocumentForm(detail.documentForm);
                    }}
                  >
                    {t("agreements.detail.reset")}
                  </Button>
                </div>
              </form>
            ) : (
              <AgreementRequisitesSummary value={stored} />
            )}
          </Card>

          <Card
            title={t("agreements.sections.documents")}
            titleAs="h2"
            actions={
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={render.isPending}
                  onClick={() => render.mutate()}
                >
                  {t("agreements.detail.renderDraft")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={upload.isPending}
                  onClick={() => fileInput.current?.click()}
                >
                  {t("agreements.detail.uploadFile")}
                </Button>
              </>
            }
          >
            <div className="agreement-panel">
              <input
                ref={fileInput}
                className="agreement-file-input"
                type="file"
                tabIndex={-1}
                aria-label={t("agreements.detail.attach")}
                accept=".pdf,.docx,.png,.jpg,.jpeg"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  // Courtesy checks that save a round trip; the byte-level
                  // check in the API is the real control.
                  if (!ALLOWED_UPLOAD_TYPES.has(file.type)) {
                    setUploadError(t("agreements.detail.badAttachmentType"));
                    return;
                  }
                  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
                    setUploadError(t("agreements.detail.tooLarge", { mb: MAX_UPLOAD_MB }));
                    return;
                  }
                  setUploadError(null);
                  upload.mutate(file);
                }}
              />
              <p className="agreement-panel__note">
                {t("agreements.detail.uploadHint", { mb: MAX_UPLOAD_MB })}
              </p>
              {uploadError && <Alert tone="error">{uploadError}</Alert>}
              {upload.error && <Alert tone="error">{upload.error.message}</Alert>}
              {render.error && <Alert tone="error">{render.error.message}</Alert>}

              {detail.documents.some((document) => document.stale) && (
                // The record says one thing and the stored file says another.
                // Said before the download button, not after: the point is to
                // stop an operator sending a document that no longer matches.
                <Alert tone="warn">{t("agreements.detail.staleDraft")}</Alert>
              )}

              {detail.documents.length === 0 ? (
                <EmptyState
                  title={t("agreements.detail.noDocuments")}
                  hint={t("agreements.detail.noDocumentsHint")}
                />
              ) : (
                <ul className="agreement-docs" aria-label={t("agreements.sections.documents")}>
                  {detail.documents.map((row) => (
                    <li key={row.id} className="agreement-docs__item">
                      <div className="agreement-docs__main">
                        <span className="agreement-docs__name">{row.filename}</span>
                        <span className="agreement-docs__meta">
                          {t(`agreements.documentKinds.${row.kind}`)}
                          {" · "}
                          {t("agreements.detail.sizeKb", { count: Math.ceil(row.byteSize / 1024) })}
                          {" · "}
                          {format.format(new Date(row.createdAt))}
                        </span>
                        {row.stale && (
                          <StatusChip phase="attention" label={t("agreements.detail.staleBadge")} />
                        )}
                      </div>
                      <span className="agreement-row-actions">
                        <Button
                          type="button"
                          size="compact"
                          variant="secondary"
                          onClick={() => void openDocument(row.id)}
                        >
                          {t("agreements.detail.download")}
                        </Button>
                        {row.kind === "attachment" && (
                          <Button
                            type="button"
                            size="compact"
                            variant="secondary"
                            disabled={removeAttachment.isPending}
                            onClick={() => setConfirming({ kind: "delete", document: row })}
                          >
                            {t("agreements.detail.deleteAttachment")}
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirming?.kind === "terminate"}
        tone="destructive"
        title={t("agreements.detail.terminateTitle")}
        description={
          <div className="agreement-panel">
            <p>{t("agreements.detail.terminateBody")}</p>
            <Input
              id="agreement-termination"
              label={t("agreements.fields.terminationReason")}
              value={terminationReason}
              onChange={(event) => setTerminationReason(event.target.value)}
            />
          </div>
        }
        error={confirming?.kind === "terminate" ? transition.error?.message : undefined}
        confirmLabel={t("agreements.detail.terminateConfirm")}
        cancelLabel={t("agreements.detail.cancel")}
        busy={transition.isPending}
        confirmDisabled={terminationReason.trim() === ""}
        onConfirm={() =>
          transition.mutate({ status: "terminated", reason: terminationReason.trim() })
        }
        onCancel={() => {
          setConfirming(null);
          transition.reset();
        }}
      />
      <ConfirmDialog
        open={confirming?.kind === "unlink"}
        title={t("agreements.detail.unlinkConfirmTitle")}
        description={t("agreements.detail.unlinkConfirmBody", {
          number: detail.number,
          name: tenantName.data ?? detail.tenantId ?? "",
        })}
        error={confirming?.kind === "unlink" ? unlink.error?.message : undefined}
        confirmLabel={t("agreements.detail.unlinkTenant")}
        cancelLabel={t("agreements.detail.cancel")}
        busy={unlink.isPending}
        onConfirm={() => unlink.mutate()}
        onCancel={() => {
          setConfirming(null);
          unlink.reset();
        }}
      />
      <ConfirmDialog
        open={confirming?.kind === "delete"}
        tone="destructive"
        title={t("agreements.detail.deleteConfirmTitle")}
        description={t("agreements.detail.deleteConfirmBody", {
          name: confirming?.kind === "delete" ? confirming.document.filename : "",
        })}
        error={confirming?.kind === "delete" ? removeAttachment.error?.message : undefined}
        confirmLabel={t("agreements.detail.deleteAttachment")}
        cancelLabel={t("agreements.detail.cancel")}
        busy={removeAttachment.isPending}
        onConfirm={() => {
          if (confirming?.kind === "delete") removeAttachment.mutate(confirming.document.id);
        }}
        onCancel={() => {
          setConfirming(null);
          removeAttachment.reset();
        }}
      />
    </section>
  );
}
