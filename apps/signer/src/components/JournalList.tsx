import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState } from "@markiro/ui";
import type { JournalEntry } from "../lib/bridge.js";

const PAGE_SIZE = 20;

export function JournalList({ entries }: { entries: JournalEntry[] }): ReactElement {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short" }),
    [i18n.language],
  );
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { timeStyle: "medium" }),
    [i18n.language],
  );
  if (entries.length === 0) return <EmptyState title={t("journal.empty")} />;

  const newestFirst = entries.slice().reverse();
  const pageCount = Math.max(1, Math.ceil(newestFirst.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleEntries = newestFirst.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="signer-journal">
      <ol className="signer-journal__list">
        {visibleEntries.map((entry, index) => {
          const occurredAt = new Date(entry.occurredAt);
          const validDate = !Number.isNaN(occurredAt.getTime());
          return (
            <li key={`${entry.occurredAt}-${entry.message}-${index}`}>
              <time className="signer-journal__time" dateTime={entry.occurredAt}>
                <span>
                  {validDate ? dateFormatter.format(occurredAt) : t("journal.unknownDate")}
                </span>
                {validDate ? <span>{timeFormatter.format(occurredAt)}</span> : null}
              </time>
              <span className="signer-journal__event">
                <strong>{entry.message}</strong>
                {entry.detail ? <span>{entry.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {pageCount > 1 ? (
        <nav className="signer-journal__pager" aria-label={t("journal.paginationLabel")}>
          <Button
            size="compact"
            variant="secondary"
            disabled={currentPage === 1}
            onClick={() => setPage(Math.max(1, currentPage - 1))}
          >
            {t("journal.previous")}
          </Button>
          <span aria-live="polite">
            {t("journal.page", { page: currentPage, count: pageCount })}
          </span>
          <Button
            size="compact"
            variant="secondary"
            disabled={currentPage === pageCount}
            onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
          >
            {t("journal.next")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
