import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type { ReceivingLiveRecord, UsEventList, UsEventSummary } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { Pager, type MasterDataViewProps } from "../master-data/workspace-shared.js";
import type { ReceivingFrozenView } from "../receiving/live-record.js";
import { ReceivingView } from "../receiving/view.js";
import { TransformationRecordView } from "../transformation/editor.js";
import { ShippingRecordView } from "../shipping/editor.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import { readinessSourceMatches, ReadinessSourceError } from "../readiness/view.js";
import "./events.css";

type Selected =
  | { type: "receiving"; id: string | null; mode: "record" | "new" | "import" }
  | {
      type: "transformation";
      id: string | null;
      summary?: Extract<UsEventSummary, { type: "transformation" }>;
    }
  | { type: "shipping"; id: string | null };

type Props = MasterDataViewProps & {
  timeZone: string;
  canTransform: boolean;
  canShip: boolean;
  canManageQa: boolean;
  canExport: boolean;
  initialReceiving?: ReceivingLiveRecord;
  initialEvent?: ReadinessEventTarget;
  initialTransformationId?: string;
  onOpenLot: (id: string, record: ReceivingFrozenView) => void;
  onOpenTransformationLot: (id: string) => void;
  onEntryBack?: () => void;
  backLabel?: string;
};

function civilDate(value: string | null, language: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

export function TransformationSummaryView({
  summary,
  onClose,
}: {
  summary: Extract<UsEventSummary, { type: "transformation" }>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="us-event-summary">
      <Button variant="secondary" onClick={onClose}>
        {t("events.back")}
      </Button>
      <header className="us-event-summary__header">
        <span>{t("events.readOnlySummary")}</span>
        <h1 ref={heading} tabIndex={-1} className="us-event-code">
          {summary.eventNumber}
        </h1>
        <p>{t("events.summaryHint")}</p>
      </header>
      <dl className="us-event-summary__facts">
        <div>
          <dt>{t("events.type")}</dt>
          <dd>{t("events.transformation")}</dd>
        </div>
        <div>
          <dt>{t("md.status")}</dt>
          <dd>{t(`events.${summary.status}`)}</dd>
        </div>
        <div>
          <dt>{t("receiving.revision")}</dt>
          <dd>{summary.revision}</dd>
        </div>
        <div>
          <dt>{t("events.date")}</dt>
          <dd>{civilDate(summary.eventDate, i18n.language)}</dd>
        </div>
        <div>
          <dt>{t("events.timeZone")}</dt>
          <dd>{summary.timeZone}</dd>
        </div>
        <div>
          <dt>{t("events.location")}</dt>
          <dd>{summary.locationDisplay ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("receiving.documents")}</dt>
          <dd>{summary.documentCount}</dd>
        </div>
      </dl>
    </section>
  );
}

export function EventsView(props: Props) {
  const { client, mutationPending, onForbidden, onSessionLost } = props;
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<UsEventList["items"]>([]);
  const [type, setType] = useState<"all" | UsEventSummary["type"]>("all");
  const [status, setStatus] = useState<UsEventSummary["status"] | "">("");
  const [history, setHistory] = useState<"current" | "all">("current");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(true);
  const [failure, setFailure] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState(false);
  const [sourceFailure, setSourceFailure] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(
    props.initialEvent
      ? props.initialEvent.type === "receiving"
        ? null
        : { type: props.initialEvent.type, id: props.initialEvent.eventId }
      : props.initialReceiving
        ? { type: "receiving", id: props.initialReceiving.id, mode: "record" }
        : props.initialTransformationId
          ? { type: "transformation", id: props.initialTransformationId }
          : null,
  );
  const [receivingRecord, setReceivingRecord] = useState<ReceivingLiveRecord | null>(
    props.initialEvent ? null : (props.initialReceiving ?? null),
  );
  const [refresh, setRefresh] = useState(0);
  const run = useRef(0);
  const openRun = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const target = props.initialEvent;
    if (!target || target.type !== "receiving") return;
    let active = true;
    setOpening(true);
    setOpenFailure(false);
    setSourceFailure(false);
    void client
      .getReceivingRecord(target.eventId)
      .then((record) => {
        if (!active) return;
        const items =
          record.content.kind === "draft"
            ? record.content.draft.items.map((_, index) => ({ lineNo: index + 1 }))
            : record.content.kind === "finalized"
              ? record.content.snapshot.items
              : [];
        if (!readinessSourceMatches(target, record, { items })) {
          setSourceFailure(true);
          return;
        }
        setReceivingRecord(record);
        setSelected({ type: "receiving", id: target.eventId, mode: "record" });
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setOpenFailure(true);
        if (error instanceof UsClientError && error.code === "invalid_response")
          setSourceFailure(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (active) setOpening(false);
      });
    return () => {
      active = false;
    };
  }, [props.initialEvent, client, onForbidden, onSessionLost, sourceRetry]);

  const load = useCallback(async () => {
    const current = ++run.current;
    setPending(true);
    setFailure(false);
    try {
      const result = await client.listEvents({
        type,
        history,
        limit: 50,
        offset,
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
      });
      if (run.current === current) setRows(result.items);
    } catch (error) {
      if (run.current !== current) return;
      setFailure(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (run.current === current) setPending(false);
    }
  }, [client, type, history, offset, status, search, onSessionLost, onForbidden]);

  useEffect(() => {
    void load();
    return () => {
      run.current += 1;
    };
  }, [load, refresh]);
  useEffect(
    () => () => {
      openRun.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!selected) heading.current?.focus();
  }, [selected]);

  async function openReceiving(id: string) {
    if (opening || mutationPending) return;
    const current = ++openRun.current;
    setOpening(true);
    setOpenFailure(false);
    try {
      const record = await client.getReceivingRecord(id);
      if (openRun.current === current) {
        setReceivingRecord(record);
        setSelected({ type: "receiving", id, mode: "record" });
      }
    } catch (error) {
      if (openRun.current !== current) return;
      setOpenFailure(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (openRun.current === current) setOpening(false);
    }
  }

  function close() {
    if (props.onEntryBack) {
      props.onEntryBack();
      return;
    }
    setSelected(null);
    setReceivingRecord(null);
    setRefresh((value) => value + 1);
  }

  if (props.initialEvent?.type === "receiving" && !selected)
    return sourceFailure ? (
      <ReadinessSourceError
        onRetry={() => setSourceRetry((n) => n + 1)}
        onBack={close}
        disabled={opening || mutationPending}
      />
    ) : (
      <div>
        <Button variant="secondary" disabled={mutationPending} onClick={close}>
          {props.backLabel ?? t("events.back")}
        </Button>
        <p role={openFailure ? "alert" : "status"}>
          {t(openFailure ? "events.openError" : "md.stale")}
        </p>
        {openFailure ? (
          <Button onClick={() => setSourceRetry((n) => n + 1)}>{t("md.retry")}</Button>
        ) : null}
      </div>
    );

  if (selected?.type === "receiving")
    return (
      <ReceivingView
        {...props}
        {...(props.initialEvent ? { sourceTarget: props.initialEvent } : {})}
        key={`${selected.mode}/${selected.id ?? "new"}`}
        {...(selected.mode === "record" && receivingRecord
          ? { initialRecord: receivingRecord }
          : selected.mode === "new"
            ? { startNew: true }
            : { startImport: true })}
        onEntryBack={close}
        backLabel={props.backLabel ?? t("events.back")}
      />
    );
  if (selected?.type === "transformation")
    return (
      <TransformationRecordView
        {...props}
        {...(props.initialEvent ? { sourceTarget: props.initialEvent } : {})}
        onOpenLot={props.onOpenTransformationLot}
        key={selected.id ?? "new"}
        eventId={selected.id}
        onClose={close}
        {...(selected.summary
          ? { fallback: <TransformationSummaryView summary={selected.summary} onClose={close} /> }
          : {})}
      />
    );
  if (selected?.type === "shipping")
    return (
      <ShippingRecordView
        {...props}
        {...(props.initialEvent ? { sourceTarget: props.initialEvent } : {})}
        key={selected.id ?? "new"}
        eventId={selected.id}
        onClose={close}
      />
    );

  const columns: TableColumn<UsEventSummary>[] = [
    {
      key: "type",
      title: t("events.type"),
      render: (row) => (
        <span className="us-event-type">
          <span className="us-event-type__icon" aria-hidden="true">
            {row.type === "receiving" ? "↓" : row.type === "shipping" ? "→" : "⇄"}
          </span>
          {t(`events.${row.type}`)}
        </span>
      ),
    },
    {
      key: "eventNumber",
      title: t("events.numberRevision"),
      render: (row) => (
        <span className="us-event-identity">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            className="us-md-link us-event-code"
            disabled={opening || mutationPending}
            onClick={() => {
              if (row.type === "receiving") void openReceiving(row.id);
              else if (row.type === "transformation") {
                setOpenFailure(false);
                setSelected({ type: "transformation", id: row.id, summary: row });
              } else {
                setOpenFailure(false);
                setSelected({ type: "shipping", id: row.id });
              }
            }}
          >
            {row.eventNumber}
          </Button>
          <span>
            {t("receiving.revision")} {row.revision}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      title: t("md.status"),
      render: (row) => (
        <StatusChip
          status={row.status === "finalized" ? "ok" : "neutral"}
          label={t(`events.${row.status}`)}
        />
      ),
    },
    {
      key: "eventDate",
      title: t("events.date"),
      render: (row) => (
        <span className="us-event-date">
          <span>{civilDate(row.eventDate, i18n.language)}</span>
          <small>{row.timeZone}</small>
        </span>
      ),
    },
    { key: "location", title: t("events.location"), render: (row) => row.locationDisplay ?? "—" },
    {
      key: "summary",
      title: t("events.summary"),
      render: (row) =>
        row.type === "receiving"
          ? t("events.receivingSummary", { lines: row.lineCount, documents: row.documentCount })
          : row.type === "shipping"
            ? t("events.shippingSummary", { lines: row.lineCount, documents: row.documentCount })
            : t("events.transformationSummary", {
                inputs: row.inputCount,
                outputs: row.outputCount,
                documents: row.documentCount,
              }),
    },
  ];
  return (
    <div className="us-events-page" aria-busy={pending || opening}>
      {props.onEntryBack ? (
        <Button variant="secondary" disabled={mutationPending} onClick={close}>
          {props.backLabel ?? t("events.back")}
        </Button>
      ) : null}
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t("events.title")}
          </h1>
          <p>{t("events.intro")}</p>
        </div>
        {props.canWrite ? (
          <div className="us-events-actions">
            <Button
              variant="secondary"
              disabled={opening || mutationPending}
              onClick={() => setSelected({ type: "receiving", id: null, mode: "import" })}
            >
              {t("events.importCsv")}
            </Button>
            <Button
              disabled={opening || mutationPending}
              onClick={() => setSelected({ type: "receiving", id: null, mode: "new" })}
            >
              {t("events.newReceiving")}
            </Button>
          </div>
        ) : null}
        {props.canTransform ? (
          <Button
            disabled={opening || mutationPending}
            onClick={() => setSelected({ type: "transformation", id: null })}
          >
            {t("transformation.new")}
          </Button>
        ) : null}
        {props.canShip ? (
          <Button
            disabled={opening || mutationPending}
            onClick={() => setSelected({ type: "shipping", id: null })}
          >
            {t("shipping.new")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-events-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && !opening) {
            setOffset(0);
            setSearch(filter.trim());
          }
        }}
      >
        <Input
          label={t("events.search")}
          value={filter}
          maxLength={200}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={pending || opening}>
          {t("md.search")}
        </Button>
        <Select
          label={t("events.type")}
          value={type}
          disabled={pending || opening || mutationPending}
          onValueChange={(value) => {
            if (
              value === "all" ||
              value === "receiving" ||
              value === "transformation" ||
              value === "shipping"
            ) {
              setType(value);
              setOffset(0);
            }
          }}
          options={[
            { value: "all", label: t("events.allTypes") },
            { value: "receiving", label: t("events.receiving") },
            { value: "transformation", label: t("events.transformation") },
            { value: "shipping", label: t("events.shipping") },
          ]}
        />
        <Select
          label={t("md.status")}
          value={status}
          disabled={pending || opening || mutationPending}
          onValueChange={(value) => {
            if (
              value === "" ||
              value === "draft" ||
              value === "finalized" ||
              value === "amended" ||
              value === "void"
            ) {
              setStatus(value);
              if (value === "amended") setHistory("all");
              setOffset(0);
            }
          }}
          options={[
            { value: "", label: t("events.allStatuses") },
            { value: "draft", label: t("events.draft") },
            { value: "finalized", label: t("events.finalized") },
            { value: "amended", label: t("events.amended") },
            { value: "void", label: t("events.void") },
          ]}
        />
        <Select
          label={t("events.history")}
          value={history}
          disabled={pending || opening || mutationPending}
          onValueChange={(value) => {
            if (value === "current" || value === "all") {
              setHistory(value);
              setOffset(0);
              if (value === "current" && status === "amended") setStatus("");
            }
          }}
          options={[
            { value: "current", label: t("events.current") },
            { value: "all", label: t("events.allHistory") },
          ]}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={pending || opening}
          onClick={() => void load()}
        >
          {t("events.refresh")}
        </Button>
      </form>
      {openFailure ? <p role="alert">{t("events.openError")}</p> : null}
      {failure ? (
        <div role="alert" className="us-md-list-state">
          <p>{t("events.loadError")}</p>
          <Button disabled={pending} onClick={() => void load()}>
            {t("md.retry")}
          </Button>
        </div>
      ) : pending ? (
        <p role="status">{t("md.stale")}</p>
      ) : rows.length ? (
        <Table columns={columns} rows={rows} scrollLabel={t("events.title")} />
      ) : (
        <p className="us-md-list-state">{t("events.empty")}</p>
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={rows.length === 50 && offset < 100000}
        disabled={pending || failure || opening}
        onPrevious={() => setOffset((value) => Math.max(0, value - 50))}
        onNext={() => setOffset((value) => value + 50)}
      />
    </div>
  );
}
