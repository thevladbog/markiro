import { useEffect, useId, useRef, useState } from "react";
import { Button, StatusChip } from "@markiro/ui";
import type { ReceivingLiveRecord, ReceivingRevisionList } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { Pager } from "../master-data/workspace-shared.js";

export function ReceivingRevisionHistory({
  value,
  selectedEventId,
  disabled,
  onOpen,
  onPage,
}: {
  value: ReceivingRevisionList;
  selectedEventId: string;
  disabled: boolean;
  onOpen: (id: string) => void;
  onPage: (offset: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {value.items.length ? (
        <ol className="us-rec-history-lines">
          {value.items.map((item) => (
            <li key={item.id} className="us-rec-revision-row">
              <div>
                <strong>
                  {t("receiving.revision")} {item.revision}
                </strong>{" "}
                <StatusChip
                  status={item.status === "finalized" ? "ok" : "neutral"}
                  label={t(`receiving.${item.status}`)}
                />
                {item.lifecycle.amendmentReason ? (
                  <p>
                    {t("receiving.correctionReason")}: {item.lifecycle.amendmentReason}
                  </p>
                ) : null}
                {item.lifecycle.voidReason ? (
                  <p>
                    {t("receiving.reason")}: {item.lifecycle.voidReason}
                  </p>
                ) : null}
              </div>
              {item.id.toLowerCase() === selectedEventId.toLowerCase() ? (
                <span aria-current="true">{t("receiving.viewingRevision")}</span>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => onOpen(item.id)}
                >
                  {t("receiving.openRevision", { revision: item.revision })}
                </Button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p>{t("receiving.historyEmptyPage")}</p>
      )}
      <Pager
        page={value.offset / 50 + 1}
        hasPrevious={value.offset > 0}
        hasNext={value.items.length === 50 && value.offset < 100000}
        disabled={disabled}
        onPrevious={() => onPage(Math.max(0, value.offset - 50))}
        onNext={() => onPage(value.offset + 50)}
      />
    </>
  );
}

/** Transient query/navigation state; never replaces the displayed record on a failed read. */
export function ReceivingRevisionNavigation({
  record,
  client,
  disabled,
  beginMutation,
  onOpenRecord,
  onSessionLost,
  onForbidden,
  canNavigate = () => true,
}: {
  record: ReceivingLiveRecord;
  client: UsBrowserClient;
  disabled: boolean;
  beginMutation: () => () => void;
  onOpenRecord: (record: ReceivingLiveRecord) => void;
  onSessionLost: () => void;
  onForbidden: () => Promise<void>;
  canNavigate?: () => boolean;
}) {
  const { t } = useTranslation();
  const sectionId = useId();
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState<ReceivingRevisionList | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [opening, setOpening] = useState(false);
  const [failedTarget, setFailedTarget] = useState<string | null>(null);
  const request = useRef(0);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
    };
  }, []);
  async function handleAccess(error: unknown) {
    if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
    if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
  }
  function sameReceipt(item: ReceivingLiveRecord | ReceivingRevisionList["items"][number]) {
    return (
      item.lifecycle.rootId.toLowerCase() === record.lifecycle.rootId.toLowerCase() &&
      item.eventNumber === record.eventNumber &&
      item.timeZone === record.timeZone
    );
  }
  async function load(nextOffset: number) {
    if (disabled || busy.current) return;
    const current = ++request.current;
    setExpanded(true);
    setLoading(true);
    setHistoryFailed(false);
    setValue(null);
    setOffset(nextOffset);
    try {
      const result = await client.listReceivingRevisions(record.id, {
        limit: 50,
        offset: nextOffset,
      });
      if (!alive.current || request.current !== current) return;
      if (
        result.lifecycleVersion < record.lifecycle.lifecycleVersion ||
        !result.items.every(sameReceipt)
      )
        throw new UsClientError("invalid_response");
      setValue(result);
    } catch (error) {
      if (!alive.current || request.current !== current) return;
      setHistoryFailed(true);
      await handleAccess(error);
    } finally {
      if (alive.current && request.current === current) setLoading(false);
    }
  }
  async function open(id: string) {
    if (disabled || busy.current || !canNavigate()) return;
    busy.current = true;
    setOpening(true);
    setFailedTarget(null);
    const release = beginMutation();
    try {
      const result = await client.getReceivingRecord(id);
      if (!alive.current) return;
      if (!sameReceipt(result)) throw new UsClientError("invalid_response");
      onOpenRecord(result);
    } catch (error) {
      if (!alive.current) return;
      setFailedTarget(id);
      await handleAccess(error);
    } finally {
      release();
      busy.current = false;
      if (alive.current) setOpening(false);
    }
  }
  const links = [
    { id: record.lifecycle.currentEventId, key: "openCurrentReceipt" },
    { id: record.lifecycle.pendingDraftId, key: "openPendingCorrection" },
    { id: record.lifecycle.previousRevisionId, key: "openPreviousRevision" },
  ];
  return (
    <section
      className="us-rec-section us-rec-revision-navigation"
      aria-label={t("receiving.revisionNavigation")}
      aria-busy={opening}
    >
      <h2>
        {t("receiving.revision")} {record.revision}
      </h2>
      {record.lifecycle.amendmentReason ? (
        <p>
          {t("receiving.correctionReason")}: {record.lifecycle.amendmentReason}
        </p>
      ) : null}
      <div className="us-rec-confirm-actions">
        {links.map(({ id, key }) =>
          id !== null && id.toLowerCase() !== record.id.toLowerCase() ? (
            <Button
              key={key}
              type="button"
              variant="secondary"
              disabled={disabled || opening}
              onClick={() => void open(id)}
            >
              {t(`receiving.${key}`)}
            </Button>
          ) : null,
        )}
        <Button
          type="button"
          variant="secondary"
          aria-expanded={expanded}
          aria-controls={sectionId}
          disabled={disabled || opening || loading}
          onClick={() => (expanded ? setExpanded(false) : void load(0))}
        >
          {t(expanded ? "receiving.hideHistory" : "receiving.showHistory")}
        </Button>
      </div>
      {opening ? <p role="status">{t("receiving.openingRevision")}</p> : null}
      {failedTarget ? (
        <div role="alert">
          <p>{t("receiving.revisionOpenFailed")}</p>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || opening}
            onClick={() => void open(failedTarget)}
          >
            {t("receiving.retryRevision")}
          </Button>
        </div>
      ) : null}
      {expanded ? (
        <section id={sectionId} aria-label={t("receiving.revisionHistory")} aria-busy={loading}>
          <h3>{t("receiving.revisionHistory")}</h3>
          {loading ? (
            <p role="status">{t("md.stale")}</p>
          ) : historyFailed ? (
            <div role="alert">
              <p>{t("receiving.historyFailed")}</p>
              <Button
                type="button"
                disabled={disabled || opening}
                onClick={() => void load(offset)}
              >
                {t("md.retry")}
              </Button>
            </div>
          ) : value ? (
            <ReceivingRevisionHistory
              value={value}
              selectedEventId={record.id}
              disabled={disabled || opening}
              onOpen={(id) => void open(id)}
              onPage={(next) => void load(next)}
            />
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
