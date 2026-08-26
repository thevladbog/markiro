import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Modal, Spinner, StatusChip, Textarea } from "@markiro/ui";

import {
  useDiscardInventoryLateEvents,
  useInventoryLateEvents,
  useReopenInventory,
} from "./api.js";

export function InventoryLateEvents({
  inventoryId,
  inventoryStatus,
  open,
  onClose,
}: {
  inventoryId: string;
  inventoryStatus: "closed" | "completed";
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const events = useInventoryLateEvents(inventoryId, open, page);
  const discard = useDiscardInventoryLateEvents();
  const reopen = useReopenInventory();
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const readOnly = inventoryStatus === "completed";
  const reasonBytes = new TextEncoder().encode(reason.trim()).byteLength;
  const reasonValid = reasonBytes > 0 && reasonBytes <= 4096;

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) =>
      checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
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

  return (
    <Modal
      open={open}
      title={t("pages.inventory.late.title")}
      closeLabel={t("common.cancel")}
      onClose={onClose}
      width={720}
      footer={
        <>
          {!readOnly ? (
            <Button
              variant="warning-outline"
              loading={reopen.isPending}
              onClick={() => reopen.mutate(inventoryId)}
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
        {events.isPending ? <Spinner label={t("pages.inventory.late.loading")} /> : null}
        {events.isError ? <Alert tone="error">{t("pages.inventory.late.loadError")}</Alert> : null}
        {events.data?.items.length === 0 ? (
          <p className="mk-inventory-section-description">{t("pages.inventory.late.empty")}</p>
        ) : null}
        {events.data && events.data.items.length > 0 ? (
          <ul className="mk-inventory-late-list">
            {events.data.items.map((event) => {
              const canDecide = !readOnly && event.resolution === "pending";
              return (
                <li key={event.id}>
                  {canDecide ? (
                    <Checkbox
                      aria-label={t("pages.inventory.late.select", { batchId: event.batchId })}
                      label=""
                      checked={selected.includes(event.id)}
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
        {!readOnly && selected.length > 0 ? (
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
              disabled={!reasonValid}
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
