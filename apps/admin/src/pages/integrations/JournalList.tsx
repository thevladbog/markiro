import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Card, EmptyState, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { useChannelJournal, type JournalEventDto, type JournalSessionDto } from "./api.js";

/**
 * Error-first ordering for the journal feed -- brief 08's "the most recent
 * failed session is surfaced at the top of the journal rather than buried in
 * order". The server (`readJournal` in
 * `apps/api/src/modules/integrations/integrations.service.ts`) already
 * returns sessions in this order, but the client re-applies the same rule
 * rather than trusting it blindly: this ordering is a property THIS screen
 * promises, not just a courtesy the server happens to provide today.
 */
function orderSessions(sessions: JournalSessionDto[]): JournalSessionDto[] {
  const failed = sessions.filter((session) => session.outcome === "error");
  const rest = sessions.filter((session) => session.outcome !== "error");
  return [...failed, ...rest];
}

function formatSessionTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(iso),
  );
}

const OUTCOME_STATUS: Record<string, StatusChipStatus> = {
  ok: "ok",
  warn: "warn",
  error: "error",
};

/**
 * One journal event -- direction, the human-readable line the server wrote,
 * and (if present) the verbatim protocol response.
 *
 * Task 13 brief: the person who reads a failed session's detail is usually
 * the customer's own 1C specialist, not our administrator -- so
 * `details.raw`, when present, is rendered exactly as received (no
 * paraphrase, no reformatting), monospace, inside a `<details>` that is
 * collapsed by default (no `open` attribute). It only ever reaches the DOM
 * once its *session* row is expanded (see `JournalSessionRow` below) --
 * that's the actual show/hide boundary; the `<details>` here is a visual
 * collapse for an already-rendered block, not a second gate.
 */
function EventRow({ event, t }: { event: JournalEventDto; t: TFunction }) {
  const details = event.details;
  const raw = typeof details?.["raw"] === "string" ? details["raw"] : null;

  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
          {t(`pages.integrations.channel.journal.direction.${event.direction}`, {
            defaultValue: event.direction,
          })}
        </span>
        <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{event.message}</span>
      </div>
      {raw && (
        <details>
          <summary style={{ font: "var(--text-caption)", color: "var(--fg-3)", cursor: "pointer" }}>
            {t("pages.integrations.channel.journal.detailsSummary")}
          </summary>
          <pre
            style={{
              font: "var(--text-code)",
              color: "var(--fg-2)",
              background: "var(--surface-panel)",
              padding: 10,
              margin: "6px 0 0",
              borderRadius: "var(--r-2)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {raw}
          </pre>
        </details>
      )}
    </li>
  );
}

/**
 * One journal session row. Collapsed by default -- its events (and their
 * detail blocks) are not in the DOM at all until this row is clicked, which
 * is what lets `EventRow`'s `details.raw` stay hidden from a mere page-load
 * for a session nobody has opened yet. `data-testid`/`data-outcome` exist
 * purely for `integrations-channel.test.tsx`'s ordering assertion -- there is
 * no other way to observe "is the failed session first" from the a11y tree.
 */
function JournalSessionRow({
  session,
  t,
  locale,
}: {
  session: JournalSessionDto;
  t: TFunction;
  locale: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const outcomeKey = session.outcome ?? "unknown";

  const toggle = () => setExpanded((value) => !value);

  return (
    <li
      data-testid="journal-session"
      data-outcome={outcomeKey}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 0",
        borderBottom: "1px solid var(--line)",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
          {formatSessionTime(session.startedAt, locale)}
        </span>
        <StatusChip
          status={OUTCOME_STATUS[outcomeKey] ?? "neutral"}
          label={t(`pages.integrations.channel.journal.outcome.${outcomeKey}`, {
            defaultValue: outcomeKey,
          })}
        />
      </div>
      {expanded && (
        // Fix (review, Task 13 follow-up): this nested list holds `EventRow`'s
        // own `<details>`/`<summary>` disclosure. A click there is a real DOM
        // click on a descendant of this `<li>`, which bubbles straight up to
        // the `onClick={toggle}` above -- without stopping it here, opening
        // an event's protocol response collapsed the very session it belongs
        // to in the same gesture. `stopPropagation` only blocks the bubble;
        // the summary's own native open/close toggle is unaffected.
        <ul
          style={{ margin: 0, padding: 0, listStyle: "none" }}
          onClick={(event) => event.stopPropagation()}
        >
          {session.events.map((event, index) => (
            // Events carry no id of their own (dto.ts's `JournalEventDto`) --
            // index is stable here since this list is never reordered or
            // filtered independently of its parent session.
            <EventRow key={index} event={event} t={t} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The channel page's journal region -- Task 13. Self-contained (fetches its
 * own data via `useChannelJournal`) so it stays one clean area of the page
 * rather than fusing with the header/settings regions above it; the
 * candidates queue that a later task adds is a sibling area, not something
 * that needs to reach into this one.
 */
export function JournalList({ type }: { type: string }) {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError } = useChannelJournal(type);
  const sessions = useMemo(() => orderSessions(data ?? []), [data]);

  return (
    <Card title={t("pages.integrations.channel.journal.title")}>
      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("pages.integrations.channel.journal.loadError")}</Alert>
      ) : sessions.length === 0 ? (
        <EmptyState
          title={t("pages.integrations.channel.journal.emptyTitle")}
          hint={t("pages.integrations.channel.journal.emptyHint")}
        />
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {sessions.map((session) => (
            <JournalSessionRow key={session.id} session={session} t={t} locale={i18n.language} />
          ))}
        </ul>
      )}
    </Card>
  );
}
