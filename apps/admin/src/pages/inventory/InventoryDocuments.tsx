import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Checkbox, EmptyState, Spinner, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  downloadInventoryDocumentArtifact,
  downloadInventoryDocumentZip,
  useCompleteInventory,
  useCreateInventoryDocumentRun,
  useInventoryDocumentFormats,
  useInventoryDocumentRuns,
  useRetryInventoryDocumentRun,
} from "./api.js";
import type {
  InventoryDocumentDownload,
  InventoryDocumentRun,
  InventoryStatus,
} from "./schemas.js";

const RETRYABLE_ERRORS = new Set([
  "QUEUE_FAILED",
  "STORAGE_FAILED",
  "GENERATION_FAILED",
  "INVALID_ORGANIZATION_INN",
]);

function openDownload(value: InventoryDocumentDownload): void {
  const anchor = document.createElement("a");
  anchor.href = value.url;
  anchor.download = value.filename;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function statusTone(status: InventoryDocumentRun["status"]): "neutral" | "info" | "ok" | "error" {
  switch (status) {
    case "queued":
      return "neutral";
    case "processing":
      return "info";
    case "ready":
      return "ok";
    case "failed":
      return "error";
  }
}

function runFailureMessage(code: string | null, t: TFunction): string {
  if (code === "VERIFIED_PRODUCTION_DATE_MISSING") {
    return t("pages.inventory.documents.errors.verifiedProductionDateMissing");
  }
  if (code === "INVALID_ORGANIZATION_INN") {
    return t("pages.inventory.documents.errors.invalidOrganizationInn");
  }
  return t("pages.inventory.documents.failed", { code: code ?? "UNKNOWN" });
}

export function InventoryDocuments({
  inventoryId,
  inventoryStatus,
  resultRevision,
  canWrite,
}: {
  inventoryId: string;
  inventoryStatus: InventoryStatus;
  resultRevision: number;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formats = useInventoryDocumentFormats();
  const runs = useInventoryDocumentRuns(inventoryId);
  const create = useCreateInventoryDocumentRun();
  const retry = useRetryInventoryDocumentRun(inventoryId);
  const complete = useCompleteInventory();
  const idempotencyKey = useRef<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloadPending, setDownloadPending] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completed, setCompleted] = useState(false);

  const history = useMemo(
    () =>
      [...(runs.data ?? [])].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      ),
    [runs.data],
  );
  const currentRun = history.find(
    (item) => item.resultRevision === resultRevision && item.status === "ready",
  );
  const currentRunActive = history.some(
    (item) =>
      item.resultRevision === resultRevision &&
      (item.status === "queued" || item.status === "processing"),
  );
  const currentArtifactsReady =
    !currentRunActive &&
    currentRun?.status === "ready" &&
    currentRun.artifacts.length > 0 &&
    currentRun.artifacts.every(
      (artifact) => artifact.invalidatedAt === null && artifact.downloadedAt !== null,
    );
  const mutable = canWrite && inventoryStatus === "closed";
  const availableFormats = formats.data ?? [];
  const selectedFormats = availableFormats
    .filter((format) => selected.has(format.id))
    .map(({ id, version }) => ({ id, version }));

  useEffect(() => {
    setAcknowledged(false);
  }, [currentRun?.id, currentRunActive, resultRevision]);

  const generate = async () => {
    if (!mutable || selectedFormats.length === 0) return;
    const key = idempotencyKey.current ?? globalThis.crypto.randomUUID();
    idempotencyKey.current = key;
    try {
      await create.mutateAsync({ inventoryId, selectedFormats, idempotencyKey: key });
      idempotencyKey.current = null;
      setAcknowledged(false);
    } catch {
      // Mutation state renders a localized, actionable error. Keeping the key
      // makes a deliberate retry idempotent if the first response was lost.
    }
  };

  const download = async (key: string, load: () => Promise<InventoryDocumentDownload>) => {
    setDownloadError(null);
    setDownloadPending(key);
    try {
      openDownload(await load());
      await runs.refetch();
    } catch (error) {
      setDownloadError(error);
    } finally {
      setDownloadPending(null);
    }
  };

  return (
    <Card title={t("pages.inventory.documents.title")} titleAs="h2">
      <div className="mk-inventory-documents">
        {inventoryStatus === "completed" ? (
          <Alert tone="ok">{t("pages.inventory.documents.completedReadOnly")}</Alert>
        ) : null}
        {formats.isPending || runs.isPending ? <Spinner label={t("common.loading")} /> : null}
        {formats.isError || runs.isError ? (
          <Alert tone="error">{t("pages.inventory.documents.errors.load")}</Alert>
        ) : null}

        {!formats.isPending && !formats.isError && availableFormats.length === 0 ? (
          <EmptyState
            title={t("pages.inventory.documents.catalogEmptyTitle")}
            hint={t("pages.inventory.documents.catalogEmptyHint")}
          />
        ) : null}

        {availableFormats.length > 0 ? (
          <section aria-labelledby="inventory-document-formats-title">
            <h3 id="inventory-document-formats-title">
              {t("pages.inventory.documents.selectionTitle")}
            </h3>
            <p className="mk-inventory-section-description">
              {t("pages.inventory.documents.selectionHint")}
            </p>
            <div className="mk-inventory-document-formats">
              {availableFormats.map((format) => (
                <Checkbox
                  key={`${format.id}@${format.version}`}
                  checked={selected.has(format.id)}
                  disabled={!mutable || create.isPending}
                  label={`${format.label} · ${format.extension.toUpperCase()} · v${format.version}`}
                  onCheckedChange={(checked) => {
                    idempotencyKey.current = null;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(format.id);
                      else next.delete(format.id);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
            {mutable ? (
              <div className="mk-inventory-actions">
                <Button
                  type="button"
                  disabled={selectedFormats.length === 0}
                  loading={create.isPending}
                  onClick={() => void generate()}
                >
                  {t("pages.inventory.documents.generate")}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {create.isError ? <Alert tone="error">{errorMessage(create.error, t)}</Alert> : null}
        {retry.isError ? <Alert tone="error">{errorMessage(retry.error, t)}</Alert> : null}
        {downloadError ? <Alert tone="error">{errorMessage(downloadError, t)}</Alert> : null}

        <section aria-labelledby="inventory-document-history-title">
          <h3 id="inventory-document-history-title">{t("pages.inventory.documents.history")}</h3>
          {!runs.isPending && !runs.isError && history.length === 0 ? (
            <p className="mk-inventory-section-description">
              {t("pages.inventory.documents.historyEmpty")}
            </p>
          ) : null}
          <div className="mk-inventory-document-runs">
            {history.map((item) => (
              <DocumentRun
                key={item.id}
                item={item}
                currentRevision={resultRevision}
                canRetry={
                  mutable &&
                  item.resultRevision === resultRevision &&
                  item.status === "failed" &&
                  item.errorCode !== null &&
                  RETRYABLE_ERRORS.has(item.errorCode)
                }
                retryPending={retry.isPending}
                downloadPending={downloadPending}
                language={i18n.language}
                onRetry={() => retry.mutate(item.id)}
                onDownloadArtifact={(artifactId) =>
                  void download(`artifact:${artifactId}`, () =>
                    downloadInventoryDocumentArtifact(item.id, artifactId),
                  )
                }
                onDownloadZip={() =>
                  void download(`zip:${item.id}`, () => downloadInventoryDocumentZip(item.id))
                }
              />
            ))}
          </div>
        </section>

        {inventoryStatus === "closed" && canWrite && availableFormats.length > 0 ? (
          <section
            className="mk-inventory-document-completion"
            aria-labelledby="inventory-document-completion-title"
          >
            <h3 id="inventory-document-completion-title">
              {t("pages.inventory.documents.completionTitle")}
            </h3>
            {!currentArtifactsReady ? (
              <Alert tone="info">{t("pages.inventory.documents.downloadFirst")}</Alert>
            ) : null}
            <Checkbox
              checked={acknowledged}
              disabled={!currentArtifactsReady || complete.isPending}
              label={t("pages.inventory.close.documentsChecked")}
              onCheckedChange={setAcknowledged}
            />
            {complete.isError ? (
              <Alert tone="error">{errorMessage(complete.error, t)}</Alert>
            ) : null}
            {completed ? (
              <Alert tone="ok">{t("pages.inventory.close.success.completed")}</Alert>
            ) : null}
            <div className="mk-inventory-actions">
              <Button
                type="button"
                disabled={!currentArtifactsReady || !acknowledged}
                loading={complete.isPending}
                onClick={() =>
                  complete.mutate(inventoryId, {
                    onSuccess: () => setCompleted(true),
                  })
                }
              >
                {t("pages.inventory.close.complete")}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

function DocumentRun({
  item,
  currentRevision,
  canRetry,
  retryPending,
  downloadPending,
  language,
  onRetry,
  onDownloadArtifact,
  onDownloadZip,
}: {
  item: InventoryDocumentRun;
  currentRevision: number;
  canRetry: boolean;
  retryPending: boolean;
  downloadPending: string | null;
  language: string;
  onRetry: () => void;
  onDownloadArtifact: (artifactId: string) => void;
  onDownloadZip: () => void;
}) {
  const { t } = useTranslation();
  const validArtifacts = item.artifacts.filter((artifact) => artifact.invalidatedAt === null);
  return (
    <article className="mk-inventory-document-run">
      <header>
        <span>
          <strong>
            {t("pages.inventory.documents.runRevision", { revision: item.resultRevision })}
          </strong>
          <small>
            {new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
              new Date(item.createdAt),
            )}
          </small>
        </span>
        <StatusChip
          status={statusTone(item.status)}
          label={t(`pages.inventory.documents.status.${item.status}`)}
        />
      </header>
      {item.resultRevision !== currentRevision ? (
        <Alert tone="warn">{t("pages.inventory.documents.previousRevision")}</Alert>
      ) : null}
      {item.status === "failed" ? (
        <div className="mk-inventory-document-run__failure">
          <Alert tone="error">{runFailureMessage(item.errorCode, t)}</Alert>
          {canRetry ? (
            <Button
              type="button"
              size="compact"
              variant="secondary"
              loading={retryPending}
              onClick={onRetry}
            >
              {t("pages.inventory.documents.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {item.artifacts.length > 0 ? (
        <ul className="mk-inventory-document-artifacts">
          {item.artifacts.map((artifact) => {
            const invalidated = artifact.invalidatedAt !== null;
            return (
              <li key={artifact.id}>
                <span>
                  <strong>{artifact.filename}</strong>
                  <small>
                    {t("pages.inventory.documents.artifactMeta", {
                      codes: new Intl.NumberFormat(language).format(artifact.codeCount),
                      boxes: new Intl.NumberFormat(language).format(artifact.boxCount),
                      bytes: new Intl.NumberFormat(language).format(artifact.byteSize),
                    })}
                  </small>
                  {invalidated ? (
                    <small className="mk-inventory-error">
                      {t("pages.inventory.documents.invalidated")}
                    </small>
                  ) : artifact.downloadedAt ? (
                    <small>{t("pages.inventory.documents.downloaded")}</small>
                  ) : null}
                </span>
                <Button
                  type="button"
                  size="compact"
                  variant="secondary"
                  disabled={invalidated}
                  loading={downloadPending === `artifact:${artifact.id}`}
                  onClick={() => onDownloadArtifact(artifact.id)}
                >
                  {invalidated
                    ? t("pages.inventory.documents.unavailable")
                    : t("pages.inventory.documents.downloadArtifact", {
                        filename: artifact.filename,
                      })}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {item.status === "ready" && validArtifacts.length > 0 ? (
        <div className="mk-inventory-actions">
          <Button
            type="button"
            variant="secondary"
            loading={downloadPending === `zip:${item.id}`}
            onClick={onDownloadZip}
          >
            {t("pages.inventory.documents.downloadZip")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function errorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError && error.code) {
    const known: Record<string, string> = {
      INVENTORY_DOCUMENT_FORMAT_UNKNOWN: "formatChanged",
      INVENTORY_DOCUMENT_FORMAT_SUPERSEDED: "formatChanged",
      INVENTORY_DOCUMENT_FORMAT_UNAVAILABLE: "formatChanged",
      INVENTORY_DOCUMENT_FORMAT_INVALID: "formatChanged",
      INVENTORY_DOCUMENT_RUN_REQUIRES_CLOSED: "requiresClosed",
      INVENTORY_DOCUMENT_RUN_NOT_RETRYABLE: "notRetryable",
      INVENTORY_DOCUMENT_RUNS_ACTIVE: "runsActive",
      INVENTORY_DOCUMENT_ARTIFACT_INVALIDATED: "invalidated",
      INVENTORY_DOCUMENT_ARTIFACTS_UNAVAILABLE: "catalogUnavailable",
      INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY: "notReady",
      INVENTORY_DOCUMENTS_NOT_ACKNOWLEDGED: "notAcknowledged",
      INVENTORY_LATE_EVENTS_UNRESOLVED: "lateEvents",
      ORGANIZATION_INN_REQUIRED: "organizationInnRequired",
    };
    const key = known[error.code];
    if (key) return t(`pages.inventory.documents.errors.${key}`);
  }
  return t("pages.inventory.documents.errors.action");
}
