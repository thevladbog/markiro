import { useEffect, useRef } from "react";
import { Button, StatusChip } from "@markiro/ui";
import type { ReceivingFinalizationSnapshot } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { receivingQuantityTotals } from "./quantity-totals.js";
import type { ReceivingFrozenView } from "./live-record.js";
import { ReceivingLifecycleNotice } from "./lifecycle-notice.js";

function locationText(location: ReceivingFinalizationSnapshot["locationDescription"]) {
  const address =
    location.address.kind === "street"
      ? location.address.streetAddress
      : `${location.address.latitude}, ${location.address.longitude}`;
  return `${location.businessName} · ${address} · ${location.city}, ${location.stateOrRegion} ${location.zipOrPostalCode} · ${location.countryDisplay} · ${location.phoneNumber}`;
}
export function ReceivingFinalizedDetail({
  record,
  onClose,
  onOpenLot,
}: {
  record: ReceivingFrozenView;
  onClose: () => void;
  onOpenLot: (id: string, record: ReceivingFrozenView) => void;
}) {
  const { t, i18n } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [record.id]);
  const snapshot = record.content.snapshot;
  return (
    <div className="us-rec-page us-rec-frozen">
      <Button type="button" variant="secondary" onClick={onClose}>
        {t("receiving.back")}
      </Button>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {record.eventNumber}
          </h1>
          <p>{t("receiving.frozenHint")}</p>
        </div>
        <StatusChip
          status={record.status === "finalized" ? "ok" : "neutral"}
          label={t(`receiving.${record.status}`)}
        />
      </header>
      <ReceivingLifecycleNotice record={record} />
      <section className="us-rec-section">
        <h2>{t("receiving.header")}</h2>
        <dl>
          <dt>{t("receiving.date")}</dt>
          <dd>
            {snapshot.dateReceived} · {record.timeZone}
          </dd>
          <dt>{t("receiving.finalizedBy")}</dt>
          <dd>{record.content.finalizedBy}</dd>
          <dt>{t("receiving.finalizedAt")}</dt>
          <dd>
            {new Intl.DateTimeFormat(i18n.language, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: record.timeZone,
            }).format(new Date(record.content.finalizedAt))}{" "}
            · {record.timeZone}
          </dd>
          <dt>{t("receiving.location")}</dt>
          <dd>{locationText(snapshot.locationDescription)}</dd>
          <dt>{t("receiving.previousSource")}</dt>
          <dd>{locationText(snapshot.previousSourceDescription)}</dd>
          {snapshot.receivedAtNote ? (
            <>
              <dt>{t("receiving.receivedAtNote")}</dt>
              <dd>{snapshot.receivedAtNote}</dd>
            </>
          ) : null}
          {snapshot.notes ? (
            <>
              <dt>{t("receiving.notes")}</dt>
              <dd>{snapshot.notes}</dd>
            </>
          ) : null}
        </dl>
      </section>
      <section className="us-rec-section">
        <h2>{t("receiving.totals")}</h2>
        <ul>
          {receivingQuantityTotals(snapshot.items).map((total) => (
            <li key={total.unit}>
              {total.quantity} {total.unit}
            </li>
          ))}
        </ul>
      </section>
      <section className="us-rec-section">
        <h2>{t("receiving.lines")}</h2>
        <ol className="us-rec-history-lines">
          {snapshot.items.map((item, index) => {
            const receiptBasis =
              snapshot.snapshotVersion !== 1 ? snapshot.items[index]?.receiptBasis : null;
            return (
              <li key={item.lineNo} className="us-rec-section">
                <h3>
                  {t("receiving.line", { number: item.lineNo })} ·{" "}
                  {item.productDescription.productName}
                </h3>
                <dl>
                  <dt>{t("receiving.product")}</dt>
                  <dd>{item.productDescription.productName}</dd>
                  <dt>{t("receiving.tlc")}</dt>
                  <dd>{item.tlc}</dd>
                  <dt>{t("receiving.quantity")}</dt>
                  <dd>
                    {item.quantity} {item.unitOfMeasure}
                  </dd>
                  <dt>{t("receiving.sourceLocation")}</dt>
                  <dd>{locationText(item.sourceDescription)}</dd>
                  {item.source.kind === "reference" ? (
                    <>
                      <dt>{t("receiving.sourceReference")}</dt>
                      <dd>{item.source.referenceValue}</dd>
                    </>
                  ) : null}
                  <dt>{t("receiving.linkMode")}</dt>
                  <dd>
                    {t(
                      "lotBinding" in item && item.lotBinding.kind === "retained"
                        ? "receiving.retainedLot"
                        : item.lotLinkMode === "create_on_finalize"
                          ? "receiving.createdLot"
                          : "receiving.linkedLot",
                    )}
                  </dd>
                  {item.supplierLotReference ? (
                    <>
                      <dt>{t("receiving.supplierLot")}</dt>
                      <dd>{item.supplierLotReference}</dd>
                    </>
                  ) : null}
                  {receiptBasis && receiptBasis.kind !== "ordinary" ? (
                    <>
                      <dt>{t("receiving.receiptBasis")}</dt>
                      <dd>
                        {t(
                          receiptBasis.kind === "exempt_existing_tlc"
                            ? "receiving.existingBasis"
                            : "receiving.assignedBasis",
                        )}
                      </dd>
                      <dt>{t("receiving.exemptReason")}</dt>
                      <dd>{receiptBasis.reason}</dd>
                      <dt>{t("receiving.evidenceUrl")}</dt>
                      <dd>
                        <a
                          href={receiptBasis.evidenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {receiptBasis.evidenceUrl}
                        </a>
                      </dd>
                      <dt>{t("receiving.reviewedBy")}</dt>
                      <dd>{receiptBasis.reviewedBy}</dd>
                      <dt>{t("receiving.reviewedAt")}</dt>
                      <dd>
                        {new Intl.DateTimeFormat(i18n.language, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: record.timeZone,
                        }).format(new Date(receiptBasis.reviewedAt))}{" "}
                        · {record.timeZone}
                      </dd>
                      {receiptBasis.kind === "exempt_assigned_tlc" ? (
                        <>
                          <dt>{t("receiving.receivedTlc")}</dt>
                          <dd>{t("receiving.absent")}</dd>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {item.notes ? (
                    <>
                      <dt>{t("receiving.lineNotes")}</dt>
                      <dd>{item.notes}</dd>
                    </>
                  ) : null}
                </dl>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onOpenLot(item.lotId, record)}
                >
                  {t("receiving.openLot")}
                </Button>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="us-rec-section">
        <h2>{t("receiving.documents")}</h2>
        {snapshot.documents.length ? (
          <ul>
            {snapshot.documents.map(({ document, issuer }) => (
              <li key={document.documentId}>
                <strong>{document.number}</strong>
                <p>
                  {document.type === "other"
                    ? document.typeOtherLabel
                    : t(`receivingRef.types.${document.type}`)}{" "}
                  · {document.issuedOn} {issuer?.legalName ?? issuer?.name}
                </p>
                {document.notes ? <p>{document.notes}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("receiving.noDocuments")}</p>
        )}
      </section>
    </div>
  );
}
