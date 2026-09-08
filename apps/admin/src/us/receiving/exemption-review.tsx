import { Checkbox } from "@markiro/ui";
import type { ReceivingDraftView } from "./live-record.js";
import { useTranslation } from "react-i18next";

export type ReceivingExemptionLabels = {
  products: ReadonlyMap<string, string>;
  locations: ReadonlyMap<string, string>;
};

export function ReceivingExemptionReview({
  record,
  requiredLines,
  reviewedLines,
  disabled,
  onChange,
  labels,
}: {
  record: ReceivingDraftView;
  requiredLines: number[];
  reviewedLines: number[];
  disabled: boolean;
  onChange: (lines: number[]) => void;
  labels: ReceivingExemptionLabels;
}) {
  const { t } = useTranslation();
  const required = new Set(requiredLines);
  const reviewed = new Set(reviewedLines);
  const previousSource = record.content.draft.previousSourceLocationId;

  return (
    <section className="us-rec-exemption-review" aria-labelledby="receiving-exemption-review">
      <h3 id="receiving-exemption-review">{t("receiving.reviewTitle")}</h3>
      <p className="us-rec-hint">{t("receiving.reviewIntro")}</p>
      <ol>
        {record.content.draft.items.flatMap((item, index) => {
          const line = index + 1;
          if (!item.exemptSupplier || !required.has(line)) return [];
          const receipt = item.exemptReceipt;
          const retained = "previousLineNo" in item && item.previousLineNo !== null;
          return [
            <li key={line} className="us-rec-review-line">
              <h4>
                {t("receiving.line", { number: line })} ·{" "}
                {item.productId ? (labels.products.get(item.productId) ?? item.productId) : "—"}
              </h4>
              <dl>
                <dt>{t("receiving.product")}</dt>
                <dd>
                  {item.productId ? (labels.products.get(item.productId) ?? item.productId) : "—"}
                </dd>
                <dt>{t("receiving.previousSource")}</dt>
                <dd>
                  {previousSource
                    ? (labels.locations.get(previousSource) ?? previousSource)
                    : t("receiving.absent")}
                </dd>
                <dt>{t("receiving.exemptReason")}</dt>
                <dd>{item.exemptReason ?? "—"}</dd>
                <dt>{t("receiving.evidenceUrl")}</dt>
                <dd>
                  {receipt?.evidenceUrl ? (
                    <a href={receipt.evidenceUrl} target="_blank" rel="noopener noreferrer">
                      {receipt.evidenceUrl}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>{t("receiving.receivedTlc")}</dt>
                <dd>{item.tlc ?? t("receiving.absent")}</dd>
                {!retained || receipt?.tlcHandling === "assign_if_missing" ? (
                  <>
                    <dt>
                      {t(retained ? "receiving.previouslyAssignedTlc" : "receiving.proposedTlc")}
                    </dt>
                    <dd>{receipt?.proposedTlc ?? t("receiving.absent")}</dd>
                  </>
                ) : null}
                <dt>{t("receiving.sourceKind")}</dt>
                <dd>
                  {item.source
                    ? t(
                        item.source.kind === "location"
                          ? "receiving.locationKind"
                          : "receiving.referenceKind",
                      )
                    : t("receiving.absent")}
                </dd>
                {item.source?.kind === "reference" ? (
                  <>
                    <dt>{t("receiving.sourceReference")}</dt>
                    <dd>
                      <a
                        href={item.source.referenceValue}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.source.referenceValue}
                      </a>
                    </dd>
                    <dt>{t("receiving.resolvedLocation")}</dt>
                    <dd>
                      {labels.locations.get(item.source.resolvedLocationId) ??
                        item.source.resolvedLocationId}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>{t("receiving.sourceLocation")}</dt>
                    <dd>
                      {item.source?.locationId
                        ? (labels.locations.get(item.source.locationId) ?? item.source.locationId)
                        : t("receiving.absent")}
                    </dd>
                  </>
                )}
              </dl>
              <Checkbox
                label={t("receiving.reviewLine", { number: line })}
                checked={reviewed.has(line)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...new Set([...reviewedLines, line])].sort((a, b) => a - b)
                      : reviewedLines.filter((candidate) => candidate !== line),
                  )
                }
              />
            </li>,
          ];
        })}
      </ol>
    </section>
  );
}
