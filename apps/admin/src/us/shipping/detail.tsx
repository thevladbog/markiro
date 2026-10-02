import type {
  ShippingFinalizationSnapshotV1,
  ShippingHistoricalRecord,
} from "@markiro/platform-contracts";
import { StatusChip } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { UsBrowserClient } from "../client.js";
import { ShippingBalanceRead } from "./balance-read.js";

function civilDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}
function instant(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return `${part("month")}/${part("day")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

type FrozenLocation = ShippingFinalizationSnapshotV1["shipFrom"];
function FrozenLocationDescription({ title, value }: { title: string; value: FrozenLocation }) {
  const { t } = useTranslation();
  return (
    <section className="us-sh-frozen" aria-label={title}>
      <h3>{title}</h3>
      <dl className="us-sh-facts">
        <Fact label={t("shipping.businessName")} value={value.businessName} />
        <Fact label={t("shipping.phoneNumber")} value={value.phoneNumber} />
        <Fact
          label={t(
            value.address.kind === "street" ? "shipping.streetAddress" : "shipping.coordinates",
          )}
          value={
            value.address.kind === "street"
              ? value.address.streetAddress
              : `${value.address.latitude}, ${value.address.longitude}`
          }
        />
        <Fact label={t("shipping.city")} value={value.city} />
        <Fact label={t("shipping.stateOrRegion")} value={value.stateOrRegion} />
        <Fact label={t("shipping.zipOrPostalCode")} value={value.zipOrPostalCode} />
        <Fact label={t("shipping.country")} value={value.countryDisplay} />
        <Fact label={t("shipping.countryCode")} value={value.countryCode} />
        <Fact label={t("shipping.locationId")} value={value.locationId} />
        <Fact label={t("shipping.partyId")} value={value.partyId} />
      </dl>
    </section>
  );
}

/** Current balance values are rendered only when supplied by an authoritative server read. */
export function ShippingQuantityStrip({
  quantity,
  unit,
  balance,
}: {
  quantity: string;
  unit: string;
  balance?: { before: string; remaining: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="us-sh-quantity-strip">
      {balance ? (
        <span className="us-sh-quantity-strip__side">
          {balance.before} {unit}
        </span>
      ) : null}
      <strong className="us-sh-quantity-strip__focal">
        {quantity} {unit}
      </strong>
      {balance ? (
        <span className="us-sh-quantity-strip__side">
          {balance.remaining} {unit}
        </span>
      ) : null}
      {!balance ? <small>{t("shipping.balanceAwaiting")}</small> : null}
    </div>
  );
}

export function ShippingDetail({
  record,
  client,
  onForbidden,
  onSessionLost,
}: {
  record: ShippingHistoricalRecord;
  client: UsBrowserClient;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
}) {
  const { t } = useTranslation();
  const frozen = "snapshot" in record ? record.snapshot : null;
  const saved = "draft" in record ? record.draft : null;
  const lifecycle = record.lifecycle;
  return (
    <article className="us-sh-detail" aria-label={t("shipping.detail")}>
      <div className="us-sh-detail__state">
        <StatusChip
          status={
            record.status === "finalized"
              ? "ok"
              : record.status === "void"
                ? "error"
                : record.status === "amended"
                  ? "info"
                  : "neutral"
          }
          label={t(`events.${record.status}`)}
        />
        <span>{t("shipping.revision", { number: record.revision })}</span>
        {lifecycle?.currentEventId === record.id ? <strong>{t("shipping.current")}</strong> : null}
        {lifecycle?.pendingDraftId === record.id ? <strong>{t("shipping.pending")}</strong> : null}
      </div>
      {record.status === "void" ? (
        <p role="status" className="us-sh-excluded">
          {t("shipping.excluded")}
        </p>
      ) : null}
      <section className="us-sh-section" aria-label={t("shipping.detail")}>
        <dl className="us-sh-facts">
          <div>
            <dt>{t("shipping.date")}</dt>
            <dd>
              {frozen?.eventDate
                ? civilDate(frozen.eventDate)
                : saved?.eventDate
                  ? civilDate(saved.eventDate)
                  : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("events.timeZone")}</dt>
            <dd className="us-sh-mono">{frozen?.timeZone ?? record.timeZone}</dd>
          </div>
          <div>
            <dt>{t("shipping.shipFrom")}</dt>
            <dd>{frozen?.shipFrom.businessName ?? saved?.shipFromLocationId ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("shipping.recipient")}</dt>
            <dd>{frozen?.recipient.businessName ?? saved?.recipientLocationId ?? "—"}</dd>
          </div>
          {frozen?.carrierReference || saved?.carrierReference ? (
            <div>
              <dt>{t("shipping.carrier")}</dt>
              <dd>{frozen?.carrierReference ?? saved?.carrierReference}</dd>
            </div>
          ) : null}
          {frozen?.notes || saved?.notes ? (
            <div>
              <dt>{t("shipping.notes")}</dt>
              <dd>{frozen?.notes ?? saved?.notes}</dd>
            </div>
          ) : null}
        </dl>
        {frozen ? (
          <div className="us-sh-frozen-grid">
            <FrozenLocationDescription
              title={t("shipping.shipFromDescription")}
              value={frozen.shipFrom}
            />
            <FrozenLocationDescription
              title={t("shipping.recipientDescription")}
              value={frozen.recipient}
            />
          </div>
        ) : null}
      </section>
      <section className="us-sh-section" aria-label={t("shipping.lines")}>
        <h2>{t("shipping.lines")}</h2>
        {frozen ? (
          <ol className="us-sh-lines">
            {frozen.items.map((line) => (
              <li key={line.lineNo} tabIndex={-1} data-readiness-line={`items:${line.lineNo}`}>
                <div className="us-sh-line-identity">
                  <strong className="us-sh-mono">{line.tlc}</strong>
                  <span>{line.product.description.productName}</span>
                  <span>
                    {line.source.kind === "location"
                      ? line.source.location.businessName
                      : line.source.resolvedLocation.businessName}
                  </span>
                </div>
                <ShippingQuantityStrip quantity={line.quantity} unit={line.unitOfMeasure} />
                <ShippingBalanceRead
                  client={client}
                  lotId={line.lotId}
                  quantity={line.quantity}
                  unit={line.unitOfMeasure}
                  historical
                  onForbidden={onForbidden}
                  onSessionLost={onSessionLost}
                />
                <div className="us-sh-frozen-grid">
                  <section className="us-sh-frozen" aria-label={t("shipping.productDescription")}>
                    <h3>{t("shipping.productDescription")}</h3>
                    <dl className="us-sh-facts">
                      <Fact
                        label={t("shipping.productId")}
                        value={line.product.description.sourceProductId}
                      />
                      <Fact
                        label={t("shipping.productDescription")}
                        value={line.product.description.productName}
                      />
                      <Fact
                        label={t("shipping.brand")}
                        value={line.product.description.brandName}
                      />
                      <Fact
                        label={t("shipping.commodity")}
                        value={line.product.description.commodity}
                      />
                      <Fact
                        label={t("shipping.variety")}
                        value={line.product.description.variety}
                      />
                      <Fact
                        label={t("shipping.packagingSize")}
                        value={
                          line.product.description.packagingSize
                            ? `${line.product.description.packagingSize.value} ${line.product.description.packagingSize.uom}`
                            : null
                        }
                      />
                      <Fact
                        label={t("shipping.packagingStyle")}
                        value={line.product.description.packagingStyle}
                      />
                      <Fact label={t("shipping.gtin")} value={line.product.description.gtin} />
                    </dl>
                  </section>
                  <div>
                    <section className="us-sh-frozen" aria-label={t("shipping.sourceDescription")}>
                      <h3>{t("shipping.sourceDescription")}</h3>
                      <dl className="us-sh-facts">
                        <Fact
                          label={t("shipping.sourceKind")}
                          value={t(
                            line.source.kind === "reference"
                              ? "shipping.sourceWebUrl"
                              : "shipping.sourceLocation",
                          )}
                        />
                        {line.source.kind === "reference" ? (
                          <Fact
                            label={t("shipping.sourceReference")}
                            value={line.source.referenceValue}
                          />
                        ) : null}
                      </dl>
                    </section>
                    <FrozenLocationDescription
                      title={t("shipping.resolvedLocation")}
                      value={
                        line.source.kind === "reference"
                          ? line.source.resolvedLocation
                          : line.source.location
                      }
                    />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            {saved?.items.length ?? 0} {t("shipping.lines").toLowerCase()}
          </p>
        )}
        <p className="us-sh-hint">{t("shipping.quantityNote")}</p>
      </section>
      <section className="us-sh-section" aria-label={t("shipping.documents")}>
        <h2>{t("shipping.documents")}</h2>
        <ul className="us-sh-documents">
          {frozen?.documents.map((document) => (
            <li key={document.id}>
              <span>{document.type}</span>
              <strong className="us-sh-mono">{document.number}</strong>
              <dl className="us-sh-facts">
                <Fact label={t("shipping.issuer")} value={document.issuer?.name ?? null} />
                <Fact
                  label={t("shipping.issuerLegalName")}
                  value={document.issuer?.legalName ?? null}
                />
              </dl>
            </li>
          ))}
        </ul>
      </section>
      <section className="us-sh-section" aria-label={t("shipping.audit")}>
        <h2>{t("shipping.audit")}</h2>
        <dl className="us-sh-facts">
          <div>
            <dt>{t("shipping.revision", { number: record.revision })}</dt>
            <dd className="us-sh-mono">{record.id}</dd>
          </div>
          {frozen ? (
            <div>
              <dt>{t("shipping.finalizedBy")}</dt>
              <dd>
                {frozen.finalizedBy} · {instant(frozen.finalizedAt, frozen.timeZone)}
              </dd>
            </div>
          ) : null}
          {lifecycle?.amendmentReason ? (
            <div>
              <dt>{t("shipping.amendedReason")}</dt>
              <dd>{lifecycle.amendmentReason}</dd>
            </div>
          ) : null}
          {lifecycle?.voidReason ? (
            <div>
              <dt>{t("shipping.voidReason")}</dt>
              <dd>{lifecycle.voidReason}</dd>
            </div>
          ) : null}
          {lifecycle?.previousRevisionId ? (
            <div>
              <dt>{t("shipping.previous")}</dt>
              <dd className="us-sh-mono">{lifecycle.previousRevisionId}</dd>
            </div>
          ) : null}
          {lifecycle?.supersededByEventId ? (
            <div>
              <dt>{t("shipping.successor")}</dt>
              <dd className="us-sh-mono">{lifecycle.supersededByEventId}</dd>
            </div>
          ) : null}
        </dl>
      </section>
    </article>
  );
}
