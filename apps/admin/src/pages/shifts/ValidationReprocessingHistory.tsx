import { Alert, Button, Spinner } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { formatDate, formatScanTime } from "../../lib/datetime.js";
import type { ShiftsPanelLocationState } from "./ShiftPanelRoute.js";
import { useValidationReprocessings } from "./validation-reprocessing-api.js";

export function ValidationReprocessingHistory({ shiftId }: { shiftId: string }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const history = useValidationReprocessings(shiftId);
  const rows = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section
      className="mk-shift-details__section"
      aria-label={t("pages.shifts.reprocessing.title")}
    >
      <h3>{t("pages.shifts.reprocessing.title")}</h3>
      <p className="mk-shift-details__empty">{t("pages.shifts.reprocessing.hint")}</p>
      {history.isPending ? <Spinner label={t("common.loading")} /> : null}
      {history.isError ? (
        <Alert tone="error">
          <p>{t("pages.shifts.reprocessing.loadError")}</p>
          <Button variant="secondary" onClick={() => void history.refetch()}>
            {t("pages.shifts.form.retry")}
          </Button>
        </Alert>
      ) : null}
      {history.isSuccess && rows.length === 0 ? (
        <p className="mk-shift-details__empty">{t("pages.shifts.reprocessing.empty")}</p>
      ) : null}
      <div className="mk-validation-reprocessings">
        {rows.map((row) => (
          <article className="mk-validation-reprocessings__item" key={row.codeHash}>
            <code className="mk-validation-reprocessings__code">
              {row.canonicalRaw || t("pages.shifts.reprocessing.missingCode")}
            </code>
            <div>
              {t("pages.shifts.reprocessing.source")}
              {": "}
              {row.sourceShift.number ? (
                <Link
                  to={`/shifts/${encodeURIComponent(row.sourceShift.id)}`}
                  state={
                    (location.state as ShiftsPanelLocationState | null) ?? {
                      shiftsBackground: true,
                    }
                  }
                >
                  {row.sourceShift.number}
                </Link>
              ) : (
                t("pages.shifts.reprocessing.missingSource")
              )}
            </div>
            <p>{row.sourceShift.productName || t("pages.shifts.reprocessing.missingProduct")}</p>
            <p>
              {row.sourceShift.date
                ? formatDate(row.sourceShift.date, i18n.language)
                : t("pages.shifts.reprocessing.missingDate")}
            </p>
            <time dateTime={row.occurrence.scannedAt}>
              {t("pages.shifts.reprocessing.processedAt", {
                date: formatScanTime(row.occurrence.scannedAt, i18n.language),
              })}
            </time>
          </article>
        ))}
      </div>
      {history.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {t("pages.shifts.productLabels.more")}
        </Button>
      ) : null}
    </section>
  );
}
