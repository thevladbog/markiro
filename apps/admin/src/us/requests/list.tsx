import { useEffect, useState } from "react";
import { Button, StatusChip, Table } from "@markiro/ui";
import type { UsRequestSummary } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { getRequestCopy } from "./copy.js";
import { formatRequestInstant, requestCountdown } from "./time.js";

export type RequestListProps = {
  rows: readonly UsRequestSummary[];
  stale: boolean;
  timeZone: string;
  onSelect: (id: string) => void;
};

export function useRequestMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function RequestDeadline({
  row,
  timeZone,
  now,
}: {
  row: UsRequestSummary;
  timeZone: string;
  now: number;
}) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const language = i18n.language === "es-US" ? "es-US" : "en-US";
  const countdown = requestCountdown(row.dueAt, row.closedAt, now);
  const minutes = Math.ceil(Math.abs(countdown.milliseconds) / 60_000);
  return (
    <div className={`us-request-clock us-request-clock--${countdown.kind}`}>
      <span>{formatRequestInstant(row.dueAt, timeZone, language)}</span>
      {row.closedAt ? (
        <span>
          {copy.closedAt}: {formatRequestInstant(row.closedAt, timeZone, language)}
        </span>
      ) : (
        <span>
          <span aria-hidden="true">{countdown.kind === "neutral" ? "◷" : "⚠"} </span>
          {copy[countdown.kind]} · {Math.floor(minutes / 60)}h {minutes % 60}m
        </span>
      )}
    </div>
  );
}

export function RequestList({ rows, stale, timeZone, onSelect }: RequestListProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const language = i18n.language === "es-US" ? "es-US" : "en-US";
  const now = useRequestMinute();
  return (
    <Table
      rows={[...rows]}
      scrollLabel={copy.title}
      columns={[
        {
          key: "requestNumber",
          title: copy.requestNumber,
          wrap: true,
          render: (row) => (
            <Button variant="secondary" disabled={stale} onClick={() => onSelect(row.id)}>
              {row.requestNumber}
            </Button>
          ),
        },
        {
          key: "receivedAt",
          title: copy.receivedWall,
          wrap: true,
          render: (row) => formatRequestInstant(row.receivedAt, timeZone, language),
        },
        {
          key: "dueAt",
          title: copy.dueWall,
          wrap: true,
          render: (row) => <RequestDeadline row={row} timeZone={timeZone} now={now} />,
        },
        {
          key: "status",
          title: copy.lifecycle,
          render: (row) => <StatusChip status="neutral" label={copy[row.status]} />,
        },
        { key: "revision", title: copy.revision, mono: true },
      ]}
    />
  );
}
