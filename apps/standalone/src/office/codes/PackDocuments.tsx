import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { OfficePackDocument } from "../../host/pack-cards.js";

/**
 * The applied disaggregation documents that took a box or a pallet apart
 * (plan КРТ, task 8): the document's number links to its page (plan ДЗГ-О),
 * under it when it was applied, the reason and who applied it. The cards show
 * the section only when a document did take the box or the pallet apart.
 */
export function PackDocuments({
  documents,
  at,
}: {
  documents: readonly OfficePackDocument[];
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  if (documents.length === 0) return null;
  return (
    <section className="shift-card__section" aria-labelledby="pack-documents">
      <h2 id="pack-documents">{t("office.packs.documents.title")}</h2>
      <ol className="shift-card__section">
        {documents.map((document) => (
          <li key={document.id} className="shift-cell">
            <Link
              to={`/disaggregation/${document.id}`}
              aria-label={t("office.packs.documents.open", { docNo: document.docNo })}
            >
              {document.docNo}
            </Link>
            <span className="shift-cell__quiet">
              {[
                t("office.packs.documents.appliedAt", { at: at(document.appliedAt) }),
                document.reasonName,
                document.appliedByName,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
