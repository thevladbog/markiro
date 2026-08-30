import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";

import {
  AdminPage,
  Alert,
  Button,
  Card,
  Checkbox,
  DataTabs,
  Input,
  Select,
  Spinner,
  Textarea,
} from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { formatDate } from "../../lib/datetime.js";
import {
  useCreateInventoryCorrection,
  useCreateInventoryCorrectionBatch,
  useInventory,
  useInventoryEvidence,
  useInventoryProgress,
} from "./api.js";
import {
  formatCorrectionCount,
  InventoryCorrectionBatchPanel,
} from "./InventoryCorrectionBatchPanel.js";
import {
  clearSelection,
  createExplicitSelection,
  isEventSelected,
  selectAllMatching,
  serializeSelection,
  toggleEvent,
  toggleVisiblePage,
  type InventoryCorrectionSelectionState,
} from "./inventory-correction-selection.js";
import {
  createInventoryCorrectionBatchInputSchema,
  createInventoryCorrectionInputSchema,
  type CreateInventoryCorrectionInput,
  type InventoryEvidenceEvent,
  type InventoryEvidenceFilter,
  type InventoryLiveBox,
} from "./schemas.js";

type CorrectionAction = CreateInventoryCorrectionInput["action"];
type CorrectionTarget = CreateInventoryCorrectionInput["target"];
type BatchAction = "void_scan" | "change_date";

interface SingleSelection {
  action: CorrectionAction;
  target: CorrectionTarget;
  identity: string;
  observedProductionDate: string | null;
}

const SELECTION_ERRORS = new Set([
  "INVENTORY_CORRECTION_STALE_REVISION",
  "INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED",
  "INVENTORY_CORRECTION_BATCH_EMPTY",
]);

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function batchActions(event: InventoryEvidenceEvent): BatchAction[] {
  return event.actions.filter(
    (action): action is BatchAction => action === "void_scan" || action === "change_date",
  );
}

export function InventoryCorrections() {
  const { inventoryId = "" } = useParams();
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "discrepancies" ? "discrepancies" : "all";
  const inventory = useInventory(inventoryId);
  const progress = useInventoryProgress(inventoryId, inventory.data?.status === "running");
  const correction = useCreateInventoryCorrection();
  const batchCorrection = useCreateInventoryCorrectionBatch();
  const [singleSelection, setSingleSelection] = useState<SingleSelection | null>(null);
  const [reason, setReason] = useState("");
  const [observedProductionDate, setObservedProductionDate] = useState("");
  const [saved, setSaved] = useState(false);
  const [batchSaved, setBatchSaved] = useState<{ events: number; codes: number } | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"" | "item" | "known_box" | "old_box">("");
  const [classification, setClassification] = useState<
    "" | "expected" | "protected" | "ineligible" | "unknown" | "voided"
  >("");
  const [category, setCategory] = useState<"" | "ineligible" | "unknown" | "date_mismatch">("");
  const [page, setPage] = useState(1);
  const [bulkSelection, setBulkSelection] =
    useState<InventoryCorrectionSelectionState>(createExplicitSelection);
  const [selectedEvents, setSelectedEvents] = useState<ReadonlyMap<string, InventoryEvidenceEvent>>(
    new Map(),
  );
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const batchIdempotencyKey = useRef(newIdempotencyKey());
  const running = (progress.data?.status ?? inventory.data?.status) === "running";
  const filter = useMemo<InventoryEvidenceFilter>(
    () => ({
      scope: view,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(kind ? { kind } : {}),
      ...(classification ? { classification } : {}),
      ...(view === "discrepancies" && category ? { discrepancyCategory: category } : {}),
    }),
    [category, classification, kind, search, view],
  );
  const filterSignature = JSON.stringify(filter);
  const evidence = useInventoryEvidence(
    inventoryId,
    { ...filter, page, pageSize: 50 },
    running && progress.data !== undefined,
  );

  useEffect(() => {
    setBulkSelection(clearSelection());
    setSelectedEvents(new Map());
    setBatchAction(null);
    setBatchSaved(null);
    setRecoveryError(false);
    batchIdempotencyKey.current = newIdempotencyKey();
  }, [filterSignature]);

  if (inventory.isPending)
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("common.loading")} />
      </div>
    );
  if (inventory.isError || !inventory.data)
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.detail.loadError")}</Alert>
      </AdminPage>
    );
  if (!running)
    return (
      <AdminPage className="mk-inventory-page">
        <h1>{t("pages.inventory.corrections.title", { number: inventory.data.number })}</h1>
        <Alert tone="warn">{t("pages.inventory.corrections.runningOnly")}</Alert>
        <Link className="mk-inventory-back-link" to={`/inventory/${inventoryId}`}>
          {t("pages.inventory.corrections.back")}
        </Link>
      </AdminPage>
    );
  if (progress.isPending || evidence.isPending)
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("pages.inventory.live.loading")} />
      </div>
    );
  if (progress.isError || !progress.data || evidence.isError || !evidence.data)
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.live.loadError")}</Alert>
      </AdminPage>
    );

  const pageEvents = evidence.data.items.filter((event) => batchActions(event).length > 0);
  const pageFullySelected =
    pageEvents.length > 0 &&
    pageEvents.every((event) => isEventSelected(bulkSelection, event.eventId));
  const availableActions: BatchAction[] =
    bulkSelection.mode === "all_matching"
      ? evidence.data.allMatchingActions.filter(
          (action): action is BatchAction => action === "void_scan" || action === "change_date",
        )
      : (["void_scan", "change_date"] as const).filter((action) =>
          [...selectedEvents.values()].every((event) => event.actions.includes(action)),
        );

  const resetBatch = () => {
    batchIdempotencyKey.current = newIdempotencyKey();
    setBatchAction(null);
    batchCorrection.reset();
  };
  const updateBulk = (
    next: InventoryCorrectionSelectionState,
    events: readonly InventoryEvidenceEvent[],
  ) => {
    setBulkSelection(next);
    setSelectedEvents((current) => {
      if (next.mode === "all_matching") return new Map();
      const updated = new Map(current);
      for (const event of events) {
        if (next.selected.has(event.eventId)) updated.set(event.eventId, event);
        else updated.delete(event.eventId);
      }
      return updated;
    });
    setBatchSaved(null);
    setRecoveryError(false);
    resetBatch();
  };
  const selectSingle = (next: SingleSelection) => {
    setSingleSelection(next);
    setObservedProductionDate(next.observedProductionDate ?? "");
    setSaved(false);
    correction.reset();
    idempotencyKey.current = newIdempotencyKey();
  };
  const submitSingle = () => {
    if (
      !singleSelection ||
      !reason.trim() ||
      new TextEncoder().encode(reason.trim()).byteLength > 1024
    )
      return;
    const input = createInventoryCorrectionInputSchema.parse({
      action: singleSelection.action,
      target: singleSelection.target,
      reason,
      expectedResultRevision: progress.data.resultRevision,
      idempotencyKey: idempotencyKey.current,
      ...(singleSelection.action === "change_date" ? { observedProductionDate } : {}),
    });
    correction.mutate(
      { inventoryId, correction: input },
      {
        onSuccess: () => {
          setSaved(true);
          idempotencyKey.current = newIdempotencyKey();
        },
      },
    );
  };
  const submitBatch = (input: { reason: string; observedProductionDate?: string }) => {
    if (!batchAction || bulkSelection.selectedEventCount === 0) return;
    const parsed = createInventoryCorrectionBatchInputSchema.parse({
      action: batchAction,
      selection: serializeSelection(bulkSelection),
      reason: input.reason,
      expectedResultRevision: progress.data.resultRevision,
      idempotencyKey: batchIdempotencyKey.current,
      ...(batchAction === "change_date"
        ? { observedProductionDate: input.observedProductionDate }
        : {}),
    });
    batchCorrection.mutate(
      { inventoryId, correction: parsed },
      {
        onSuccess: (result) => {
          setBatchSaved({ events: result.selectedEventCount, codes: result.affectedCodeCount });
          setBulkSelection(clearSelection());
          setSelectedEvents(new Map());
          setBatchAction(null);
          batchIdempotencyKey.current = newIdempotencyKey();
        },
        onError: (error) => {
          const code = error instanceof ApiRequestError ? error.code : null;
          if (!code || !SELECTION_ERRORS.has(code)) return;
          setBulkSelection(clearSelection());
          setSelectedEvents(new Map());
          setBatchAction(null);
          setRecoveryError(true);
          batchIdempotencyKey.current = newIdempotencyKey();
          void progress.refetch();
          void evidence.refetch();
        },
      },
    );
  };
  const batchErrorCode = batchCorrection.isError
    ? batchCorrection.error instanceof ApiRequestError
      ? (batchCorrection.error.code ?? "SERVER")
      : "NETWORK"
    : null;

  return (
    <AdminPage className="mk-inventory-page mk-inventory-corrections">
      <header className="mk-inventory-live__header">
        <div>
          <h1>{t("pages.inventory.corrections.title", { number: inventory.data.number })}</h1>
          <p className="mk-inventory-page__description">
            {t("pages.inventory.corrections.auditHint")}
          </p>
        </div>
        <Link className="mk-inventory-action-link" to={`/inventory/${inventoryId}`}>
          {t("pages.inventory.corrections.back")}
        </Link>
      </header>
      {recoveryError ? (
        <Alert tone="warn">{t("pages.inventory.corrections.batch.selectionChanged")}</Alert>
      ) : null}
      {batchSaved ? (
        <Alert tone="ok">
          {t("pages.inventory.corrections.batch.saved", {
            events: formatCorrectionCount(batchSaved.events, i18n.language),
            codes: formatCorrectionCount(batchSaved.codes, i18n.language),
          })}
        </Alert>
      ) : null}
      <div
        className={`mk-inventory-correction-layout${inventory.data.mode === "repack" ? " mk-inventory-correction-layout--repack" : ""}`}
      >
        <Card title={t("pages.inventory.corrections.events")} titleAs="h2">
          <DataTabs
            className="mk-inventory-correction-views"
            label={t("pages.inventory.corrections.view.label")}
            activeId={view}
            items={[
              {
                id: "discrepancies",
                label: t("pages.inventory.corrections.view.discrepancies"),
              },
              { id: "all", label: t("pages.inventory.corrections.view.all") },
            ]}
            onChange={(nextView) => {
              setSearchParams(nextView === "discrepancies" ? { view: nextView } : {});
              setPage(1);
            }}
          />
          <div className="mk-inventory-correction-filters">
            <Input
              label={t("pages.inventory.corrections.search")}
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setPage(1);
              }}
            />
            <Select
              label={t("pages.inventory.corrections.kind")}
              value={kind}
              options={[
                { value: "", label: t("pages.inventory.corrections.all") },
                { value: "item", label: t("pages.inventory.corrections.kindItem") },
                { value: "known_box", label: t("pages.inventory.corrections.kindKnownBox") },
                { value: "old_box", label: t("pages.inventory.corrections.kindOldBox") },
              ]}
              onValueChange={(value) => {
                setKind(value);
                setPage(1);
              }}
            />
            <Select
              label={t("pages.inventory.corrections.classification")}
              value={classification}
              options={[
                { value: "", label: t("pages.inventory.corrections.all") },
                ...(["expected", "protected", "ineligible", "unknown", "voided"] as const).map(
                  (value) => ({ value, label: t(`pages.inventory.live.classification.${value}`) }),
                ),
              ]}
              onValueChange={(value) => {
                setClassification(value);
                setPage(1);
              }}
            />
            {view === "discrepancies" ? (
              <Select
                label={t("pages.inventory.corrections.discrepancyCategory")}
                value={category}
                options={[
                  { value: "", label: t("pages.inventory.corrections.all") },
                  ...(["ineligible", "unknown", "date_mismatch"] as const).map((value) => ({
                    value,
                    label: t(`pages.inventory.corrections.category.${value}`),
                  })),
                ]}
                onValueChange={(value) => {
                  setCategory(value);
                  setPage(1);
                }}
              />
            ) : null}
          </div>
          {pageEvents.length > 0 ? (
            <div className="mk-inventory-correction-selection-head">
              <div className="mk-inventory-correction-selection-head__page">
                <Checkbox
                  aria-label={t("pages.inventory.corrections.batch.selectPage")}
                  label={t("pages.inventory.corrections.batch.selectPage")}
                  checked={pageFullySelected}
                  onCheckedChange={() =>
                    updateBulk(toggleVisiblePage(bulkSelection, pageEvents), pageEvents)
                  }
                />
                {pageFullySelected ? (
                  <small aria-live="polite">
                    {t("pages.inventory.corrections.batch.selectedPage", {
                      count: formatCorrectionCount(pageEvents.length, i18n.language),
                    })}
                  </small>
                ) : null}
              </div>
              {bulkSelection.mode === "explicit" &&
              pageFullySelected &&
              evidence.data.total > bulkSelection.selectedEventCount ? (
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => {
                    setBulkSelection(
                      selectAllMatching({
                        filter,
                        total: evidence.data.total,
                        affectedCodeCount: evidence.data.allMatchingAffectedCodeCount,
                      }),
                    );
                    setSelectedEvents(new Map());
                    resetBatch();
                  }}
                >
                  {t("pages.inventory.corrections.batch.selectAll", {
                    count: formatCorrectionCount(evidence.data.total, i18n.language),
                  })}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ul className="mk-inventory-correction-list">
            {evidence.data.items.map((event) => (
              <CorrectionEvent
                key={event.eventId}
                event={event}
                selected={isEventSelected(bulkSelection, event.eventId)}
                copied={copiedEventId === event.eventId}
                onToggle={
                  batchActions(event).length > 0
                    ? () => updateBulk(toggleEvent(bulkSelection, event), [event])
                    : undefined
                }
                onCopy={
                  event.copyIdentity
                    ? () => {
                        const value = event.copyIdentity;
                        if (!value) return;
                        void navigator.clipboard.writeText(value);
                        setCopiedEventId(event.eventId);
                      }
                    : undefined
                }
                onSelect={selectSingle}
              />
            ))}
          </ul>
          <div className="mk-inventory-correction-pagination">
            <Button
              size="compact"
              variant="secondary"
              disabled={page === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              {t("pages.inventory.corrections.previous")}
            </Button>
            <span>
              {t("pages.inventory.corrections.page", { page, total: evidence.data.total })}
            </span>
            <Button
              size="compact"
              variant="secondary"
              disabled={!evidence.data.hasMore}
              onClick={() => setPage((value) => value + 1)}
            >
              {t("pages.inventory.corrections.next")}
            </Button>
          </div>
          {bulkSelection.selectedEventCount > 0 ? (
            <div className="mk-inventory-correction-bulk-bar">
              <strong>
                {t("pages.inventory.corrections.batch.selected", {
                  events: formatCorrectionCount(bulkSelection.selectedEventCount, i18n.language),
                  codes: formatCorrectionCount(bulkSelection.selectedCodeCount, i18n.language),
                })}
              </strong>
              <div className="mk-inventory-actions">
                {availableActions.includes("void_scan") ? (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      batchCorrection.reset();
                      setBatchAction("void_scan");
                    }}
                  >
                    {t("pages.inventory.corrections.batch.open.void_scan")}
                  </Button>
                ) : null}
                {availableActions.includes("change_date") ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      batchCorrection.reset();
                      setBatchAction("change_date");
                    }}
                  >
                    {t("pages.inventory.corrections.batch.open.change_date")}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => updateBulk(clearSelection(), [])}>
                  {t("pages.inventory.corrections.batch.clear")}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
        {inventory.data.mode === "repack" ? (
          <Card title={t("pages.inventory.corrections.newBoxes")} titleAs="h2">
            {progress.data.boxes.length === 0 ? (
              <p className="mk-inventory-section-description">
                {t("pages.inventory.corrections.newBoxesEmpty")}
              </p>
            ) : (
              <ul className="mk-inventory-correction-list">
                {progress.data.boxes.map((box) => (
                  <CorrectionBox key={box.id} box={box} onSelect={selectSingle} />
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
      {singleSelection ? (
        <SingleCorrectionForm
          selection={singleSelection}
          reason={reason}
          date={observedProductionDate}
          saved={saved}
          pending={correction.isPending}
          failed={correction.isError}
          onReason={setReason}
          onDate={setObservedProductionDate}
          onSubmit={submitSingle}
        />
      ) : null}
      {batchAction ? (
        <InventoryCorrectionBatchPanel
          action={batchAction}
          selectedEventCount={bulkSelection.selectedEventCount}
          affectedCodeCount={bulkSelection.selectedCodeCount}
          pending={batchCorrection.isPending}
          errorCode={batchErrorCode}
          onCancel={resetBatch}
          onConfirm={submitBatch}
        />
      ) : null}
    </AdminPage>
  );
}

function CorrectionEvent({
  event,
  selected,
  copied,
  onToggle,
  onCopy,
  onSelect,
}: {
  event: InventoryEvidenceEvent;
  selected: boolean;
  copied: boolean;
  onToggle?: (() => void) | undefined;
  onCopy?: (() => void) | undefined;
  onSelect: (selection: SingleSelection) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <li className="mk-inventory-correction-event">
      {onToggle ? (
        <Checkbox
          aria-label={t("pages.inventory.corrections.batch.selectEvent", {
            identity: event.displayIdentity,
          })}
          label=""
          checked={selected}
          onCheckedChange={onToggle}
        />
      ) : null}
      <span className="mk-inventory-correction-event__main">
        <strong className="mk-inventory-mono">{event.displayIdentity}</strong>
        {event.copyIdentity ? (
          <span className="mk-inventory-copy-row">
            <code>{event.copyIdentity}</code>
            <Button size="compact" variant="secondary" onClick={onCopy}>
              {copied
                ? t("pages.inventory.corrections.copied")
                : t("pages.inventory.corrections.copy")}
            </Button>
          </span>
        ) : (
          <small>{t("pages.inventory.corrections.copyUnavailable")}</small>
        )}
        <small>
          {event.observedProductionDate
            ? t("pages.inventory.corrections.productionDate", {
                date: formatDate(event.observedProductionDate, i18n.language),
              })
            : event.affectedCodeCount > 1
              ? t("pages.inventory.corrections.mixedDates")
              : t("pages.inventory.corrections.dateUnavailable")}
        </small>
        {event.classifications.length ? (
          <small>
            {event.classifications
              .map((value) => t(`pages.inventory.live.classification.${value}`))
              .join(" · ")}
          </small>
        ) : null}
        {event.discrepancyCategories.length ? (
          <small>
            {event.discrepancyCategories
              .map((value) => t(`pages.inventory.corrections.category.${value}`))
              .join(" · ")}
          </small>
        ) : null}
        <small>
          {t("pages.inventory.corrections.eventMeta", {
            codes: event.affectedCodeCount,
            discrepancies: event.discrepancyCodeCount,
            terminal: event.terminalName,
            date: new Intl.DateTimeFormat(i18n.language, {
              dateStyle: "short",
              timeStyle: "short",
            }).format(new Date(event.scannedAt)),
          })}
        </small>
      </span>
      <div className="mk-inventory-correction-list__actions">
        {event.actions.map((action, index) => {
          const target =
            action === "void_scan" || action === "restore_scan"
              ? { eventId: event.eventId }
              : event.codeResultId
                ? { codeResultId: event.codeResultId }
                : null;
          return target ? (
            <Button
              key={action}
              size="compact"
              variant={action === "remove_item" ? "destructive-outline" : "secondary"}
              aria-label={
                index === 0
                  ? t("pages.inventory.corrections.select", { identity: event.displayIdentity })
                  : undefined
              }
              onClick={() =>
                onSelect({
                  action,
                  target,
                  identity: event.displayIdentity,
                  observedProductionDate: event.observedProductionDate,
                })
              }
            >
              {t(`pages.inventory.corrections.action.${action}`)}
            </Button>
          ) : null;
        })}
      </div>
    </li>
  );
}

function SingleCorrectionForm({
  selection,
  reason,
  date,
  saved,
  pending,
  failed,
  onReason,
  onDate,
  onSubmit,
}: {
  selection: SingleSelection;
  reason: string;
  date: string;
  saved: boolean;
  pending: boolean;
  failed: boolean;
  onReason: (value: string) => void;
  onDate: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const tooLong = new TextEncoder().encode(reason.trim()).byteLength > 1024;
  return (
    <Card
      title={t("pages.inventory.corrections.formTitle", { identity: selection.identity })}
      titleAs="h2"
    >
      <div className="mk-inventory-correction-form">
        <Textarea
          label={t("pages.inventory.corrections.reason")}
          value={reason}
          required
          onChange={(event) => onReason(event.currentTarget.value)}
        />
        {tooLong ? (
          <Alert tone="error">{t("pages.inventory.corrections.reasonTooLong")}</Alert>
        ) : null}
        {selection.action === "change_date" ? (
          <Input
            type="date"
            label={t("pages.inventory.corrections.observedDate")}
            value={date}
            required
            onChange={(event) => onDate(event.currentTarget.value)}
          />
        ) : null}
        {saved ? <Alert tone="ok">{t("pages.inventory.corrections.saved")}</Alert> : null}
        {failed ? <Alert tone="error">{t("pages.inventory.corrections.saveError")}</Alert> : null}
        <div className="mk-inventory-actions">
          <Button
            variant={
              selection.action === "void_scan" || selection.action === "invalidate_box"
                ? "destructive"
                : "primary"
            }
            disabled={!reason.trim() || tooLong || (selection.action === "change_date" && !date)}
            loading={pending}
            onClick={onSubmit}
          >
            {t(`pages.inventory.corrections.action.${selection.action}`)}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CorrectionBox({
  box,
  onSelect,
}: {
  box: InventoryLiveBox;
  onSelect: (selection: SingleSelection) => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <span>
        <strong className="mk-inventory-mono">{box.sscc}</strong>
        <small>{box.terminalName}</small>
      </span>
      <div className="mk-inventory-correction-list__actions">
        {box.state !== "invalidated" ? (
          <Button
            size="compact"
            variant="destructive-outline"
            onClick={() =>
              onSelect({
                action: "invalidate_box",
                target: { repackBoxId: box.id },
                identity: box.sscc,
                observedProductionDate: box.productionDate,
              })
            }
          >
            {t("pages.inventory.corrections.action.invalidate_box")}
          </Button>
        ) : null}
        {box.state === "closed" && box.printState === "printed" ? (
          <Button
            size="compact"
            variant="secondary"
            onClick={() =>
              onSelect({
                action: "reprint",
                target: { repackBoxId: box.id },
                identity: box.sscc,
                observedProductionDate: box.productionDate,
              })
            }
          >
            {t("pages.inventory.corrections.action.reprint")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
