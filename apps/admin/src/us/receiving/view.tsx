import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type { ReceivingLiveRecord, ReceivingLiveRecordList } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { Pager, type MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingEditor } from "./editor.js";
import { ReceivingAmendmentEditor } from "./amendment-editor.js";
import { ReceivingFinalizedDetail } from "./finalized-detail.js";
import { ReceivingLifecycleActions } from "./lifecycle-dialog.js";
import { ReceivingRevisionNavigation } from "./revision-history.js";
import {
  isReceivingDraftView,
  isReceivingFrozenView,
  type ReceivingFrozenView,
} from "./live-record.js";
import "./receiving.css";

export function ReceivingView(
  props: MasterDataViewProps & {
    timeZone: string;
    canManageQa?: boolean;
    initialRecord?: ReceivingFrozenView;
    onOpenLot?: (id: string, record: ReceivingFrozenView) => void;
    onEntryBack?: () => void;
    backLabel?: string;
  },
) {
  const { client, canWrite, mutationPending, onForbidden, onSessionLost } = props;
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<ReceivingLiveRecordList["items"]>([]);
  const [status, setStatus] = useState<ReceivingLiveRecord["status"] | "">("");
  const [history, setHistory] = useState<"current" | "all">("current");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(true);
  const [failure, setFailure] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState(false);
  const [editor, setEditor] = useState<{ initial: ReceivingLiveRecord | null } | null>(
    props.initialRecord ? { initial: props.initialRecord } : null,
  );
  const [refresh, setRefresh] = useState(0);
  const openRecord = useCallback((initial: ReceivingLiveRecord) => setEditor({ initial }), []);
  const run = useRef(0);
  const openRun = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    const current = ++run.current;
    setPending(true);
    setFailure(false);
    try {
      const result = await client.listReceivingRecords({
        search,
        limit: 50,
        offset,
        history,
        ...(status ? { status } : {}),
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
  }, [client, search, status, history, offset, onForbidden, onSessionLost]);
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
    if (!editor) heading.current?.focus();
  }, [editor]);
  async function open(id: string) {
    if (opening || mutationPending) return;
    const current = ++openRun.current;
    setOpening(true);
    setOpenFailure(false);
    try {
      const initial = await client.getReceivingRecord(id);
      if (openRun.current === current) setEditor({ initial });
    } catch (error) {
      if (openRun.current !== current) return;
      setOpenFailure(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (openRun.current === current) setOpening(false);
    }
  }
  const close = () => {
    if (props.onEntryBack) {
      props.onEntryBack();
      return;
    }
    setEditor(null);
    setRefresh((n) => n + 1);
  };
  if (editor?.initial && isReceivingFrozenView(editor.initial))
    return (
      <ReceivingFinalizedDetail
        record={editor.initial}
        onClose={close}
        {...(props.backLabel ? { backLabel: props.backLabel } : {})}
        onOpenLot={props.onOpenLot ?? (() => {})}
        disabled={mutationPending}
        actions={
          <>
            <ReceivingRevisionNavigation
              key={`${editor.initial.id}/${editor.initial.lifecycle.lifecycleVersion}`}
              {...props}
              record={editor.initial}
              disabled={mutationPending}
              onOpenRecord={openRecord}
            />
            {props.canManageQa ? (
              <ReceivingLifecycleActions
                {...props}
                record={editor.initial}
                onOpenRecord={openRecord}
              />
            ) : null}
          </>
        }
      />
    );
  if (
    editor?.initial &&
    isReceivingDraftView(editor.initial) &&
    editor.initial.lifecycle.previousRevisionId !== null
  )
    return (
      <ReceivingAmendmentEditor
        key={`${editor.initial.id}/${editor.initial.status}/${Boolean(props.canManageQa)}`}
        {...props}
        initial={editor.initial}
        onClose={close}
        onOpenRecord={openRecord}
      />
    );
  if (editor && (!editor.initial || isReceivingDraftView(editor.initial)))
    return (
      <ReceivingEditor
        key={editor.initial ? `${editor.initial.id}/${editor.initial.status}` : "new"}
        {...props}
        canWrite={
          canWrite &&
          (!editor.initial || (editor.initial.status === "draft" && editor.initial.revision === 1))
        }
        initial={editor.initial}
        onClose={close}
        onOpenRecord={openRecord}
      />
    );
  const columns: TableColumn<ReceivingLiveRecordList["items"][number]>[] = [
    {
      key: "eventNumber",
      title: t("receiving.number"),
      render: (row) => (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          className="us-md-link"
          disabled={opening || mutationPending}
          onClick={() => void open(row.id)}
        >
          {row.eventNumber}
        </Button>
      ),
    },
    {
      key: "revision",
      title: t("receiving.revision"),
      render: (row) => String(row.revision),
    },
    {
      key: "status",
      title: t("md.status"),
      render: (row) => (
        <StatusChip
          status={row.status === "finalized" ? "ok" : "neutral"}
          label={t(`receiving.${row.status}`)}
        />
      ),
    },
    {
      key: "dateReceived",
      title: t("receiving.date"),
      render: (row) =>
        row.dateReceived
          ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" }).format(
              new Date(`${row.dateReceived}T12:00:00Z`),
            )
          : "—",
    },
    { key: "lineCount", title: t("receiving.lines"), render: (row) => String(row.lineCount) },
    {
      key: "documentCount",
      title: t("receiving.documents"),
      render: (row) => String(row.documentCount),
    },
    {
      key: "draftVersion",
      title: t("receiving.version"),
      render: (row) => String(row.draftVersion),
    },
  ];
  return (
    <div className="us-rec-page" aria-busy={pending || opening}>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t("receiving.title")}
          </h1>
          <p>{t("receiving.intro")}</p>
        </div>
        {canWrite ? (
          <Button
            disabled={opening || mutationPending}
            onClick={() => setEditor({ initial: null })}
          >
            {t("receiving.new")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-md-filter-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending && !opening) {
            setOffset(0);
            setSearch(filter.trim());
          }
        }}
      >
        <Input
          label={t("receiving.search")}
          value={filter}
          maxLength={200}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={pending || opening}>
          {t("md.search")}
        </Button>
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
            { value: "", label: t("receiving.allStatuses") },
            { value: "draft", label: t("receiving.draft") },
            { value: "finalized", label: t("receiving.finalized") },
            { value: "amended", label: t("receiving.amended") },
            { value: "void", label: t("receiving.void") },
          ]}
        />
        <Select
          label={t("receiving.historySelection")}
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
            { value: "current", label: t("receiving.currentSelection") },
            { value: "all", label: t("receiving.allHistory") },
          ]}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={pending || opening}
          onClick={() => void load()}
        >
          {t("receiving.refresh")}
        </Button>
      </form>
      {openFailure ? <p role="alert">{t("receiving.openError")}</p> : null}
      {failure ? (
        <div role="alert" className="us-md-list-state">
          <p>{t("md.loadError")}</p>
          <Button disabled={pending} onClick={() => void load()}>
            {t("md.retry")}
          </Button>
        </div>
      ) : pending ? (
        <p role="status">{t("md.stale")}</p>
      ) : rows.length ? (
        <Table columns={columns} rows={rows} scrollLabel={t("receiving.title")} />
      ) : (
        <p className="us-md-list-state">{t("receiving.empty")}</p>
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={rows.length === 50 && offset < 100000}
        disabled={pending || failure || opening}
        onPrevious={() => setOffset((n) => Math.max(0, n - 50))}
        onNext={() => setOffset((n) => n + 50)}
      />
    </div>
  );
}
