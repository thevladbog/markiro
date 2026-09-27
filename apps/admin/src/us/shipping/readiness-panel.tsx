import type { ShippingDraftRecord, ShippingReadiness } from "@markiro/platform-contracts";
import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";

const fieldKeys = {
  eventDate: "date",
  timeZone: "timeZone",
  shipFromLocationId: "shipFrom",
  recipientLocationId: "recipient",
  documentIds: "documents",
  items: "items",
  lotId: "lot",
  quantity: "quantity",
  unitOfMeasure: "unit",
  tlc: "tlc",
  source: "source",
  productId: "product",
  coverage: "coverage",
  origin: "origin",
} as const;

const fixKeys = {
  required: "required",
  format: "format",
  unavailable: "unavailable",
  inactive: "inactive",
  wrong_role: "wrongRole",
  same_location: "sameLocation",
  duplicate: "duplicate",
  status_blocked: "statusBlocked",
  source_unresolved: "sourceUnresolved",
  coverage_unresolved: "coverageUnresolved",
  origin_missing: "originMissing",
  balance_unknown: "balanceUnknown",
  balance_exhausted: "balanceExhausted",
  uom_mismatch: "uomMismatch",
  over_shipment: "overShipment",
} as const;

function knownKey<T extends object>(map: T, value: string): keyof T | null {
  return Object.prototype.hasOwnProperty.call(map, value) ? (value as keyof T) : null;
}

function issueMessage(
  issue: ShippingReadiness["issues"][number],
  t: ReturnType<typeof useTranslation>["t"],
) {
  const item = /^items\[(\d+)\]\.([A-Za-z]+)$/.exec(issue.path);
  const field = item?.[2] ?? issue.path;
  const fieldKey = knownKey(fieldKeys, field);
  const incompleteDescriptionKey =
    issue.path === "shipFromLocationId"
      ? "incompleteShipFrom"
      : issue.path === "recipientLocationId"
        ? "incompleteRecipient"
        : issue.path === "documentIds"
          ? "incompleteDocument"
          : item?.[2] === "productId"
            ? "incompleteProduct"
            : "fallback";
  const codeKey = knownKey(fixKeys, issue.code);
  const fixKey =
    issue.code === "incomplete_description"
      ? incompleteDescriptionKey
      : codeKey
        ? fixKeys[codeKey]
        : "fallback";
  const line = issue.line ?? (item ? Number(item[1]) + 1 : null);
  const context =
    line && Number.isSafeInteger(line) && line > 0
      ? `${t("shipping.line", { number: line })} · `
      : "";
  return `${context}${t(`shipping.issueField.${fieldKey ? fieldKeys[fieldKey] : "record"}`)} — ${t(
    `shipping.issueFix.${fixKey}`,
  )}`;
}

export function ShippingReadinessPanel({
  record,
  dirty,
  pending,
  readiness,
  issues,
  onCheck,
}: {
  record: ShippingDraftRecord | null;
  dirty: boolean;
  pending: boolean;
  readiness: ShippingReadiness | null;
  issues: ShippingReadiness["issues"];
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const current =
    record !== null &&
    !dirty &&
    readiness?.eventId === record.id &&
    readiness.expectedDraftVersion === record.draftVersion;
  return (
    <section className="us-sh-section" aria-labelledby="us-sh-readiness">
      <div className="us-sh-section__heading">
        <h2 id="us-sh-readiness">{t("shipping.readiness")}</h2>
        <Button
          type="button"
          variant="secondary"
          disabled={!record || dirty || pending}
          onClick={onCheck}
        >
          {t("shipping.check")}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {!record ? (
          <p>{t("shipping.saveFirst")}</p>
        ) : dirty ? (
          <p>{t("shipping.saveChanges")}</p>
        ) : null}
        {current ? (
          <p>{t(readiness.state === "complete" ? "shipping.complete" : "shipping.incomplete")}</p>
        ) : null}
      </div>
      {issues.length ? (
        <div className="us-sh-blockers" role="alert" aria-label={t("shipping.blockers")}>
          <h3>{t("shipping.blockers")}</h3>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.path}/${issue.code}/${index}`}>{issueMessage(issue, t)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
