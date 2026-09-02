import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import type { JournalEventDto, JournalSessionDto } from "./api.js";

const OUTCOME_STATUS: Record<string, StatusChipStatus> = {
  ok: "ok",
  warn: "warn",
  error: "error",
  running: "info",
};

function outcomeKey(outcome: string | null): string {
  return outcome ?? "running";
}

function formatTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

function durationLabel(
  session: JournalSessionDto,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!session.finishedAt) return t("pages.integrations.channel.journal.inProgress");
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(session.finishedAt).getTime() - new Date(session.startedAt).getTime()) / 1_000,
    ),
  );
  if (seconds < 60)
    return t("pages.integrations.channel.journal.durationSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return t("pages.integrations.channel.journal.durationMinutes", { minutes, seconds: rest });
}

function sessionSummary(session: JournalSessionDto): string {
  const summaryMessage = session.summary?.["message"];
  if (typeof summaryMessage === "string" && summaryMessage.trim()) return summaryMessage;
  return session.events.at(-1)?.message ?? "—";
}

function EventRow({
  event,
  locale,
  timeZone,
}: {
  event: JournalEventDto;
  locale: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const raw = typeof event.details?.["raw"] === "string" ? event.details["raw"] : null;
  const status = OUTCOME_STATUS[outcomeKey(event.outcome)] ?? "neutral";

  return (
    <li className="mk-journal-event">
      <time dateTime={event.at}>{formatTime(event.at, locale, timeZone)}</time>
      <span className="mk-journal-event__direction">
        {t(`pages.integrations.channel.journal.direction.${event.direction}`, {
          defaultValue: event.direction,
        })}
      </span>
      <StatusChip
        status={status}
        label={t(`pages.integrations.channel.journal.outcome.${outcomeKey(event.outcome)}`, {
          defaultValue: event.outcome,
        })}
      />
      <div className="mk-journal-event__message">
        <span>{event.message}</span>
        {raw ? (
          <details className="mk-journal-event__raw">
            <summary>{t("pages.integrations.channel.journal.detailsSummary")}</summary>
            <pre>{raw}</pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function JournalSessionRow({
  session,
  locale,
  timeZone,
}: {
  session: JournalSessionDto;
  locale: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const generatedId = useId();
  const panelId = `journal-session-${generatedId}`;
  const key = outcomeKey(session.outcome);
  const directions = [...new Set(session.events.map((event) => event.direction))];
  const summary = sessionSummary(session);

  return (
    <li
      className="mk-journal-session"
      data-testid="journal-session"
      data-session-id={session.id}
      data-outcome={key}
    >
      <Button
        type="button"
        variant="secondary"
        fullWidth
        className="mk-journal-session__toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: "grid",
          justifyContent: "initial",
          gap: "var(--sp-3)",
          minHeight: 0,
          padding: "var(--sp-4) var(--sp-2)",
          border: 0,
          borderRadius: 0,
          background: "var(--journal-row-bg, transparent)",
          color: "var(--fg-1)",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <time className="mk-journal-session__time" dateTime={session.startedAt}>
          {formatTime(session.startedAt, locale, timeZone)}
        </time>
        <span className="mk-journal-session__summary">{summary}</span>
        <span className="mk-journal-session__meta">
          <span>{durationLabel(session, t)}</span>
          <span>
            {t("pages.integrations.channel.journal.eventCount", { count: session.eventCount })}
          </span>
          {directions.length > 0 ? (
            <span>
              {directions
                .map((direction) =>
                  t(`pages.integrations.channel.journal.direction.${direction}`, {
                    defaultValue: direction,
                  }),
                )
                .join(" · ")}
            </span>
          ) : null}
        </span>
        <StatusChip
          status={OUTCOME_STATUS[key] ?? "neutral"}
          label={t(`pages.integrations.channel.journal.outcome.${key}`, { defaultValue: key })}
        />
        <span className="mk-journal-session__chevron" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </Button>

      {expanded ? (
        <div id={panelId} className="mk-journal-session__panel">
          {session.eventsTruncated ? (
            <p className="mk-journal-session__truncated">
              {t("pages.integrations.channel.journal.truncated", {
                shown: session.events.length,
                total: session.eventCount,
              })}
            </p>
          ) : null}
          {session.events.length > 0 ? (
            <ol className="mk-journal-events">
              {session.events.map((event, index) => (
                <EventRow
                  key={`${event.at}-${index}`}
                  event={event}
                  locale={locale}
                  timeZone={timeZone}
                />
              ))}
            </ol>
          ) : (
            <p className="mk-journal-session__no-events">
              {t("pages.integrations.channel.journal.noEvents")}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}
