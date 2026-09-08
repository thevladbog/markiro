import type { ReceivingLifecycleError } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

/** Supplemental context only; the owning workflow keeps its existing recovery guards. */
export function ReceivingConflictDetails({ detail }: { detail: ReceivingLifecycleError | null }) {
  const { t } = useTranslation();
  if (!detail) return null;
  if (detail.code === "receiving_pending_amendment") return <p>{t("receivingConflict.pending")}</p>;
  if (detail.code === "receiving_lifecycle_conflict")
    return (
      <>
        <p>{t("receivingConflict.lifecycle")}</p>
        {detail.pendingDraftId ? <p>{t("receivingConflict.pending")}</p> : null}
      </>
    );
  if (detail.code === "lot_identity_locked")
    return (
      <>
        <p>{t("receivingConflict.identity")}</p>
        <ul>
          {detail.lines.map((line) => (
            <li key={line.lineNo}>
              {t("receiving.line", { number: line.lineNo })}:{" "}
              {line.fields.map((field) => t(`receivingConflict.fields.${field}`)).join(", ")}
            </li>
          ))}
        </ul>
      </>
    );
  return null;
}
