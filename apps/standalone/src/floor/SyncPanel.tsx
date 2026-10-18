import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FullScreenDialog, StatusChip, type TagPhase } from "@markiro/ui";

import type { FactsFailure, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { reasonText, recordText } from "./queue/QueueScreen.js";
import {
  detailsText,
  factsFailureText,
  linkText,
  momentText,
  problemRecords,
  readSyncDetails,
  waitWords,
  type SyncDetails,
} from "./sync-details.js";
import type { ShiftStock } from "./outbox-status.js";
import { formatQuantity } from "./shifts/shift-text.js";
import { stockText } from "./stock-text.js";
import "./sync-panel.css";

export interface SyncPanelProps {
  open: boolean;
  onClose: () => void;
  local: LocalExecutor;
  pairing: Pairing;
  link: HostStatus | null;
  sync: SyncState;
  factsFailure: FactsFailure | null;
  /** The host refused this station and the refusal waits for the operator (`ShellState`). */
  refusalHeld: boolean;
  /** `ShellState.outboxVersion`: the panel reads again whenever it changes. */
  outboxVersion: number;
  /** When the reference sync last finished on this computer since the app started; `null` before. */
  lastSyncedAt: Date | null;
  /**
   * «Повторить сейчас»: asks for a reference sync and for the outbox to go
   * (`requestSync`, `requestFacts`). It starts no protocol of its own.
   */
  onRetry: () => void;
  /**
   * The SSCC serials left for the shift on screen (`readShiftStock`); `null`
   * outside a shift or where they cannot be read. The bar owns the read, so
   * the panel and the bar's low-stock chip say the same.
   */
  stock?: ShiftStock | null;
  /** This computer's clock; tests pin it. */
  now?: () => Date;
}

const LINK_PHASE: Readonly<Record<HostStatus["state"], TagPhase>> = {
  online: "active",
  connecting: "running",
  offline: "attention",
};

/** How often the open panel reads the queue again by itself. */
export const PANEL_REFRESH_MS = 5_000;

const systemClock = (): Date => new Date();

/**
 * «Синхронизация» (beta 3, after the cloud station's sync details,
 * `apps/station/src/ui/SyncDetailsDialog.tsx`): is the station connected to
 * the host, when the catalog last arrived, how many records wait to be sent,
 * and which the host refused or found in conflict, with the reason in words.
 * The data is the status bar's and the queue screen's (`readSyncDetails`); the
 * one action, «Повторить сейчас», asks the existing retries to run now. The
 * details can be copied as plain text.
 */
export function SyncPanel({
  open,
  onClose,
  local,
  pairing,
  link,
  sync,
  factsFailure,
  refusalHeld,
  outboxVersion,
  lastSyncedAt,
  onRetry,
  stock = null,
  now = systemClock,
}: SyncPanelProps) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<SyncDetails | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const [tick, setTick] = useState(0);
  const text = useRef<HTMLPreElement>(null);
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick((count) => count + 1), PANEL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setAsked(false);
      setCopy("idle");
      return;
    }
    let cancelled = false;
    readSyncDetails(local, { hostId, deviceId }, now()).then(
      (next) => {
        if (cancelled) return;
        setDetails(next);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, local, hostId, deviceId, outboxVersion, sync.synced, sync.kind, tick, now]);

  const summary = { link, sync, factsFailure, refusalHeld, lastSyncedAt, details };
  const plain = detailsText(t, summary, now());

  const copyDetails = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(plain);
      setCopy("done");
    } catch {
      // No clipboard in this window: the text below stays selectable.
      const node = text.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopy("failed");
    }
  }, [plain]);

  const linkState = refusalHeld && link !== null ? "offline" : (link?.state ?? null);
  const failure = factsFailureText(t, factsFailure);
  const { listed, more } =
    details === null ? { listed: [], more: 0 } : problemRecords(details.queue);
  const nothingWrong =
    details !== null &&
    failure === null &&
    sync.failure === null &&
    sync.quarantined === 0 &&
    details.outbox.rejected === 0 &&
    details.outbox.conflicts === 0 &&
    details.outbox.displaced === 0 &&
    details.queue.stranded === 0;

  return (
    <FullScreenDialog
      open={open}
      title={t("floor.sync.title")}
      backLabel={t("floor.sync.close")}
      onClose={onClose}
      footer={
        <div className="sync-panel__footer">
          <Button
            size="floor"
            variant="secondary"
            aria-label={t("floor.sync.copyLabel")}
            onClick={() => {
              void copyDetails();
            }}
          >
            {t("floor.sync.copy")}
          </Button>
          <Button
            size="floor"
            onClick={() => {
              setAsked(true);
              onRetry();
            }}
          >
            {t("floor.sync.retry")}
          </Button>
        </div>
      }
    >
      <div className="sync-panel" role="region" aria-label={t("floor.sync.title")}>
        <div className="sync-panel__notes" aria-live="polite">
          {asked && (
            <Alert tone="info" role="presentation">
              {t("floor.sync.asked")}
            </Alert>
          )}
          {copy === "done" && (
            <Alert tone="ok" role="presentation">
              {t("floor.sync.copied")}
            </Alert>
          )}
          {copy === "failed" && (
            <Alert tone="warn" role="presentation">
              {t("floor.sync.copyFailed")}
            </Alert>
          )}
          {failed && (
            <Alert tone="error" role="presentation">
              {t("floor.sync.readFailed")}
            </Alert>
          )}
          {nothingWrong && (
            <Alert tone="ok" role="presentation">
              {t("floor.sync.allWell")}
            </Alert>
          )}
        </div>

        <section className="sync-panel__section" aria-labelledby="sync-panel-link">
          <h3 id="sync-panel-link">{t("floor.sync.linkTitle")}</h3>
          <p>
            {linkState !== null && (
              <StatusChip
                phase={LINK_PHASE[linkState]}
                label={linkText(t, link, refusalHeld)}
                wrap
              />
            )}
            {linkState === null && linkText(t, link, refusalHeld)}
          </p>
          {link !== null && link.state !== "online" && link.lastError !== null && (
            <p className="sync-panel__reason">{t(`errors.link.${link.lastError}`)}</p>
          )}
          {link?.lastContactAt != null && link.state === "online" && (
            <p className="sync-panel__fact">
              {t("floor.sync.lastContact", { at: momentText(new Date(link.lastContactAt)) })}
            </p>
          )}
        </section>

        <section className="sync-panel__section" aria-labelledby="sync-panel-references">
          <h3 id="sync-panel-references">{t("floor.sync.referencesTitle")}</h3>
          <p>
            {lastSyncedAt === null
              ? t("floor.sync.notYetSynced")
              : t("floor.sync.syncedAt", { at: momentText(lastSyncedAt) })}
          </p>
          {sync.failure !== null && (
            <p className="sync-panel__reason">{t(`errors.sync.${sync.failure}`)}</p>
          )}
          {sync.quarantined > 0 && (
            <p className="sync-panel__reason">
              {t("link.quarantined", { n: sync.quarantined })}
              {" — "}
              {t("floor.sync.quarantinedHint")}
            </p>
          )}
        </section>

        <section className="sync-panel__section" aria-labelledby="sync-panel-queue">
          <h3 id="sync-panel-queue">{t("floor.sync.queueTitle")}</h3>
          {details === null ? (
            <p>{t(failed ? "floor.sync.queueUnreadable" : "floor.sync.loading")}</p>
          ) : (
            <>
              <p>{t("floor.sync.unsent", { n: formatQuantity(details.outbox.unsent) })}</p>
              {details.stuck !== null && (
                <p className="sync-panel__fact">
                  {t("floor.sync.oldest", {
                    age: waitWords(t, details.stuck.waitedMs),
                    attempts: formatQuantity(details.stuck.attempts),
                  })}
                </p>
              )}
              {failure !== null && <p className="sync-panel__reason">{failure}</p>}
              {details.outbox.rejected > 0 && (
                <p className="sync-panel__reason">
                  {t("floor.sync.rejected", { n: formatQuantity(details.outbox.rejected) })}
                </p>
              )}
              {details.outbox.conflicts > 0 && (
                <p className="sync-panel__reason">
                  {t("floor.sync.conflicts", { n: formatQuantity(details.outbox.conflicts) })}
                </p>
              )}
              {details.outbox.displaced > 0 && (
                <p className="sync-panel__reason">
                  {t("floor.sync.displaced", { n: formatQuantity(details.outbox.displaced) })}
                </p>
              )}
              {details.queue.stranded > 0 && (
                <p className="sync-panel__reason">
                  {t("floor.sync.stranded", { n: formatQuantity(details.queue.stranded) })}
                </p>
              )}
              {listed.length > 0 && (
                <ul className="sync-panel__records">
                  {listed.map((record) => (
                    <li key={record.id}>
                      <span className="sync-panel__record">
                        {record.shiftNumber === null
                          ? recordText(t, record)
                          : `${t("floor.sync.shift", { number: record.shiftNumber })} · ${recordText(t, record)}`}
                      </span>
                      <span className="sync-panel__why">{reasonText(t, record)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {more > 0 && (
                <p className="sync-panel__fact">
                  {t("floor.sync.moreRecords", { n: formatQuantity(more) })}
                </p>
              )}
              {(details.outbox.rejected > 0 ||
                details.outbox.conflicts > 0 ||
                details.outbox.displaced > 0) && (
                <p className="sync-panel__fact">{t("floor.sync.whereToFix")}</p>
              )}
            </>
          )}
        </section>

        {stock !== null && (
          <section className="sync-panel__section" aria-labelledby="sync-panel-stock">
            <h3 id="sync-panel-stock">{t("floor.sync.stockTitle")}</h3>
            <p>{t("floor.sync.stockBoxes", { n: formatQuantity(stock.boxes.left) })}</p>
            {stockText(t, "box", stock.boxes) !== null && (
              <p className="sync-panel__reason">{stockText(t, "box", stock.boxes)}</p>
            )}
            {stock.pallets !== null && (
              <>
                <p>{t("floor.sync.stockPallets", { n: formatQuantity(stock.pallets.left) })}</p>
                {stockText(t, "pallet", stock.pallets) !== null && (
                  <p className="sync-panel__reason">{stockText(t, "pallet", stock.pallets)}</p>
                )}
              </>
            )}
          </section>
        )}

        <section className="sync-panel__section" aria-labelledby="sync-panel-copy">
          <h3 id="sync-panel-copy">{t("floor.sync.copyTitle")}</h3>
          <pre ref={text} className="sync-panel__text">
            {plain}
          </pre>
        </section>
      </div>
    </FullScreenDialog>
  );
}
