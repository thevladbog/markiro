import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card } from "@markiro/ui";

import { HostStatusLine } from "../../app/HostStatusLine.js";
import type { FloorSession } from "../../app/shell.js";
import { FACT_RECEIPT_CODES, type HostStatus } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { waitUnits } from "../outbox-status.js";
import { VIEW_GUARD_MS } from "../print/LabelPanel.js";
import { formatQuantity } from "../shifts/shift-text.js";
import {
  dismissRecord,
  readQueue,
  resendRefused,
  StaleQueueError,
  UnreadableRecordError,
  type QueueView,
  type SettledRecord,
} from "./outbox-recovery.js";

export interface QueueScreenProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The operator signed in: a decision on the queue is theirs (`resolved_by`). */
  operator: FloorSession;
  link: HostStatus | null;
  /** `ShellState.outboxVersion`: the queue is read again after every write and batch of receipts. */
  outboxVersion?: number;
  /** The outbox changed: the status bar counts again, and the outbox goes. */
  onChanged: () => void;
  onBack: () => void;
  newId?: () => string;
  now?: () => Date;
  /** Milliseconds from a clock that does not go back; the guard after a question opens reads it. */
  clock?: () => number;
}

/** What a person is asked: the refused records of a shift, or one record, by id. */
type Pending = { kind: "resend"; shiftId: string } | { kind: "dismiss"; recordId: string };

type NoticeKind = "resent" | "dismissed" | "settled" | "stale" | "unreadable" | "local";
/** `id` tells two notices of one kind apart: each takes the focus. */
interface Notice {
  kind: NoticeKind;
  id: number;
}

const KINDS: ReadonlySet<string> = new Set([
  "scan",
  "box_closed",
  "box_label",
  "box_exception",
  "shift_closed",
  "pallet_closed",
  "pallet_label",
  "pallet_exception",
]);
const CODES: ReadonlySet<string> = new Set(FACT_RECEIPT_CODES);
/** Day, month, hours and minutes on this computer's clock. */
const MOMENT = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const realClock = () => performance.now();

function kindText(t: TFunction, kind: string): string {
  return KINDS.has(kind) ? t(`floor.queue.kind.${kind}`) : kind;
}

function reasonText(t: TFunction, record: SettledRecord): string {
  if (record.outcome === "conflict") return t("floor.queue.conflictReason");
  if (record.code !== null && CODES.has(record.code)) return t(`floor.queue.code.${record.code}`);
  return t("floor.queue.code.other", { code: record.code ?? "—" });
}

function waitText(t: TFunction, ms: number): string {
  const parts = waitUnits(ms);
  return parts.length === 0
    ? t("floor.status.wait.none")
    : parts.map((part) => t(`floor.status.wait.${part.unit}`, { n: part.n })).join(" ");
}

function recordText(t: TFunction, record: SettledRecord): string {
  const kind = kindText(t, record.kind);
  const time = MOMENT.format(new Date(record.createdAt));
  return record.sscc === null
    ? t("floor.queue.record", { kind, time })
    : t("floor.queue.recordSscc", { kind, sscc: record.sscc, time });
}

interface ShiftGroup {
  shiftId: string;
  shiftNumber: string | null;
  records: SettledRecord[];
}

/** The refused records of each shift, in the order they were kept; the shift of the oldest first. */
function byShift(records: readonly SettledRecord[]): ShiftGroup[] {
  const groups = new Map<string, ShiftGroup>();
  for (const record of records) {
    const group = groups.get(record.shiftId);
    if (group === undefined) {
      groups.set(record.shiftId, {
        shiftId: record.shiftId,
        shiftNumber: record.shiftNumber,
        records: [record],
      });
    } else {
      group.records.push(record);
    }
  }
  return [...groups.values()];
}

/** How many records of each kind a shift's group holds, as words: «Скан — 2, Закрытие смены — 1». */
function kindsText(t: TFunction, records: readonly SettledRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, n]) =>
      t("floor.queue.kindCount", { kind: kindText(t, kind), n: formatQuantity(n) }),
    )
    .join(", ");
}

/**
 * «Очередь отправки» (pilot spec §9.3, plan ОЧ): the link; this pairing's
 * records waiting for the host by kind, with how long the oldest waited; its
 * refused records by shift, each with its reason in words, and its conflicts —
 * never a code of marking, the SSCC of the box or pallet only; and the records
 * an older pairing left, which are read only (they cannot be sent from here).
 * A person resolves them: «Отправить снова» sends a shift's refused records
 * again, «Снять с очереди» takes a refused record off (never a close), and
 * «Разобрано» settles a conflict — each only after a confirmation that says
 * what is done to what and what follows, which takes the focus (Escape and
 * «Отмена» leave it, giving the focus back) and ignores a press for
 * `VIEW_GUARD_MS` after it opens, since the second tap of a double tap would
 * otherwise land on a button that cannot be taken back. The question is kept
 * as the record or shift it names and is shown with what the queue holds now:
 * one whose target is gone closes and says the queue changed.
 *
 * Opened from the shift list, so no work of a shift is running: its writes do
 * not go through the work screen's queue. A decision that lost a race with
 * another says so and the list is read again; a decision the operator left the
 * screen before it was written still tells the status bar.
 */
export function QueueScreen({
  local,
  pairing,
  operator,
  link,
  outboxVersion = 0,
  onChanged,
  onBack,
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
  clock = realClock,
}: QueueScreenProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [queue, setQueue] = useState<QueueView | "loading" | "failed">("loading");
  const [reads, setReads] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const backRef = useRef<HTMLDivElement | null>(null);
  // The button that asked the question: the focus goes back to it when the question is dropped.
  const askedBy = useRef<HTMLElement | null>(null);
  // When the question last opened: presses on it are ignored for `VIEW_GUARD_MS` after.
  const askedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  // The guard of one decision at a time: two presses in one turn both pass a
  // check of `busy`, which only the next render changes.
  const running = useRef(false);
  const noticeCount = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    readQueue(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setQueue(next);
      },
      () => {
        if (!cancelled) setQueue("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, reads, outboxVersion]);

  const view = typeof queue === "object" ? queue : null;
  const refused =
    view === null ? [] : view.settled.filter((record) => record.outcome === "rejected");
  const conflicts =
    view === null ? [] : view.settled.filter((record) => record.outcome === "conflict");
  const groups = byShift(refused);

  // What the question names, as the queue holds it now: `null` when it is gone.
  const resending =
    pending?.kind === "resend" ? (groups.find((g) => g.shiftId === pending.shiftId) ?? null) : null;
  const dismissing =
    pending?.kind === "dismiss"
      ? (view?.settled.find((record) => record.id === pending.recordId) ?? null)
      : null;
  const targetGone =
    pending !== null && queue !== "loading" && resending === null && dismissing === null;
  const unreadable = queue === "failed";

  const say = useCallback((kind: NoticeKind) => {
    noticeCount.current += 1;
    setNotice({ kind, id: noticeCount.current });
  }, []);

  useEffect(() => {
    if (pending !== null && !targetGone) confirmRef.current?.focus();
  }, [pending, targetGone]);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  // The record or the shift the operator was asked about was resolved
  // meanwhile (the list was read again): drop the question, and say so. A
  // queue that cannot be read says that itself.
  useEffect(() => {
    if (!targetGone || busy) return;
    setPending(null);
    if (!unreadable) say("stale");
  }, [targetGone, unreadable, busy, say]);

  const ask = (step: Pending, from: HTMLElement) => {
    askedAt.current = clock();
    askedBy.current = from;
    setPending(step);
  };

  const cancel = () => {
    setPending(null);
    const opener = askedBy.current;
    (opener?.isConnected === true ? opener : backRef.current?.querySelector("button"))?.focus();
  };

  const decide = async (step: Pending) => {
    if (running.current) return;
    const since = clock() - askedAt.current;
    if (since >= 0 && since < VIEW_GUARD_MS) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    const context = { local, pairing: { hostId, deviceId }, operatorId: operator.id, newId, now };
    let outcome: NoticeKind;
    try {
      if (step.kind === "resend") {
        await resendRefused(context, step.shiftId);
        outcome = "resent";
      } else {
        await dismissRecord(context, step.recordId);
        outcome = dismissing?.outcome === "conflict" ? "settled" : "dismissed";
      }
    } catch (error) {
      outcome =
        error instanceof StaleQueueError
          ? "stale"
          : error instanceof UnreadableRecordError
            ? "unreadable"
            : "local";
    }
    running.current = false;
    // A part already written still counts, and so does a decision written after
    // the operator left: the bar reads again either way.
    onChanged();
    if (!alive.current) return;
    say(outcome);
    setPending(null);
    setBusy(false);
    setReads((count) => count + 1);
  };

  const press = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) cancel();
  };

  return (
    <Card className="standalone-card shift-list" title={t("floor.queue.title")} titleAs="h2">
      <div className="standalone-form">
        <HostStatusLine status={link} sync={null} />
        <div className="floor-sign-in__message floor-sign-in__message--stack" aria-live="polite">
          {notice !== null && (
            <p ref={noticeRef} tabIndex={-1}>
              {t(`floor.queue.notice.${notice.kind}`)}
            </p>
          )}
        </div>
        {queue === "loading" && <p>{t("floor.queue.loading")}</p>}
        {queue === "failed" && (
          <>
            <p>{t("floor.queue.readFailed")}</p>
            <Button size="floor" variant="secondary" onClick={() => setReads((count) => count + 1)}>
              {t("floor.queue.retry")}
            </Button>
          </>
        )}
        {view !== null && (
          <>
            <section aria-labelledby="floor-queue-unsent">
              <h3 id="floor-queue-unsent">{t("floor.queue.unsentTitle")}</h3>
              {view.unsent.length === 0 ? (
                <p>{t("floor.queue.unsentNone")}</p>
              ) : (
                <dl>
                  {view.unsent.map((group) => (
                    <div key={group.kind} className="floor-status__item">
                      <dt>{kindText(t, group.kind)}</dt>
                      <dd>
                        {t("floor.queue.unsentValue", {
                          n: formatQuantity(group.count),
                          age: waitText(t, Math.max(0, now().getTime() - Date.parse(group.oldest))),
                        })}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
            {view.stranded > 0 && (
              <Alert tone="warn">
                {t("floor.queue.stranded", { n: formatQuantity(view.stranded) })}
              </Alert>
            )}
            <section aria-labelledby="floor-queue-refused">
              <h3 id="floor-queue-refused">{t("floor.queue.refusedTitle")}</h3>
              {groups.length === 0 ? (
                <p>{t("floor.queue.refusedNone")}</p>
              ) : (
                groups.map((group) => (
                  <section key={group.shiftId} className="shift-card">
                    <h4>{t("floor.queue.shift", { number: group.shiftNumber ?? "—" })}</h4>
                    <ul>
                      {group.records.map((record) => (
                        <li key={record.id}>
                          <p>{recordText(t, record)}</p>
                          <p>{reasonText(t, record)}</p>
                          {record.kind !== "shift_closed" && (
                            <Button
                              size="floor"
                              variant="secondary"
                              disabled={busy}
                              onClick={(event) =>
                                ask({ kind: "dismiss", recordId: record.id }, event.currentTarget)
                              }
                            >
                              {t("floor.queue.dismiss")}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <Button
                      size="floor"
                      disabled={busy}
                      onClick={(event) =>
                        ask({ kind: "resend", shiftId: group.shiftId }, event.currentTarget)
                      }
                    >
                      {t("floor.queue.resend")}
                    </Button>
                  </section>
                ))
              )}
            </section>
            <section aria-labelledby="floor-queue-conflicts">
              <h3 id="floor-queue-conflicts">{t("floor.queue.conflictsTitle")}</h3>
              {conflicts.length === 0 ? (
                <p>{t("floor.queue.conflictsNone")}</p>
              ) : (
                <ul>
                  {conflicts.map((record) => (
                    <li key={record.id}>
                      <p>
                        {t("floor.queue.shift", { number: record.shiftNumber ?? "—" })} ·{" "}
                        {recordText(t, record)}
                      </p>
                      <p>{reasonText(t, record)}</p>
                      <Button
                        size="floor"
                        variant="secondary"
                        disabled={busy}
                        onClick={(event) =>
                          ask({ kind: "dismiss", recordId: record.id }, event.currentTarget)
                        }
                      >
                        {t("floor.queue.settle")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {pending !== null && (resending !== null || dismissing !== null) && (
          <div
            ref={confirmRef}
            tabIndex={-1}
            role="group"
            aria-label={t("floor.queue.confirmLabel")}
            onKeyDown={press}
          >
            {resending !== null ? (
              <>
                <p>
                  {t("floor.queue.confirmResend", { n: formatQuantity(resending.records.length) })}
                </p>
                <p>
                  {t("floor.queue.confirmResendWhat", {
                    number: resending.shiftNumber ?? "—",
                    kinds: kindsText(t, resending.records),
                  })}
                </p>
              </>
            ) : dismissing !== null ? (
              <>
                <p>
                  {t("floor.queue.confirmRecord", {
                    record: recordText(t, dismissing),
                    reason: reasonText(t, dismissing),
                  })}
                </p>
                <p>
                  {t(
                    dismissing.outcome === "conflict"
                      ? "floor.queue.confirmSettle"
                      : "floor.queue.confirmDismiss",
                  )}
                </p>
              </>
            ) : null}
            <div className="standalone-form__actions">
              <Button
                size="floor"
                variant={
                  dismissing !== null && dismissing.outcome === "rejected"
                    ? "destructive"
                    : "primary"
                }
                disabled={busy}
                onClick={() => void decide(pending)}
              >
                {resending !== null
                  ? t("floor.queue.resendConfirm")
                  : dismissing?.outcome === "conflict"
                    ? t("floor.queue.settleConfirm")
                    : t("floor.queue.dismissConfirm")}
              </Button>
              <Button size="floor" variant="secondary" disabled={busy} onClick={cancel}>
                {t("floor.queue.cancel")}
              </Button>
            </div>
          </div>
        )}
        <div ref={backRef} className="standalone-form__actions">
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t("floor.queue.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
