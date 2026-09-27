import { RECEIVING_CSV_COLUMNS } from "@markiro/domain";
import type { ReceivingCsvPreview } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

const headerFields = [
  ["dateReceived", "date"],
  ["locationId", "location"],
  ["previousSourceLocationId", "previousSource"],
  ["receivedAtNote", "receivedAtNote"],
  ["notes", "notes"],
  ["documentIds", "documents"],
] as const;

export function ReceivingCsvPreviewDetails({ preview }: { preview: ReceivingCsvPreview }) {
  const { t } = useTranslation();
  return (
    <>
      <section className="us-rec-section">
        <h2>{t("receivingCsv.normalized")}</h2>
        <dl className="us-rec-csv-values">
          {headerFields.map(([key, label]) => {
            const value = preview.header[key];
            return (
              <div key={key}>
                <dt>{t(`receiving.${label}`)}</dt>
                <dd>
                  {Array.isArray(value)
                    ? value.join(" · ") || t("receivingCsv.empty")
                    : (value ?? t("receivingCsv.empty"))}
                </dd>
              </div>
            );
          })}
        </dl>
        {preview.resolution.headerIssues.map((issue, index) => (
          <p key={index} role="alert">
            {t("receivingCsv.problem", {
              column: `${issue.field}${issue.documentIndex === null ? "" : ` #${issue.documentIndex + 1}`}`,
              reason: t(`receivingCsv.errors.${issue.code}`),
            })}
          </p>
        ))}
      </section>
      {preview.fileError ? (
        <p role="alert">
          {t(`receivingCsv.errors.${preview.fileError.code}`)} · {preview.fileError.lineNumber}
        </p>
      ) : null}
      <section className="us-rec-section">
        <h2>{t("receivingCsv.count", { count: preview.rowCount })}</h2>
        <p>{t("receivingCsv.correct")}</p>
        <div className="us-rec-stack">
          {preview.rows.map((row, index) => {
            const references = preview.resolution.rows[index]?.issues ?? [];
            return (
              <details
                className="us-rec-csv-row"
                key={row.rowNumber}
                open={row.issues.length + references.length > 0 ? true : undefined}
              >
                <summary>
                  <strong>
                    {t("receivingCsv.row", { row: row.rowNumber, line: row.lineNumber })}
                  </strong>
                  <span>
                    {row.issues.length + references.length
                      ? t("receivingCsv.blocked")
                      : t("receivingCsv.none")}
                  </span>
                </summary>
                <ul>
                  {[...row.issues, ...references].map((issue, number) => (
                    <li key={number}>
                      {t("receivingCsv.problem", {
                        column: issue.column ?? "CSV",
                        reason: t(`receivingCsv.errors.${issue.code}`),
                      })}
                    </li>
                  ))}
                </ul>
                {row.normalizations.length ? (
                  <>
                    <h3>{t("receivingCsv.normalizations")}</h3>
                    <ul>
                      {row.normalizations.map((change) => (
                        <li key={change.column}>
                          <code>{change.column}</code>:{" "}
                          <span className="us-rec-csv-literal">
                            {t("receivingCsv.changed", {
                              before: change.before,
                              after: change.after,
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h3>{t("receivingCsv.raw")}</h3>
                {row.cells.length > RECEIVING_CSV_COLUMNS.length ? (
                  <p>
                    {t("receivingCsv.limitedCells", {
                      shown: RECEIVING_CSV_COLUMNS.length,
                      total: row.cells.length,
                    })}
                  </p>
                ) : null}
                <dl className="us-rec-csv-values">
                  {row.cells.slice(0, RECEIVING_CSV_COLUMNS.length).map((cell, cellIndex) => (
                    <div key={cellIndex}>
                      <dt>
                        <code>{RECEIVING_CSV_COLUMNS[cellIndex]}</code>
                      </dt>
                      <dd>{cell || t("receivingCsv.empty")}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            );
          })}
        </div>
      </section>
    </>
  );
}
