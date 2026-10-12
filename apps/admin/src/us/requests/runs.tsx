import { Button } from "@markiro/ui";
import type {
  UsRequestRunListResponse,
  UsRequestAttemptListResponse,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { getRequestCopy } from "./copy.js";
import { formatRequestInstant } from "./time.js";

export function RequestRuns(props: {
  page: UsRequestRunListResponse | null;
  pending: boolean;
  stale: boolean;
  disabled: boolean;
  timeZone: string;
  onPage: (offset: number) => void;
  onSelect: (id: string) => void;
}) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const page = props.page;
  return (
    <section aria-label={copy.runHistory}>
      <h3>{copy.runHistory}</h3>
      <Button
        disabled={props.pending || props.disabled}
        onClick={() => props.onPage(page?.offset ?? 0)}
      >
        {copy.loadRuns}
      </Button>
      {props.pending ? <p role="status">{copy.loadingRuns}</p> : null}
      {page ? (
        <>
          <ol>
            {page.items.map((run) => (
              <li key={run.runId}>
                <Button
                  disabled={props.pending || props.stale || props.disabled}
                  onClick={() => props.onSelect(run.runId)}
                >
                  {copy.openRun} {run.runId}
                </Button>
                <p>
                  {copy[run.status]}; {copy.revision}: {run.requestRevision}; {copy.runRevision}:{" "}
                  {run.runRevision};{" "}
                  {formatRequestInstant(
                    run.startedAt,
                    props.timeZone,
                    i18n.language === "es-US" ? "es-US" : "en-US",
                  )}
                </p>
              </li>
            ))}
          </ol>
          {!page.items.length ? <p>{copy.noRun}</p> : null}
          <Button
            disabled={props.pending || props.stale || props.disabled || page.offset === 0}
            onClick={() => props.onPage(Math.max(0, page.offset - 25))}
          >
            {copy.previousHistory}
          </Button>
          <Button
            disabled={
              props.pending ||
              props.stale ||
              props.disabled ||
              !page.hasMore ||
              page.offset + 25 > 10000
            }
            onClick={() => props.onPage(page.offset + 25)}
          >
            {copy.nextHistory}
          </Button>
        </>
      ) : null}
    </section>
  );
}
export function RequestAttempts(props: {
  page: UsRequestAttemptListResponse | null;
  pending: boolean;
  disabled: boolean;
  timeZone: string;
  onPage: (offset: number) => void;
}) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const page = props.page;
  return (
    <section aria-label={copy.attemptHistory}>
      <h4>{copy.attemptHistory}</h4>
      <Button
        disabled={props.disabled || props.pending}
        onClick={() => props.onPage(page?.offset ?? 0)}
      >
        {copy.loadAttempts}
      </Button>
      {page ? (
        <>
          <ol>
            {page.items.map((attempt) => (
              <li key={attempt.id}>
                {copy.attemptCount}: {attempt.attemptNumber}; {copy.retryCycle}: {attempt.cycle};{" "}
                {copy[attempt.status]};{" "}
                {formatRequestInstant(
                  attempt.startedAt,
                  props.timeZone,
                  i18n.language === "es-US" ? "es-US" : "en-US",
                )}
                ;{" "}
                {attempt.finishedAt
                  ? formatRequestInstant(
                      attempt.finishedAt,
                      props.timeZone,
                      i18n.language === "es-US" ? "es-US" : "en-US",
                    )
                  : copy.unavailableTiming}
                ; {attempt.failureCode ?? "—"}; {copy.retryable}:{" "}
                {attempt.retryable ? copy.yes : copy.no}
              </li>
            ))}
          </ol>
          <Button
            disabled={props.disabled || props.pending || page.offset === 0}
            onClick={() => props.onPage(Math.max(0, page.offset - 25))}
          >
            {copy.previousAttempts}
          </Button>
          <Button
            disabled={props.disabled || props.pending || !page.hasMore || page.offset + 25 > 10000}
            onClick={() => props.onPage(page.offset + 25)}
          >
            {copy.nextAttempts}
          </Button>
        </>
      ) : null}
    </section>
  );
}
