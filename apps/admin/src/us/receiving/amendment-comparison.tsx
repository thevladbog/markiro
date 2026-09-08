import type { ReceivingDraft } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { ReceivingFrozenView } from "./live-record.js";

export type FrozenReceivingLine = ReceivingFrozenView["content"]["snapshot"]["items"][number];

export function ReceivingFrozenIdentity({ item }: { item: FrozenReceivingLine }) {
  const { t } = useTranslation();
  const source = item.sourceDescription;
  const basis = "receiptBasis" in item ? item.receiptBasis : null;
  return (
    <dl className="us-rec-identity">
      <dt>{t("receiving.lot")}</dt>
      <dd>{item.lotId}</dd>
      <dt>{t("receiving.product")}</dt>
      <dd>
        {item.productDescription.productName} · {item.productId}
      </dd>
      <dt>{t("receiving.tlc")}</dt>
      <dd>{item.tlc}</dd>
      <dt>{t("receiving.sourceKind")}</dt>
      <dd>
        {t(item.source.kind === "reference" ? "receiving.referenceKind" : "receiving.locationKind")}
      </dd>
      {item.source.kind === "reference" ? (
        <>
          <dt>{t("receiving.sourceReference")}</dt>
          <dd>
            {item.source.referenceKind} · {item.source.referenceValue}
          </dd>
          <dt>{t("receiving.resolvedLocation")}</dt>
          <dd>{item.source.resolvedLocationId}</dd>
        </>
      ) : (
        <>
          <dt>{t("receiving.sourceLocation")}</dt>
          <dd>{item.source.locationId}</dd>
        </>
      )}
      <dt>{t("receiving.sourceDescription")}</dt>
      <dd>
        {source.businessName} ·{" "}
        {source.address.kind === "street"
          ? source.address.streetAddress
          : `${source.address.latitude}, ${source.address.longitude}`}{" "}
        · {source.city}, {source.stateOrRegion} {source.zipOrPostalCode} · {source.countryDisplay} ·{" "}
        {source.phoneNumber}
      </dd>
      <dt>{t("receiving.linkMode")}</dt>
      <dd>
        {t(
          item.lotLinkMode === "create_on_finalize"
            ? "receiving.createdLot"
            : "receiving.linkedLot",
        )}
      </dd>
      <dt>{t("receiving.receiptBasis")}</dt>
      <dd>
        {t(
          basis?.kind === "exempt_assigned_tlc"
            ? "receiving.assignedBasis"
            : basis?.kind === "exempt_existing_tlc"
              ? "receiving.existingBasis"
              : "receiving.ordinaryBasis",
        )}
      </dd>
    </dl>
  );
}

export function ReceivingAmendmentComparison({
  predecessor,
  draft,
}: {
  predecessor: ReceivingFrozenView;
  draft: ReceivingDraft;
}) {
  const { t } = useTranslation();
  const snapshot = predecessor.content.snapshot;
  const bound = new Set(
    draft.items.flatMap((item) => ("previousLineNo" in item ? [item.previousLineNo] : [])),
  );
  return (
    <section
      className="us-rec-comparison us-rec-section"
      aria-label={t("receiving.previousRevision")}
    >
      <h2>
        {t("receiving.previousRevision")} · {predecessor.revision}
      </h2>
      <p className="us-rec-hint">{t("receiving.comparisonHint")}</p>
      <dl className="us-rec-identity">
        <dt>{t("receiving.date")}</dt>
        <dd>
          {snapshot.dateReceived} · {predecessor.timeZone}
        </dd>
        <dt>{t("receiving.location")}</dt>
        <dd>{snapshot.locationDescription.businessName}</dd>
        <dt>{t("receiving.previousSource")}</dt>
        <dd>{snapshot.previousSourceDescription.businessName}</dd>
        <dt>{t("receiving.receivedAtNote")}</dt>
        <dd>{snapshot.receivedAtNote ?? "—"}</dd>
        <dt>{t("receiving.notes")}</dt>
        <dd>{snapshot.notes ?? "—"}</dd>
      </dl>
      <ol className="us-rec-history-lines">
        {snapshot.items.map((item) => {
          const basis = "receiptBasis" in item ? item.receiptBasis : null;
          return (
            <li key={item.lineNo} className="us-rec-review-line">
              <h3>{t("receiving.line", { number: item.lineNo })}</h3>
              <p>
                {t(
                  bound.has(item.lineNo)
                    ? "receiving.retainedLot"
                    : "receiving.removedFromCorrection",
                )}
              </p>
              <ReceivingFrozenIdentity item={item} />
              <dl className="us-rec-identity">
                <dt>{t("receiving.quantity")}</dt>
                <dd>
                  {item.quantity} {item.unitOfMeasure}
                </dd>
                <dt>{t("receiving.supplierLot")}</dt>
                <dd>{item.supplierLotReference ?? "—"}</dd>
                <dt>{t("receiving.lineNotes")}</dt>
                <dd>{item.notes ?? "—"}</dd>
                {basis && basis.kind !== "ordinary" ? (
                  <>
                    <dt>{t("receiving.exemptReason")}</dt>
                    <dd>{basis.reason}</dd>
                    <dt>{t("receiving.evidenceUrl")}</dt>
                    <dd>{basis.evidenceUrl}</dd>
                    <dt>{t("receiving.reviewedBy")}</dt>
                    <dd>{basis.reviewedBy}</dd>
                  </>
                ) : null}
              </dl>
            </li>
          );
        })}
      </ol>
      <h3>{t("receiving.documents")}</h3>
      {snapshot.documents.length ? (
        <ul>
          {snapshot.documents.map(({ document, issuer }) => (
            <li key={document.documentId}>
              {document.number} ·{" "}
              {document.type === "other"
                ? document.typeOtherLabel
                : t(`receivingRef.types.${document.type}`)}{" "}
              · {document.issuedOn} · {issuer?.legalName ?? issuer?.name}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("receiving.noDocuments")}</p>
      )}
    </section>
  );
}
