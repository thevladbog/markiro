import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Pager } from "@markiro/ui";
import { CONFLICTS_PAGE_SIZE, readConflicts, type DeviceConflictPage } from "../lib/conflicts.js";
import type { SqlExecutor } from "../lib/mirror.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { StationScreen } from "../ui/StationScreen.js";

export interface ConflictListProps {
  exec: SqlExecutor;
  onBack: () => void;
}

const EMPTY_PAGE: DeviceConflictPage = {
  items: [],
  page: 1,
  pageSize: CONFLICTS_PAGE_SIZE,
  total: 0,
};

/**
 * Reviewable, not thrown at the operator: App opens this screen only from the
 * explicit Conflicts floor action. Every database read is a bounded page.
 */
export function ConflictList({ exec, onBack }: ConflictListProps) {
  const { t, i18n } = useTranslation();
  const [requestedPage, setRequestedPage] = useState(1);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pageData, setPageData] = useState<DeviceConflictPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReadFailed(false);
    void readConflicts(exec, requestedPage)
      .then((result) => {
        if (cancelled) return;
        setPageData(result);
        setLoading(false);
        if (result.page !== requestedPage) setRequestedPage(result.page);
      })
      .catch((err: unknown) => {
        console.error("station: readConflicts failed", err);
        if (!cancelled) {
          setLoading(false);
          setReadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [exec, loadAttempt, requestedPage]);

  const timeFormat = new Intl.DateTimeFormat(i18n.language.startsWith("ru") ? "ru-RU" : "en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  });

  // Rows written before timestamp validation shipped must degrade locally:
  // one malformed winner time keeps its raw value and never crashes the page.
  function formatWinTime(raw: string): string {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return timeFormat.format(date);
  }

  const pageCount = Math.max(1, Math.ceil(pageData.total / pageData.pageSize));
  const showItems = !loading && !readFailed && pageData.total > 0;

  return (
    <StationScreen
      title={t("conflicts.title")}
      actions={
        <FloorFooter ariaLabel={t("conflicts.actions")}>
          <Button type="button" size="floor" variant="secondary" onClick={onBack}>
            {t("conflicts.back")}
          </Button>
        </FloorFooter>
      }
    >
      <div className="conflict-list">
        <div className="conflict-list__message" aria-live="polite">
          {loading ? (
            <p>{t("conflicts.loading")}</p>
          ) : readFailed ? (
            <>
              <p>{t("conflicts.readFailed")}</p>
              <Button
                type="button"
                size="floor"
                variant="secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t("conflicts.retry")}
              </Button>
            </>
          ) : pageData.total === 0 ? (
            <p>{t("conflicts.empty")}</p>
          ) : (
            <p>{t("conflicts.explanation")}</p>
          )}
        </div>

        <div className="conflict-list__cards" role="list" aria-label={t("conflicts.items")}>
          {showItems
            ? pageData.items.map((conflict) => (
                <Card
                  key={conflict.codeHash}
                  className="conflict-list__card"
                  role="listitem"
                  padding="12px 20px"
                >
                  <div className="conflict-list__identity">
                    {conflict.gtin14 !== null && conflict.serial !== null
                      ? `${conflict.gtin14} ${conflict.serial}`
                      : t("conflicts.unknownItem")}
                  </div>
                  <div
                    className="conflict-list__winner"
                    aria-label={t("conflicts.wonBy", {
                      terminal: conflict.winningTerminalId ?? "—",
                      time: formatWinTime(conflict.winningScannedAt),
                    })}
                  >
                    <span className="conflict-list__winner-label">
                      {t("conflicts.winningTerminal")}
                    </span>
                    <span className="conflict-list__terminal">
                      {conflict.winningTerminalId ?? "—"}
                    </span>
                    <span className="conflict-list__winning-time">
                      {t("conflicts.winningTime", {
                        time: formatWinTime(conflict.winningScannedAt),
                      })}
                    </span>
                  </div>
                  <p className="conflict-list__recovery">{t("conflicts.recovery")}</p>
                </Card>
              ))
            : null}
        </div>

        <Pager
          page={pageData.page}
          pageCount={pageCount}
          onPageChange={setRequestedPage}
          ariaLabel={t("conflicts.pagination")}
          previousLabel={t("conflicts.previousPage")}
          nextLabel={t("conflicts.nextPage")}
          pageLabel={(page, count) => t("conflicts.page", { page, pageCount: count })}
          className="conflict-list__pager"
        />
      </div>
    </StationScreen>
  );
}
