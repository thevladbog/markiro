import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Spinner } from "@markiro/ui";
import type { ProductLabelHistoryRow } from "@markiro/domain";
import { useOperators } from "../employees/station-access-api.js";
import { formatScanTime } from "../../lib/datetime.js";
import { useProductLabelEvents, useProductLabelHistory } from "./product-labels-api.js";

function Events({ shiftId, job }: { shiftId: string; job: ProductLabelHistoryRow }) {
  const { t, i18n } = useTranslation();
  const events = useProductLabelEvents(shiftId, job);
  const operators = useOperators();
  const names = new Map(
    operators.data?.map((operator) => [operator.employeeId, operator.fullName]),
  );
  if (events.isPending) return <Spinner label={t("common.loading")} />;
  if (events.isError)
    return (
      <Alert tone="error">
        <p>{t("pages.shifts.productLabels.readError")}</p>
        <Button variant="secondary" onClick={() => void events.refetch()}>
          {t("pages.shifts.productLabels.retry")}
        </Button>
      </Alert>
    );
  return (
    <>
      <ol className="mk-product-label-history__events">
        {events.data.pages
          .flatMap((page) => page.items)
          .map((event) => (
            <li key={event.eventId}>
              <div>
                <time dateTime={event.occurredAt}>
                  {formatScanTime(event.occurredAt, i18n.language)}
                </time>
                <span>{names.get(event.operatorId) ?? `…${event.operatorId.slice(-8)}`}</span>
              </div>
              <div>
                <strong>{t(`pages.shifts.productLabels.events.${event.kind}`)}</strong>
                {event.kind === "prepared" ? (
                  <span>
                    {t(
                      event.reason
                        ? `pages.shifts.productLabels.reasons.${event.reason}`
                        : "pages.shifts.productLabels.original",
                    )}
                  </span>
                ) : event.kind === "verification_rejected" ? (
                  <span>{t(`pages.shifts.productLabels.rejected.${event.reason}`)}</span>
                ) : null}
              </div>
            </li>
          ))}
      </ol>
      {events.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          {t("pages.shifts.productLabels.more")}
        </Button>
      ) : null}
    </>
  );
}
export function ProductLabelHistory({ shiftId }: { shiftId: string }) {
  const { t, i18n } = useTranslation();
  const history = useProductLabelHistory(shiftId);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (history.isPending)
    return (
      <section className="mk-shift-details__section">
        <h3>{t("pages.shifts.productLabels.title")}</h3>
        <Spinner label={t("common.loading")} />
      </section>
    );
  if (history.isError)
    return (
      <section className="mk-shift-details__section">
        <Alert tone="error">
          <p>{t("pages.shifts.productLabels.readError")}</p>
          <Button variant="secondary" onClick={() => void history.refetch()}>
            {t("pages.shifts.productLabels.retry")}
          </Button>
        </Alert>
      </section>
    );
  const summary = history.data.pages[0]?.summary;
  const rows = history.data.pages.flatMap((page) => page.items);
  return (
    <section className="mk-shift-details__section">
      <h3>{t("pages.shifts.productLabels.title")}</h3>
      <p className="mk-shift-details__empty">{t("pages.shifts.productLabels.hint")}</p>
      {summary ? (
        <div className="mk-shift-details__metrics">
          {(["sentAttempts", "verifiedAttempts", "unresolvedJobs", "reprintAttempts"] as const).map(
            (key) => (
              <div className="mk-shift-details__metric" key={key}>
                <strong>{summary[key].toLocaleString(i18n.language)}</strong>
                <span>{t(`pages.shifts.productLabels.${key}`)}</span>
              </div>
            ),
          )}
        </div>
      ) : null}
      {!rows.length ? (
        <p className="mk-shift-details__empty">{t("pages.shifts.productLabels.empty")}</p>
      ) : null}
      <div className="mk-product-label-history">
        {rows.map((job) => {
          const key = JSON.stringify([shiftId, job.deviceId, job.jobId]);
          const open = expanded === key;
          const status =
            job.verificationOutcome === "verified"
              ? "verified"
              : job.status === "completed"
                ? "sent"
                : job.status;
          return (
            <article className="mk-product-label-history__job" key={key}>
              <header>
                <code>…{job.codeSuffix || "—"}</code>
                <Badge
                  tone={status === "verified" ? "ok" : status === "attention" ? "warn" : "neutral"}
                >
                  {t(`pages.shifts.productLabels.states.${status}`)}
                </Badge>
              </header>
              <time dateTime={job.acceptedAt}>{formatScanTime(job.acceptedAt, i18n.language)}</time>
              {job.ownershipConflict ? (
                <Alert tone="warn" title={t("pages.shifts.productLabels.ownershipConflict")} />
              ) : null}
              <Button
                variant="secondary"
                aria-expanded={open}
                aria-label={`${t("pages.shifts.productLabels.attemptHistory")} · …${job.codeSuffix}`}
                onClick={() => setExpanded(open ? null : key)}
              >
                {t("pages.shifts.productLabels.attempts", { count: job.attemptNo })}
              </Button>
              {open ? <Events shiftId={shiftId} job={job} /> : null}
            </article>
          );
        })}
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
