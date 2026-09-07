import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@markiro/ui";
import type {
  FinalizeReceivingInput,
  ReceivingDraftRecord,
  ReceivingFinalizedRecord,
  ReceivingReadiness,
  ReferenceDocument,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { ReceivingExemptionReview, type ReceivingExemptionLabels } from "./exemption-review.js";
import { receivingQuantityTotals } from "./quantity-totals.js";

const emptyLabels: ReceivingExemptionLabels = {
  products: new Map(),
  locations: new Map(),
};

function equalLines(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function ReceivingFinalizationDialog({
  client,
  record,
  readiness,
  beginMutation,
  onLocked,
  onClose,
  onReload,
  onFinalized,
  onConflict,
  onForbidden,
  onSessionLost,
}: {
  client: UsBrowserClient;
  record: ReceivingDraftRecord;
  readiness: ReceivingReadiness;
  beginMutation: () => () => void;
  onLocked: (locked: boolean) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onFinalized: (record: ReceivingFinalizedRecord) => void;
  onConflict: (error: UsClientError) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [documents, setDocuments] = useState<
    { document: ReferenceDocument; issuer: string | null }[] | null
  >(null);
  const [documentFailure, setDocumentFailure] = useState(false);
  const [reviewedLines, setReviewedLines] = useState<number[]>([]);
  const [labels, setLabels] = useState<ReceivingExemptionLabels | null>(null);
  const [labelFailure, setLabelFailure] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const command = useRef<FinalizeReceivingInput | null>(null);
  const labelRequest = useRef<{
    key: string;
    promise: Promise<ReceivingExemptionLabels>;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    onLocked(true);
    return () => {
      alive.current = false;
      onLocked(false);
    };
  }, [onLocked]);
  useEffect(() => {
    let current = true;
    void Promise.all(
      record.draft.documentIds.map(async (id) => {
        const document = await client.getReferenceDocument(id);
        const party = document.partyId ? await client.getParty(document.partyId) : null;
        return { document, issuer: party?.legalName ?? party?.name ?? null };
      }),
    )
      .then((result) => {
        if (current) setDocuments(result);
      })
      .catch(async (error: unknown) => {
        if (!current) return;
        setDocumentFailure(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      current = false;
    };
  }, [client, record, onForbidden, onSessionLost]);
  const exemptLines = record.draft.items.flatMap((item, index) =>
    item.exemptSupplier ? [index + 1] : [],
  );
  const requiredLines = readiness.exemptReviewRequiredLines;
  const exactRequiredLines = equalLines(exemptLines, requiredLines);
  const reviewMetadataValid =
    exactRequiredLines &&
    requiredLines.every((line) => {
      const item = record.draft.items[line - 1];
      const sourceLocationId =
        item?.source?.kind === "location"
          ? item.source.locationId
          : item?.source?.kind === "reference"
            ? item.source.resolvedLocationId
            : null;
      return Boolean(
        item?.exemptSupplier &&
        item.productId &&
        item.exemptReason &&
        item.exemptReceipt?.evidenceUrl &&
        item.exemptReceipt.tlcHandling &&
        sourceLocationId &&
        record.draft.locationId &&
        record.draft.previousSourceLocationId,
      );
    });
  const reviewComplete = equalLines(requiredLines, reviewedLines);

  useEffect(() => {
    let current = true;
    setReviewedLines([]);
    setLabelFailure(false);
    if (!record.draft.items.some((item) => item.exemptSupplier)) {
      setLabels(emptyLabels);
      return () => {
        current = false;
      };
    }
    setLabels(null);
    const productIds = [
      ...new Set(
        record.draft.items.flatMap((item) =>
          item.exemptSupplier && item.productId ? [item.productId] : [],
        ),
      ),
    ];
    const locationIds = [
      ...new Set(
        [
          record.draft.locationId,
          record.draft.previousSourceLocationId,
          ...record.draft.items.flatMap((item) => {
            if (!item.exemptSupplier || !item.source) return [];
            return [
              item.source.kind === "location"
                ? item.source.locationId
                : item.source.resolvedLocationId,
            ];
          }),
        ].filter((id): id is string => id !== null),
      ),
    ];
    const key = `${record.id}/${record.draftVersion}/${productIds.join(",")}/${locationIds.join(",")}`;
    if (labelRequest.current?.key !== key) {
      labelRequest.current = {
        key,
        promise: Promise.all([
          Promise.all(
            productIds.map(async (id) => [id, (await client.getProduct(id)).name] as const),
          ),
          Promise.all(
            locationIds.map(async (id) => [id, (await client.getLocation(id)).name] as const),
          ),
        ]).then(([products, locations]) => ({
          products: new Map(products),
          locations: new Map(locations),
        })),
      };
    }
    void labelRequest.current.promise
      .then((result) => {
        if (current) setLabels(result);
      })
      .catch(async (error: unknown) => {
        if (!current) return;
        setLabelFailure(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      current = false;
    };
  }, [client, record, onForbidden, onSessionLost]);
  function close() {
    if (busy.current || uncertain) return;
    onClose();
  }
  async function submit() {
    if (
      busy.current ||
      !documents ||
      documentFailure ||
      !labels ||
      labelFailure ||
      !reviewMetadataValid ||
      !reviewComplete
    )
      return;
    busy.current = true;
    setPending(true);
    command.current ??= {
      operationKey: crypto.randomUUID(),
      expectedDraftVersion: record.draftVersion,
      expectedInputDigest: readiness.inputDigest,
      ...(requiredLines.length ? { reviewedExemptLines: reviewedLines } : {}),
    };
    const release = beginMutation();
    try {
      const result = await client.finalizeReceiving(record.id, command.current);
      if (alive.current) onFinalized(result);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        onSessionLost();
        return;
      }
      if (error instanceof UsClientError && error.code === "forbidden") {
        onConflict(error);
        await onForbidden();
        return;
      }
      if (
        error instanceof UsClientError &&
        !["unavailable", "invalid_response", "rate_limited"].includes(error.code)
      ) {
        onConflict(error);
        return;
      }
      setUncertain(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }
  const totals = receivingQuantityTotals(record.draft.items);
  const created = record.draft.items.filter(
    (item) => item.lotLinkMode === "create_on_finalize",
  ).length;
  return (
    <Modal
      open
      title={t("receiving.confirmTitle")}
      closeLabel={t("receiving.cancel")}
      onClose={close}
      width={640}
      className="us-rec-confirm"
      footer={
        <div className="us-rec-confirm-actions">
          {uncertain || documentFailure || labelFailure ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                if (!busy.current) void onReload();
              }}
            >
              {t("receiving.reloadCurrent")}
            </Button>
          ) : (
            <Button type="button" variant="secondary" disabled={pending} onClick={close}>
              {t("receiving.cancel")}
            </Button>
          )}
          <Button
            type="button"
            disabled={
              pending ||
              !documents ||
              documentFailure ||
              !labels ||
              labelFailure ||
              !reviewMetadataValid ||
              !reviewComplete
            }
            onClick={() => void submit()}
          >
            {t(
              pending
                ? "receiving.finalizing"
                : uncertain
                  ? "receiving.retryFinalize"
                  : "receiving.confirmFinalize",
            )}
          </Button>
        </div>
      }
    >
      <div className="us-rec-frozen" aria-busy={pending}>
        <strong>{record.eventNumber}</strong>
        <p>
          {record.draft.dateReceived} · {record.timeZone}
        </p>
        <p>
          {t("receiving.confirmCounts", {
            lines: record.draft.items.length,
            created,
            linked: record.draft.items.length - created,
          })}
        </p>
        <section>
          <h3>{t("receiving.totals")}</h3>
          <ul>
            {totals.map((total) => (
              <li key={total.unit}>
                {total.quantity} {total.unit}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>{t("receiving.documents")}</h3>
          {documentFailure ? (
            <p role="alert">{t("receiving.confirmDocumentsFailed")}</p>
          ) : documents ? (
            documents.length ? (
              <ul>
                {documents.map(({ document, issuer }) => (
                  <li key={document.id}>
                    {document.type === "other"
                      ? document.typeOtherLabel
                      : t(`receivingRef.types.${document.type}`)}{" "}
                    · {document.number}
                    {document.issuedOn ? ` · ${document.issuedOn}` : ""}
                    {issuer ? ` · ${issuer}` : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("receiving.noDocuments")}</p>
            )
          ) : (
            <p role="status">{t("md.stale")}</p>
          )}
        </section>
        {requiredLines.length ? (
          !exactRequiredLines || !reviewMetadataValid ? (
            <p role="alert">{t("receiving.reviewMetadataMismatch")}</p>
          ) : labelFailure ? (
            <p role="alert">{t("receiving.reviewLabelsFailed")}</p>
          ) : labels ? (
            <ReceivingExemptionReview
              record={record}
              requiredLines={requiredLines}
              reviewedLines={reviewedLines}
              disabled={pending || uncertain}
              onChange={(lines) => {
                if (!pending && !uncertain) setReviewedLines(lines);
              }}
              labels={labels}
            />
          ) : (
            <p role="status">{t("receiving.reviewLabelsLoading")}</p>
          )
        ) : null}
        {readiness.issues.length ? (
          <section>
            <h3>{t("receiving.confirmWarnings")}</h3>
            <ul>
              {readiness.issues.map((issue, index) => (
                <li key={index}>
                  {issue.line ? `${t("receiving.line", { number: issue.line })} · ` : ""}
                  {t(`receivingReadiness.fields.${issue.field}`)}:{" "}
                  {t(
                    issue.field === "documents" && issue.code === "required"
                      ? "receivingReadiness.documentRecommended"
                      : `receivingReadiness.codes.${issue.code}`,
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="us-rec-hint">{t("receiving.confirmScope")}</p>
        {uncertain ? (
          <p role="alert" className="us-md-notice us-md-notice--alert">
            {t("receiving.finalizeUncertain")}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
