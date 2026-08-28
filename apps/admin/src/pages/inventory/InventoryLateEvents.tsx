import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Modal, Spinner, StatusChip, Textarea } from "@markiro/ui";

import {
  useDiscardInventoryLateEvents,
  useInventoryLateEvents,
  useReplayInventoryLateEvent,
  useReopenInventory,
} from "./api.js";

const MAX_SELECTED_LATE_EVENTS = 100;

export function InventoryLateEvents({
  inventoryId,
  inventoryStatus,
  open,
  onClose,
}: {
  inventoryId: string;
  inventoryStatus: "running" | "closed" | "completed";
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const events = useInventoryLateEvents(inventoryId, open, page);
  const discard = useDiscardInventoryLateEvents();
  const replay = useReplayInventoryLateEvent();
  const reopen = useReopenInventory();
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [reopenConfirmation, setReopenConfirmation] = useState(false);
  const [reopenSucceeded, setReopenSucceeded] = useState(false);
  const [replaySuccessBatchId, setReplaySuccessBatchId] = useState<string | null>(null);
  const readOnly = inventoryStatus === "completed";
  const canDiscard = inventoryStatus === "closed";
  const reasonBytes = new TextEncoder().encode(reason.trim()).byteLength;
  const reasonValid = reasonBytes > 0 && reasonBytes <= 4096;

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      if (!checked) return current.filter((value) => value !== id);
      if (current.includes(id) || current.length >= MAX_SELECTED_LATE_EVENTS) return current;
      return [...current, id];
    });
  };

  const discardSelected = () => {
    discard.mutate(
      { inventoryId, lateEventIds: selected, reason: reason.trim() },
      {
        onSuccess: () => {
          setSelected([]);
          setReason("");
        },
      },
    );
  };

  const reopenInventory = () => {
    reopen.mutate(inventoryId, {
      onSuccess: () => {
        setReopenConfirmation(false);
        setReopenSucceeded(true);
      },
    });
  };

  return (
    <Modal
      open={open}
      title={t("pages.inventory.late.title")}
      closeLabel={t("common.cancel")}
      onClose={onClose}
      width={720}
      footer={
        <>
          {inventoryStatus === "closed" ? (
            <Button
              variant="warning-outline"
              onClick={() => {
                setReopenSucceeded(false);
                setReopenConfirmation(true);
              }}
            >
              {t("pages.inventory.late.reopen")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </>
      }
    >
      <div className="mk-inventory-late-events">
        {readOnly ? <Alert tone="info">{t("pages.inventory.late.readOnly")}</Alert> : null}
        {reopenSucceeded ? (
          <Alert tone="ok">{t("pages.inventory.late.reopenSuccess")}</Alert>
        ) : null}
        {reopenConfirmation ? (
          <div className="mk-inventory-late-decision">
            <Alert tone="warn">{t("pages.inventory.close.reopenExplanation")}</Alert>
            {reopen.isError ? (
              <Alert tone="error">{t("pages.inventory.late.actionError")}</Alert>
            ) : null}
            <div className="mk-inventory-actions">
              <Button variant="secondary" onClick={() => setReopenConfirmation(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="warning-outline"
                loading={reopen.isPending}
                onClick={reopenInventory}
              >
                {t("pages.inventory.close.reopenConfirm")}
              </Button>
            </div>
          </div>
        ) : null}
        {events.isPending ? <Spinner label={t("pages.inventory.late.loading")} /> : null}
        {events.isError ? <Alert tone="error">{t("pages.inventory.late.loadError")}</Alert> : null}
        {events.data?.items.length === 0 ? (
          <p className="mk-inventory-section-description">{t("pages.inventory.late.empty")}</p>
        ) : null}
        {events.data && events.data.items.length > 0 ? (
          <ul className="mk-inventory-late-list">
            {events.data.items.map((event) => {
              const canDecide = canDiscard && event.resolution === "pending";
              const selectionDisabled =
                !selected.includes(event.id) && selected.length >= MAX_SELECTED_LATE_EVENTS;
              return (
                <li key={event.id}>
                  {canDecide ? (
                    <Checkbox
                      aria-label={t("pages.inventory.late.select", { batchId: event.batchId })}
                      label=""
                      checked={selected.includes(event.id)}
                      disabled={selectionDisabled}
                      onCheckedChange={(checked) => toggle(event.id, checked)}
                    />
                  ) : null}
                  <span className="mk-inventory-late-list__main">
                    <strong>{event.terminalName}</strong>
                    <small className="mk-inventory-mono">{event.batchId}</small>
                    <small>
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: "short",
                        timeStyle: "short",
                      }).format(new Date(event.receivedAt))}
                    </small>
                  </span>
                  <span className="mk-inventory-late-list__state">
                    <strong>{t("pages.inventory.late.events", { count: event.eventCount })}</strong>
                    <StatusChip
                      status={event.resolution === "pending" ? "warn" : "neutral"}
                      label={t(`pages.inventory.late.resolution.${event.resolution}`)}
                    />
                    {inventoryStatus === "running" && event.replayAvailable ? (
                      <Button
                        size="compact"
                        variant="secondary"
                        loading={replay.isPending && replay.variables?.lateEventId === event.id}
                        onClick={() => {
                          setReplaySuccessBatchId(null);
                          replay.mutate(
                            { inventoryId, lateEventId: event.id },
                            { onSuccess: () => setReplaySuccessBatchId(event.batchId) },
                          );
                        }}
                      >
                        {t("pages.inventory.late.replay", { batchId: event.batchId })}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {events.data && (events.data.page > 1 || events.data.hasMore) ? (
          <div className="mk-inventory-actions">
            <Button
              size="compact"
              variant="secondary"
              disabled={events.data.page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t("pages.inventory.late.previous")}
            </Button>
            <span>{t("pages.inventory.late.page", { page: events.data.page })}</span>
            <Button
              size="compact"
              variant="secondary"
              disabled={!events.data.hasMore}
              onClick={() => setPage((current) => current + 1)}
            >
              {t("pages.inventory.late.next")}
            </Button>
          </div>
        ) : null}
        {selected.length >= MAX_SELECTED_LATE_EVENTS ? (
          <Alert tone="info">{t("pages.inventory.late.selectionLimit")}</Alert>
        ) : null}
        {replay.isError ? (
          <Alert tone="error">{t("pages.inventory.late.replayError")}</Alert>
        ) : null}
        {replaySuccessBatchId ? (
          <Alert tone="ok">
            {t("pages.inventory.late.replaySuccess", { batchId: replaySuccessBatchId })}
          </Alert>
        ) : null}
        {canDiscard && selected.length > 0 ? (
          <div className="mk-inventory-late-decision">
            <Textarea
              label={t("pages.inventory.late.reason")}
              value={reason}
              required
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            {reasonBytes > 4096 ? (
              <Alert tone="error">{t("pages.inventory.late.reasonTooLong")}</Alert>
            ) : null}
            {discard.isError ? (
              <Alert tone="error">{t("pages.inventory.late.actionError")}</Alert>
            ) : null}
            <Button
              variant="destructive-outline"
              disabled={!reasonValid || selected.length > MAX_SELECTED_LATE_EVENTS}
              loading={discard.isPending}
              onClick={discardSelected}
            >
              {t("pages.inventory.late.discard")}
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
