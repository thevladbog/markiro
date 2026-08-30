import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { AdminPage, Alert, Button, Card, Input, Select, Spinner, Textarea } from "@markiro/ui";

import { formatDate } from "../../lib/datetime.js";
import {
  useCreateInventoryCorrection,
  useInventory,
  useInventoryEvidence,
  useInventoryProgress,
} from "./api.js";
import {
  createInventoryCorrectionInputSchema,
  type CreateInventoryCorrectionInput,
  type InventoryEvidenceEvent,
  type InventoryLiveBox,
} from "./schemas.js";

type CorrectionAction = CreateInventoryCorrectionInput["action"];
type CorrectionTarget = CreateInventoryCorrectionInput["target"];

interface Selection {
  action: CorrectionAction;
  target: CorrectionTarget;
  identity: string;
  observedProductionDate: string | null;
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function InventoryCorrections() {
  const { inventoryId = "" } = useParams();
  const { t } = useTranslation();
  const inventory = useInventory(inventoryId);
  const detailRunning = inventory.data?.status === "running";
  const progress = useInventoryProgress(inventoryId, detailRunning);
  const correction = useCreateInventoryCorrection();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reason, setReason] = useState("");
  const [observedProductionDate, setObservedProductionDate] = useState("");
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"" | "item" | "known_box" | "old_box">("");
  const [classification, setClassification] = useState<
    "" | "expected" | "protected" | "ineligible" | "unknown" | "voided"
  >("");
  const [page, setPage] = useState(1);
  const idempotencyKey = useRef(newIdempotencyKey());
  const running = (progress.data?.status ?? inventory.data?.status) === "running";
  const evidence = useInventoryEvidence(
    inventoryId,
    {
      page,
      pageSize: 50,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(kind ? { kind } : {}),
      ...(classification ? { classification } : {}),
    },
    running && progress.data !== undefined,
  );

  if (inventory.isPending) {
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (inventory.isError || !inventory.data) {
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.detail.loadError")}</Alert>
      </AdminPage>
    );
  }

  if (!running) {
    return (
      <AdminPage className="mk-inventory-page">
        <h1>{t("pages.inventory.corrections.title", { number: inventory.data.number })}</h1>
        <Alert tone="warn">{t("pages.inventory.corrections.runningOnly")}</Alert>
        <Link className="mk-inventory-back-link" to={`/inventory/${inventoryId}`}>
          {t("pages.inventory.corrections.back")}
        </Link>
      </AdminPage>
    );
  }

  if (progress.isPending || evidence.isPending) {
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("pages.inventory.live.loading")} />
      </div>
    );
  }

  if (progress.isError || !progress.data || evidence.isError || !evidence.data) {
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.live.loadError")}</Alert>
      </AdminPage>
    );
  }

  const select = (next: Selection) => {
    setSelection(next);
    setObservedProductionDate(next.observedProductionDate ?? "");
    setSaved(false);
    correction.reset();
    idempotencyKey.current = newIdempotencyKey();
  };

  const submit = () => {
    if (!selection || !reason.trim() || new TextEncoder().encode(reason.trim()).byteLength > 1024)
      return;
    const input = createInventoryCorrectionInputSchema.parse({
      action: selection.action,
      target: selection.target,
      reason,
      expectedResultRevision: progress.data.resultRevision,
      idempotencyKey: idempotencyKey.current,
      ...(selection.action === "change_date" ? { observedProductionDate } : {}),
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

      <div
        className={`mk-inventory-correction-layout${
          inventory.data.mode === "repack" ? " mk-inventory-correction-layout--repack" : ""
        }`}
      >
        <Card title={t("pages.inventory.corrections.events")} titleAs="h2">
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
                  (value) => ({
                    value,
                    label: t(`pages.inventory.live.classification.${value}`),
                  }),
                ),
              ]}
              onValueChange={(value) => {
                setClassification(value);
                setPage(1);
              }}
            />
          </div>
          <ul className="mk-inventory-correction-list">
            {evidence.data.items.map((event) => (
              <CorrectionEvent key={event.eventId} event={event} onSelect={select} />
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
                  <CorrectionBox key={box.id} box={box} onSelect={select} />
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>

      {selection ? (
        <Card
          title={t("pages.inventory.corrections.formTitle", { identity: selection.identity })}
          titleAs="h2"
        >
          <div className="mk-inventory-correction-form">
            <Textarea
              label={t("pages.inventory.corrections.reason")}
              value={reason}
              required
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            {new TextEncoder().encode(reason.trim()).byteLength > 1024 ? (
              <Alert tone="error">{t("pages.inventory.corrections.reasonTooLong")}</Alert>
            ) : null}
            {selection.action === "change_date" ? (
              <Input
                type="date"
                label={t("pages.inventory.corrections.observedDate")}
                value={observedProductionDate}
                required
                onChange={(event) => setObservedProductionDate(event.currentTarget.value)}
              />
            ) : null}
            {saved ? <Alert tone="ok">{t("pages.inventory.corrections.saved")}</Alert> : null}
            {correction.isError ? (
              <Alert tone="error">{t("pages.inventory.corrections.saveError")}</Alert>
            ) : null}
            <div className="mk-inventory-actions">
              <Button
                variant={
                  selection.action === "void_scan" || selection.action === "invalidate_box"
                    ? "destructive"
                    : "primary"
                }
                disabled={
                  !reason.trim() ||
                  new TextEncoder().encode(reason.trim()).byteLength > 1024 ||
                  (selection.action === "change_date" && observedProductionDate.length === 0)
                }
                loading={correction.isPending}
                onClick={submit}
              >
                {t(`pages.inventory.corrections.action.${selection.action}`)}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </AdminPage>
  );
}

function CorrectionEvent({
  event,
  onSelect,
}: {
  event: InventoryEvidenceEvent;
  onSelect: (selection: Selection) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <li>
      <span>
        <strong className="mk-inventory-mono">{event.displayIdentity}</strong>
        {event.observedProductionDate ? (
          <small>
            {t("pages.inventory.corrections.productionDate", {
              date: formatDate(event.observedProductionDate, i18n.language),
            })}
          </small>
        ) : null}
        <small>{event.terminalName}</small>
      </span>
      <div className="mk-inventory-correction-list__actions">
        {event.actions.map((action, index) => (
          <Button
            key={action}
            size="compact"
            variant={action === "remove_item" ? "destructive-outline" : "secondary"}
            aria-label={
              index === 0
                ? t("pages.inventory.corrections.select", { identity: event.displayIdentity })
                : undefined
            }
            onClick={() => {
              const target =
                action === "void_scan" || action === "restore_scan"
                  ? { eventId: event.eventId }
                  : { codeResultId: event.codeResultId! };
              onSelect({
                action,
                target,
                identity: event.displayIdentity,
                observedProductionDate: event.observedProductionDate,
              });
            }}
          >
            {t(`pages.inventory.corrections.action.${action}`)}
          </Button>
        ))}
      </div>
    </li>
  );
}

function CorrectionBox({
  box,
  onSelect,
}: {
  box: InventoryLiveBox;
  onSelect: (selection: Selection) => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <span>
        <strong className="mk-inventory-mono mk-inventory-mono--sscc">{box.sscc}</strong>
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
