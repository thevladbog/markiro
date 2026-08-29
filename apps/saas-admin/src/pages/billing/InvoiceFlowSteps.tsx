import { useTranslation } from "react-i18next";

type FlowState =
  "draft" | "waiting_payment" | "waiting_application" | "partial_failure" | "applied" | "cancelled";

export function InvoiceFlowSteps({ state }: { state: FlowState }) {
  const { t } = useTranslation();
  const issuedDone = state !== "draft";
  const paymentDone = state !== "draft" && state !== "waiting_payment" && state !== "cancelled";
  const applicationDone = state === "applied";
  const applicationFailed = state === "partial_failure";

  return (
    <ol className="invoice-flow" aria-label={t("billing.flow.label")}>
      <li data-state={issuedDone ? "done" : "current"}>
        <span className="invoice-flow__index" aria-hidden="true">
          01
        </span>
        <span>
          <strong>{t("billing.flow.issued")}</strong>
          <small>{t("billing.flow.issuedHint")}</small>
        </span>
      </li>
      <li
        data-state={paymentDone ? "done" : issuedDone && state !== "cancelled" ? "current" : "next"}
      >
        <span className="invoice-flow__index" aria-hidden="true">
          02
        </span>
        <span>
          <strong>{t("billing.flow.payment")}</strong>
          <small>{t("billing.flow.paymentHint")}</small>
        </span>
      </li>
      <li
        data-state={
          applicationDone ? "done" : applicationFailed ? "error" : paymentDone ? "current" : "next"
        }
      >
        <span className="invoice-flow__index" aria-hidden="true">
          03
        </span>
        <span>
          <strong>{t("billing.flow.application")}</strong>
          <small>{t("billing.flow.applicationHint")}</small>
        </span>
      </li>
    </ol>
  );
}

export type { FlowState };
