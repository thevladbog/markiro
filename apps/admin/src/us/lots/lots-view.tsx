import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import { TRACEABILITY_LOT_STATUSES } from "@markiro/domain";
import type { TraceabilityLot } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { Pager, type MasterDataViewProps } from "../master-data/workspace-shared.js";
import { LotEditor, type LotEditorMode } from "./lot-editor.js";
import { allowedLotStatuses, lotSourceLabel } from "./shared.js";
import { loadLotReferenceLabels } from "./reference-labels.js";
import { LotReceivingBasisSection } from "./receiving-basis.js";
import type { ReceivingFrozenView } from "../receiving/live-record.js";
import "./lots.css";

type Props = MasterDataViewProps & {
  canManageQa: boolean;
  profileCode: string;
  timeZone: string;
  entryLotId?: string;
  onEntryBack?: () => void;
  entryBackLabel?: string;
  onOpenReceiving: (lotId: string, record: ReceivingFrozenView) => void;
};

export function LotsView(props: Props) {
  const {
    client,
    mutationPending,
    canWrite,
    canManageQa,
    profileCode,
    timeZone,
    onForbidden,
    onSessionLost,
    onNotice,
    entryLotId,
    onEntryBack,
  } = props;
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<TraceabilityLot[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(true);
  const [failure, setFailure] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState(false);
  const [lot, setLot] = useState<TraceabilityLot | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [detailReferences, setDetailReferences] = useState<{
    lot: TraceabilityLot;
    labels: Record<string, string>;
    failed: boolean;
  } | null>(null);
  const [editor, setEditor] = useState<LotEditorMode | null>(null);
  const [refresh, setRefresh] = useState(0);
  const run = useRef(0);
  const openRun = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNeeded = useRef(true);

  const load = useCallback(async () => {
    const current = ++run.current;
    setPending(true);
    setFailure(false);
    try {
      const result = await client.listLots({
        limit: 50,
        offset,
        ...(search ? { search } : {}),
        ...(status ? { status } : {}),
      });
      // At most 50 unique products and 50 unique source locations. No cross-organization cache.
      if (run.current !== current) return;
      const labels = await loadLotReferenceLabels(client, result.items);
      if (run.current !== current) return;
      setRows(result.items);
      setNames(labels);
    } catch (error) {
      if (run.current !== current) return;
      setFailure(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (run.current === current) setPending(false);
    }
  }, [client, offset, search, status, onForbidden, onSessionLost]);
  useEffect(() => {
    if (entryLotId) return;
    void load();
    return () => {
      run.current += 1;
    };
  }, [load, refresh, entryLotId]);
  useEffect(() => {
    if (!entryLotId) return;
    const current = ++openRun.current;
    setOpening(true);
    setOpenFailure(false);
    void client
      .getLot(entryLotId)
      .then((result) => {
        if (openRun.current !== current) return;
        setLot(result);
        focusNeeded.current = true;
      })
      .catch(async (error: unknown) => {
        if (openRun.current !== current) return;
        setOpenFailure(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (openRun.current === current) setOpening(false);
      });
    return () => {
      openRun.current += 1;
    };
  }, [entryLotId, client, onForbidden, onSessionLost]);
  useEffect(() => {
    if (!lot) return;
    let current = true;
    void loadLotReferenceLabels(client, [lot])
      .then((labels) => {
        if (current) setDetailReferences({ lot, labels, failed: false });
      })
      .catch(async (error: unknown) => {
        if (!current) return;
        setDetailReferences({ lot, labels: {}, failed: true });
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      current = false;
    };
  }, [client, lot, onForbidden, onSessionLost]);
  useEffect(
    () => () => {
      openRun.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (focusNeeded.current && !mutationPending && !opening && !editor) {
      heading.current?.focus();
      focusNeeded.current = false;
    }
  }, [editor, lot, mutationPending, opening]);

  async function open(id: string) {
    if (opening || mutationPending) return;
    const current = ++openRun.current;
    setOpening(true);
    setOpenFailure(false);
    try {
      const result = await client.getLot(id);
      if (openRun.current !== current) return;
      setLot(result);
      setNeedsReload(false);
      focusNeeded.current = true;
    } catch (error) {
      if (openRun.current !== current) return;
      setOpenFailure(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (openRun.current === current) setOpening(false);
    }
  }

  if (entryLotId && !lot)
    return (
      <div className="us-lot-page">
        <Button type="button" variant="secondary" disabled={mutationPending} onClick={onEntryBack}>
          {props.entryBackLabel ?? t("receiving.back")}
        </Button>
        <p role={openFailure ? "alert" : "status"}>
          {t(openFailure ? "receiving.openError" : "md.stale")}
        </p>
        {openFailure ? (
          <Button type="button" disabled={opening} onClick={() => void open(entryLotId)}>
            {t("md.retry")}
          </Button>
        ) : null}
      </div>
    );
  if (editor)
    return (
      <LotEditor
        {...props}
        mode={editor}
        onInvalidate={() => setNeedsReload(true)}
        onCancel={() => {
          setEditor(null);
          focusNeeded.current = true;
        }}
        onDone={(result, notice) => {
          setLot(result);
          setNeedsReload(false);
          setEditor(null);
          focusNeeded.current = true;
          if (notice) onNotice("status", notice);
        }}
      />
    );

  const chip = (record: TraceabilityLot) => (
    <StatusChip
      status={record.status === "quarantined" || record.status === "recalled" ? "warn" : "neutral"}
      label={t(`lots.states.${record.status}`)}
    />
  );
  if (lot) {
    const labels = detailReferences?.lot === lot ? detailReferences.labels : {};
    const date = (value: string) =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(value));
    const sourceId =
      lot.source?.kind === "location" ? lot.source.locationId : lot.source?.resolvedLocationId;
    return (
      <div className="us-lot-page" aria-busy={opening}>
        <div className="us-lot-actions">
          <Button
            variant="secondary"
            disabled={opening || mutationPending}
            onClick={() => {
              if (onEntryBack) {
                onEntryBack();
                return;
              }
              setLot(null);
              setOpenFailure(false);
              setRefresh((n) => n + 1);
              focusNeeded.current = true;
            }}
          >
            ← {props.entryBackLabel ?? t(onEntryBack ? "receiving.back" : "lots.back")}
          </Button>
          <Button
            variant="secondary"
            disabled={opening || mutationPending}
            onClick={() => void open(lot.id)}
          >
            {t("lots.reload")}
          </Button>
        </div>
        {openFailure ? <p role="alert">{t("lots.reloadError")}</p> : null}
        {needsReload ? <p role="alert">{t("lots.conflict")}</p> : null}
        {detailReferences?.lot === lot && detailReferences.failed ? (
          <p role="alert">{t("lots.referenceLoadError")}</p>
        ) : null}
        <header className="us-md-page-header">
          <div>
            <h1 ref={heading} tabIndex={-1} className="us-lot-tlc">
              {lot.tlc}
            </h1>
            <p>{labels[`product:${lot.productId}`] ?? lot.productId}</p>
          </div>
          {chip(lot)}
        </header>
        {profileCode === "US_GENERIC_LOT_TRACEABILITY" ? (
          <p className="us-md-notice">{t("lots.generic")}</p>
        ) : null}
        <section className="us-lot-panel" aria-label={t("lots.tlc")}>
          <dl className="us-lot-facts">
            <div>
              <dt>{t("lots.id")}</dt>
              <dd className="us-lot-id">{lot.id}</dd>
            </div>
            <div>
              <dt>{t("lots.product")}</dt>
              <dd className="us-lot-id">{lot.productId}</dd>
            </div>
            <div>
              <dt>{t("lots.basis")}</dt>
              <dd>{t(`lots.${lot.assignmentBasis}`, { defaultValue: lot.assignmentBasis })}</dd>
            </div>
            <div>
              <dt>{t("lots.revision")}</dt>
              <dd>{lot.revision}</dd>
            </div>
            <div>
              <dt>{t("lots.source")}</dt>
              <dd>{sourceId ? (labels[`location:${sourceId}`] ?? sourceId) : t("lots.absent")}</dd>
            </div>
            {lot.source?.kind === "reference" ? (
              <div>
                <dt>{t("lots.referenceValue")}</dt>
                <dd className="us-lot-id">{lot.source.referenceValue}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("lots.createdAt")}</dt>
              <dd>{date(lot.createdAt)}</dd>
            </div>
            <div>
              <dt>{t("lots.updatedAt")}</dt>
              <dd>{date(lot.updatedAt)}</dd>
            </div>
            <div>
              <dt>{t("lots.createdBy")}</dt>
              <dd className="us-lot-id">{lot.createdBy}</dd>
            </div>
            <div>
              <dt>{t("lots.updatedBy")}</dt>
              <dd className="us-lot-id">{lot.updatedBy}</dd>
            </div>
          </dl>
          <p className="us-lot-note">{t("lots.timezone", { zone: timeZone })}</p>
          <p className="us-lot-note">{t("lots.currentNames")}</p>
        </section>
        <p className="us-lot-note">
          {t(lot.sourceLockedAt ? "lots.sourceLocked" : "lots.sourceUnlocked")}
        </p>
        <div className="us-lot-actions">
          {canWrite && !lot.sourceLockedAt ? (
            <Button
              variant="secondary"
              disabled={opening || mutationPending || needsReload}
              onClick={() => setEditor({ kind: "source", lot })}
            >
              {t("lots.correct")}
            </Button>
          ) : null}
          {canManageQa && allowedLotStatuses(lot).length > 0 ? (
            <Button
              variant="secondary"
              disabled={opening || mutationPending || needsReload}
              onClick={() => setEditor({ kind: "status", lot })}
            >
              {t("lots.changeStatus")}
            </Button>
          ) : null}
        </div>
        <p className="us-lot-note">{t("lots.unavailableFeatures")}</p>
        <LotReceivingBasisSection
          key={lot.id}
          {...props}
          lot={lot}
          mutationPending={mutationPending || opening}
          onOpenReceiving={(record) => props.onOpenReceiving(lot.id, record)}
        />
      </div>
    );
  }
  const columns: TableColumn<TraceabilityLot>[] = [
    {
      key: "tlc",
      title: t("lots.tlc"),
      render: (row) => (
        <Button
          className="us-md-link us-lot-tlc"
          variant="secondary"
          size="compact"
          disabled={pending || opening || mutationPending}
          onClick={() => void open(row.id)}
        >
          {row.tlc}
        </Button>
      ),
    },
    {
      key: "productId",
      title: t("lots.product"),
      render: (row) => names[`product:${row.productId}`] ?? row.productId,
    },
    {
      key: "source",
      title: t("lots.source"),
      render: (row) => (
        <span className="us-lot-id">
          {row.source?.kind === "location"
            ? (names[`location:${row.source.locationId}`] ?? row.source.locationId)
            : (lotSourceLabel(row) ?? t("lots.absent"))}
        </span>
      ),
    },
    { key: "status", title: t("lots.status"), render: chip },
  ];
  return (
    <div className="us-lot-page" aria-busy={pending || opening}>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t("lots.title")}
          </h1>
          <p>{t("lots.intro")}</p>
        </div>
        {canWrite ? (
          <Button
            disabled={opening || mutationPending}
            onClick={() => setEditor({ kind: "create" })}
          >
            {t("lots.add")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-md-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (opening || mutationPending) return;
          setOffset(0);
          setSearch(draft.trim());
        }}
      >
        <Input
          label={t("lots.search")}
          maxLength={200}
          value={draft}
          disabled={opening || mutationPending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Select
          native
          label={t("lots.status")}
          value={status}
          disabled={opening || mutationPending}
          onValueChange={(value) => {
            setOffset(0);
            setStatus(value);
          }}
          options={[
            { value: "", label: t("md.all") },
            ...TRACEABILITY_LOT_STATUSES.map((value) => ({
              value,
              label: t(`lots.states.${value}`),
            })),
          ]}
        />
        <Button type="submit" variant="secondary" disabled={opening || mutationPending}>
          {t("md.search")}
        </Button>
      </form>
      {openFailure ? <p role="alert">{t("lots.reloadError")}</p> : null}
      {opening ? <p role="status">{t("lots.loadingDetail")}</p> : null}
      {failure ? (
        <div className="us-md-list-state" role="alert">
          <p>{t("lots.loadError")}</p>
          <Button
            variant="secondary"
            disabled={opening || mutationPending}
            onClick={() => void load()}
          >
            {t("md.retry")}
          </Button>
        </div>
      ) : (
        <>
          {pending ? <p role="status">{t("lots.loading")}</p> : null}
          {!pending || rows.length > 0 ? (
            <Table
              columns={columns}
              rows={rows}
              empty={t("lots.empty")}
              scrollLabel={t("lots.title")}
            />
          ) : null}
        </>
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={rows.length === 50 && offset < 100000}
        disabled={pending || failure || opening || mutationPending}
        onPrevious={() => setOffset((n) => Math.max(0, n - 50))}
        onNext={() => setOffset((n) => n + 50)}
      />
    </div>
  );
}
