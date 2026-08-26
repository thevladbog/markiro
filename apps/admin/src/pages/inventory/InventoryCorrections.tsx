import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { AdminPage, Alert, Button, Card, Input, Spinner, Textarea } from "@markiro/ui";

import { useCreateInventoryCorrection, useInventory, useInventoryProgress } from "./api.js";
import type {
  CreateInventoryCorrectionInput,
  InventoryLiveBox,
  InventoryRecentEvent,
} from "./schemas.js";

type CorrectionAction = CreateInventoryCorrectionInput["action"];
type CorrectionTarget = CreateInventoryCorrectionInput["target"];

interface Selection {
  action: CorrectionAction;
  target: CorrectionTarget;
  identity: string;
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function InventoryCorrections() {
  const { inventoryId = "" } = useParams();
  const { t } = useTranslation();
  const inventory = useInventory(inventoryId);
  const running = inventory.data?.status === "running";
  const progress = useInventoryProgress(inventoryId, running);
  const correction = useCreateInventoryCorrection();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reason, setReason] = useState("");
  const [observedProductionDate, setObservedProductionDate] = useState("");
  const [saved, setSaved] = useState(false);
  const idempotencyKey = useRef(newIdempotencyKey());

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

  if (progress.isPending) {
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("pages.inventory.live.loading")} />
      </div>
    );
  }

  if (progress.isError || !progress.data) {
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.live.loadError")}</Alert>
      </AdminPage>
    );
  }

  const select = (next: Selection) => {
    setSelection(next);
    setSaved(false);
    correction.reset();
    idempotencyKey.current = newIdempotencyKey();
  };

  const submit = () => {
    if (!selection || !reason.trim()) return;
    const input: CreateInventoryCorrectionInput = {
      action: selection.action,
      target: selection.target,
      reason,
      expectedResultRevision: progress.data.resultRevision,
      idempotencyKey: idempotencyKey.current,
      ...(selection.action === "change_date" ? { observedProductionDate } : {}),
    };
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

      <div className="mk-inventory-live__columns">
        <Card title={t("pages.inventory.corrections.events")} titleAs="h2">
          <ul className="mk-inventory-correction-list">
            {progress.data.recentEvents.map((event) => (
              <CorrectionEvent key={event.eventId} event={event} onSelect={select} />
            ))}
          </ul>
        </Card>
        <Card title={t("pages.inventory.corrections.boxes")} titleAs="h2">
          <ul className="mk-inventory-correction-list">
            {progress.data.boxes.map((box) => (
              <CorrectionBox key={box.id} box={box} onSelect={select} />
            ))}
          </ul>
        </Card>
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
              maxLength={1024}
              required
              onChange={(event) => setReason(event.currentTarget.value)}
            />
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
  event: InventoryRecentEvent;
  onSelect: (selection: Selection) => void;
}) {
  const { t } = useTranslation();
  const primaryAction: CorrectionAction =
    event.classification === "voided" ? "restore_scan" : "void_scan";
  const codeResultId = event.codeResultId;
  return (
    <li>
      <span>
        <strong className="mk-inventory-mono">{event.displayIdentity}</strong>
        <small>{event.terminalName}</small>
      </span>
      <div className="mk-inventory-correction-list__actions">
        <Button
          size="compact"
          variant="secondary"
          aria-label={t("pages.inventory.corrections.select", { identity: event.displayIdentity })}
          onClick={() =>
            onSelect({
              action: primaryAction,
              target: { eventId: event.eventId },
              identity: event.displayIdentity,
            })
          }
        >
          {t(`pages.inventory.corrections.action.${primaryAction}`)}
        </Button>
        {codeResultId ? (
          <>
            <Button
              size="compact"
              variant="secondary"
              onClick={() =>
                onSelect({
                  action: "change_date",
                  target: { codeResultId },
                  identity: event.displayIdentity,
                })
              }
            >
              {t("pages.inventory.corrections.action.change_date")}
            </Button>
            <Button
              size="compact"
              variant="destructive-outline"
              onClick={() =>
                onSelect({
                  action: "remove_item",
                  target: { codeResultId },
                  identity: event.displayIdentity,
                })
              }
            >
              {t("pages.inventory.corrections.action.remove_item")}
            </Button>
          </>
        ) : null}
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
              })
            }
          >
            {t("pages.inventory.corrections.action.invalidate_box")}
          </Button>
        ) : null}
        <Button
          size="compact"
          variant="secondary"
          onClick={() =>
            onSelect({
              action: "reprint",
              target: { repackBoxId: box.id },
              identity: box.sscc,
            })
          }
        >
          {t("pages.inventory.corrections.action.reprint")}
        </Button>
      </div>
    </li>
  );
}
