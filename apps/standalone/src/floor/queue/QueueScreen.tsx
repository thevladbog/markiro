import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button, StatusChip } from "@markiro/ui";

import { HostStatusLine } from "../../app/HostStatusLine.js";
import type { FloorSession } from "../../app/shell.js";
import { FACT_KINDS, FACT_RECEIPT_CODES, type HostStatus } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { waitUnits } from "../outbox-status.js";
import { VIEW_GUARD_MS } from "../print/LabelPanel.js";
import { FloorFooter, FloorScreen } from "../shifts/FloorScreen.js";
import { formatQuantity } from "../shifts/shift-text.js";
import {
  dismissRecord,
  dismissShiftRefusals,
  readQueue,
  resendRefused,
  StaleQueueError,
  UnreadableRecordError,
  type QueueView,
  type SettledRecord,
  type SettledTally,
} from "./outbox-recovery.js";
import "./queue.css";

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

/**
 * What a person is asked: the refused records of a shift sent again or all
 * taken off but its close, or one record, by id.
 */
type Pending =
  | { kind: "resend"; shiftId: string }
  | { kind: "dismissShift"; shiftId: string }
  | { kind: "dismiss"; recordId: string };

type NoticeKind =
  "resent" | "dismissed" | "dismissedShift" | "settled" | "stale" | "unreadable" | "local";
/** `id` tells two notices of one kind apart: each takes the focus. */
interface Notice {
  kind: NoticeKind;
  id: number;
}

const KINDS: ReadonlySet<string> = new Set(FACT_KINDS);
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
  /** The records listed: at most `QUEUE_LISTED_PER_SHIFT`. */
  records: SettledRecord[];
  /** Every unresolved refused record of the shift, by kind, in the order of the first listed. */
  kinds: SettledTally[];
  /** How many refused records the shift holds: listed or not. */
  total: number;
  /** How many of them one decision takes off: every one but the close. */
  dismissible: number;
  /** Whether the shift's close is among them: it stays when the rest are taken off. */
  closeRefused: boolean;
}

/**
 * The listed refused records of each shift, in the order they were kept, the
 * shift of the oldest first, with the counts of all of them. The counts are
 * another read than the list: a shift is never counted below what it lists.
 */
function byShift(
  records: readonly SettledRecord[],
  tallies: readonly SettledTally[],
): ShiftGroup[] {
  const groups = new Map<string, ShiftGroup>();
  for (const record of records) {
    const group = groups.get(record.shiftId);
    if (group === undefined) {
      groups.set(record.shiftId, {
        shiftId: record.shiftId,
        shiftNumber: record.shiftNumber,
        records: [record],
        kinds: [],
        total: 0,
        dismissible: 0,
        closeRefused: false,
      });
    } else {
      group.records.push(record);
    }
  }
  for (const group of groups.values()) {
    const order = [...new Set(group.records.map((record) => record.kind))];
    group.kinds = tallies
      .filter((tally) => tally.shiftId === group.shiftId && tally.outcome === "rejected")
      .sort((a, b) => rank(order, a.kind) - rank(order, b.kind) || a.kind.localeCompare(b.kind));
    const counted = group.kinds.reduce((sum, tally) => sum + tally.count, 0);
    group.total = Math.max(counted, group.records.length);
    group.dismissible = group.kinds
      .filter((tally) => tally.kind !== "shift_closed")
      .reduce((sum, tally) => sum + tally.count, 0);
    group.closeRefused = group.kinds.some((tally) => tally.kind === "shift_closed");
  }
  return [...groups.values()];
}

/** A kind listed first comes first; one not listed at all, after every listed one. */
function rank(order: readonly string[], kind: string): number {
  const at = order.indexOf(kind);
  return at < 0 ? order.length : at;
}

/** How many records of each kind, as words: «Скан — 2, Закрытие смены — 1». */
function kindsText(t: TFunction, kinds: readonly SettledTally[]): string {
  return kinds
    .map((tally) =>
      t("floor.queue.kindCount", { kind: kindText(t, tally.kind), n: formatQuantity(tally.count) }),
    )
    .join(", ");
}

/** How many conflicts the list leaves out: each shift's count beyond the ones it lists. */
function conflictsBeyond(
  listed: readonly SettledRecord[],
  tallies: readonly SettledTally[],
): number {
  const counted = new Map<string, number>();
  for (const tally of tallies) {
    if (tally.outcome !== "conflict") continue;
    counted.set(tally.shiftId, (counted.get(tally.shiftId) ?? 0) + tally.count);
  }
  const shown = new Map<string, number>();
  for (const record of listed) shown.set(record.shiftId, (shown.get(record.shiftId) ?? 0) + 1);
  let beyond = 0;
  for (const [shiftId, n] of counted) beyond += Math.max(0, n - (shown.get(shiftId) ?? 0));
  return beyond;
}

/**
 * «Очередь отправки» (pilot spec §9.3, plan ОЧ): the link; this pairing's
 * records waiting for the host by kind, with how long the oldest waited; its
 * refused records by shift, each with its reason in words, and its conflicts —
 * never a code of marking, the SSCC of the box or pallet only; and the records
 * an older pairing left, which are read only (they cannot be sent from here).
 * Each shift lists its first `QUEUE_LISTED_PER_SHIFT` refused records and
 * says how many more there are («и ещё N»; the conflicts the same way), so a
 * shift a restored host refuses whole stays readable.
 * A person resolves them: «Отправить снова» sends a shift's refused records
 * again, «Снять с очереди» takes a refused record off (never a close),
 * «Снять с очереди все отказы смены» takes off every refused record of the
 * shift but its close in one decision that names how many, and
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
  const groups = byShift(refused, view?.tallies ?? []);
  const conflictsHidden = view === null ? 0 : conflictsBeyond(conflicts, view.tallies);

  // What the question names, as the queue holds it now: `null` when it is gone.
  const resending =
    pending?.kind === "resend" ? (groups.find((g) => g.shiftId === pending.shiftId) ?? null) : null;
  const clearing =
    pending?.kind === "dismissShift"
      ? (groups.find((g) => g.shiftId === pending.shiftId && g.dismissible > 0) ?? null)
      : null;
  const dismissing =
    pending?.kind === "dismiss"
      ? (view?.settled.find((record) => record.id === pending.recordId) ?? null)
      : null;
  const targetGone =
    pending !== null &&
    queue !== "loading" &&
    resending === null &&
    clearing === null &&
    dismissing === null;
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
      } else if (step.kind === "dismissShift") {
        // The number the confirmation names: any other number now writes nothing.
        await dismissShiftRefusals(context, step.shiftId, clearing?.dismissible ?? 0);
        outcome = "dismissedShift";
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

  const confirmation =
    pending !== null && (resending !== null || clearing !== null || dismissing !== null) ? (
      <div
        ref={confirmRef}
        tabIndex={-1}
        role="group"
        aria-label={t("floor.queue.confirmLabel")}
        className="floor-queue__confirm"
        onKeyDown={press}
      >
        <div className="floor-queue__confirm-text">
          {resending !== null ? (
            <>
              <p>{t("floor.queue.confirmResend", { n: formatQuantity(resending.total) })}</p>
              <p>
                {t("floor.queue.confirmResendWhat", {
                  number: resending.shiftNumber ?? "—",
                  kinds: kindsText(t, resending.kinds),
                })}
              </p>
            </>
          ) : clearing !== null ? (
            <>
              <p>
                {t("floor.queue.confirmDismissShift", {
                  number: clearing.shiftNumber ?? "—",
                  n: formatQuantity(clearing.dismissible),
                })}
              </p>
              <p>
                {t("floor.queue.confirmResendWhat", {
                  number: clearing.shiftNumber ?? "—",
                  kinds: kindsText(
                    t,
                    clearing.kinds.filter((tally) => tally.kind !== "shift_closed"),
                  ),
                })}
              </p>
              {clearing.closeRefused && <p>{t("floor.queue.confirmDismissShiftClose")}</p>}
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
        </div>
        <div className="floor-queue__confirm-actions">
          <Button size="floor" variant="secondary" disabled={busy} onClick={cancel}>
            {t("floor.queue.cancel")}
          </Button>
          <Button
            size="floor"
            variant={
              clearing !== null || (dismissing !== null && dismissing.outcome === "rejected")
                ? "destructive"
                : "primary"
            }
            disabled={busy}
            onClick={() => void decide(pending)}
          >
            {resending !== null
              ? t("floor.queue.resendConfirm")
              : clearing !== null
                ? t("floor.queue.dismissShiftConfirm", {
                    n: formatQuantity(clearing.dismissible),
                  })
                : dismissing?.outcome === "conflict"
                  ? t("floor.queue.settleConfirm")
                  : t("floor.queue.dismissConfirm")}
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <FloorScreen
      className="floor-queue"
      title={t("floor.queue.title")}
      header={<HostStatusLine status={link} sync={null} />}
      actions={
        <FloorFooter ariaLabel={t("floor.queue.actions")}>
          <div ref={backRef}>
            <Button size="floor" variant="secondary" onClick={onBack}>
              {t("floor.queue.back")}
            </Button>
          </div>
        </FloorFooter>
      }
    >
      <div className="floor-queue__body">
        <div className="floor-queue__message" aria-live="polite">
          {notice !== null && (
            <p ref={noticeRef} tabIndex={-1}>
              {t(`floor.queue.notice.${notice.kind}`)}
            </p>
          )}
        </div>
        <div className="floor-queue__scroll">
          {queue === "loading" && <p className="floor-queue__quiet">{t("floor.queue.loading")}</p>}
          {queue === "failed" && (
            <div className="floor-queue__failed">
              <p>{t("floor.queue.readFailed")}</p>
              <Button
                size="floor"
                variant="secondary"
                onClick={() => setReads((count) => count + 1)}
              >
                {t("floor.queue.retry")}
              </Button>
            </div>
          )}
          {view !== null && (
            <>
              <section className="floor-queue__section" aria-labelledby="floor-queue-unsent">
                <h3 id="floor-queue-unsent">{t("floor.queue.unsentTitle")}</h3>
                {view.unsent.length === 0 ? (
                  <p className="floor-queue__quiet">{t("floor.queue.unsentNone")}</p>
                ) : (
                  <dl className="floor-queue__card floor-queue__unsent">
                    {view.unsent.map((group) => (
                      <div key={group.kind} className="floor-queue__row">
                        <dt>{kindText(t, group.kind)}</dt>
                        <dd>
                          {t("floor.queue.unsentValue", {
                            n: formatQuantity(group.count),
                            age: waitText(
                              t,
                              Math.max(0, now().getTime() - Date.parse(group.oldest)),
                            ),
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
              <section className="floor-queue__section" aria-labelledby="floor-queue-refused">
                <h3 id="floor-queue-refused">{t("floor.queue.refusedTitle")}</h3>
                {groups.length === 0 ? (
                  <p className="floor-queue__quiet">{t("floor.queue.refusedNone")}</p>
                ) : (
                  groups.map((group) => (
                    <section
                      key={group.shiftId}
                      className="floor-queue__card"
                      aria-label={t("floor.queue.shift", { number: group.shiftNumber ?? "—" })}
                    >
                      <div className="floor-queue__card-head">
                        <h4>{t("floor.queue.shift", { number: group.shiftNumber ?? "—" })}</h4>
                        <StatusChip
                          size="floor"
                          phase="failed"
                          label={t("floor.queue.chip.refused", {
                            n: formatQuantity(group.total),
                          })}
                        />
                      </div>
                      <ul className="floor-queue__records">
                        {group.records.map((record) => (
                          <li key={record.id} className="floor-queue__record">
                            <div className="floor-queue__record-text">
                              <p className="floor-queue__identity">{recordText(t, record)}</p>
                              <p className="floor-queue__reason">{reasonText(t, record)}</p>
                            </div>
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
                      {group.total > group.records.length && (
                        <p className="floor-queue__quiet">
                          {t("floor.queue.more", {
                            n: formatQuantity(group.total - group.records.length),
                          })}
                        </p>
                      )}
                      <div className="floor-queue__card-actions">
                        {group.dismissible > 0 && (
                          <Button
                            size="floor"
                            variant="secondary"
                            disabled={busy}
                            onClick={(event) =>
                              ask(
                                { kind: "dismissShift", shiftId: group.shiftId },
                                event.currentTarget,
                              )
                            }
                          >
                            {t("floor.queue.dismissShift")}
                          </Button>
                        )}
                        <Button
                          size="floor"
                          disabled={busy}
                          onClick={(event) =>
                            ask({ kind: "resend", shiftId: group.shiftId }, event.currentTarget)
                          }
                        >
                          {t("floor.queue.resend")}
                        </Button>
                      </div>
                    </section>
                  ))
                )}
              </section>
              <section className="floor-queue__section" aria-labelledby="floor-queue-conflicts">
                <h3 id="floor-queue-conflicts">{t("floor.queue.conflictsTitle")}</h3>
                {conflicts.length === 0 ? (
                  <p className="floor-queue__quiet">{t("floor.queue.conflictsNone")}</p>
                ) : (
                  <ul className="floor-queue__card floor-queue__records">
                    {conflicts.map((record) => (
                      <li key={record.id} className="floor-queue__record">
                        <div className="floor-queue__record-text">
                          <p className="floor-queue__identity">
                            {t("floor.queue.shift", { number: record.shiftNumber ?? "—" })} ·{" "}
                            {recordText(t, record)}
                          </p>
                          <p className="floor-queue__reason">{reasonText(t, record)}</p>
                        </div>
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
                {conflictsHidden > 0 && (
                  <p className="floor-queue__quiet">
                    {t("floor.queue.more", { n: formatQuantity(conflictsHidden) })}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        {confirmation}
      </div>
    </FloorScreen>
  );
}
