import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Pager } from "@markiro/ui";

import type { DeviceLicense, EnteredShift, ShiftEnter } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readRefusedCloses } from "../close/shift-close.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { FloorFooter, FloorScreen } from "./FloorScreen.js";
import { opensBlocked } from "../license.js";
import { cardAction, ShiftCard } from "./ShiftCard.js";

export interface ShiftListProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The station's line: the list shows its shifts. */
  lineId: string;
  /** The link to the host is online. */
  online: boolean;
  /** `ShellState.shiftReads`: the list reads its copies again after every read. */
  shiftReads: { done: number; failed: boolean };
  /**
   * `ShellState.outboxVersion`: the list reads its copies again after every
   * write and every batch of receipts, so a close the host took leaves it.
   */
  outboxVersion?: number;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string, enter: ShiftEnter) => Promise<EnteredShift>;
  onEntered: (shift: WorkShift) => void;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  onNew: () => void;
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
  /** The warehouse reprint (plan СКЛ); none — no button. */
  onWarehouse?: () => void;
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
  /** The site's license as the station last heard it (plan ЛЦ-3); `null` — nothing known. */
  license?: DeviceLicense | null;
}

/** Two large cards stay legible on the 1280×800 line terminal, as on the cloud station. */
const SHIFT_PAGE_SIZE = 2;

type Copies =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; copies: ShiftCopy[]; refused: Map<string, string | null> };

/**
 * The shifts of the station's line (stage 2a spec §5.7.1, the cloud station's
 * `ShiftSelection` on local data): the copies this station keeps, read again
 * after every read of the host's list and after every write and every batch of
 * receipts (`outboxVersion`), so the list stays on screen with the host away
 * and says what the outbox has become: a shift closing here, one whose close
 * the host refused (its card names the code), one closed. One entry at a
 * time; «Сменить оператора» (in the status bar, as on the cloud station) is
 * never held by an entry, so one that never settles does not trap the station
 * here, and an answer that lands after the screen is gone is dropped.
 *
 * What the list says of itself (a refusal of the entry, and the state of the
 * link) is said together in one polite region
 * that is there before any of it: the first never hides the second. The focus
 * starts on the screen's title, so a keyboard or a screen reader does not
 * begin on the page after the work screen or the new shift is gone.
 */
export function ShiftList({
  local,
  pairing,
  lineId,
  online,
  shiftReads,
  outboxVersion = 0,
  enter,
  onEntered,
  onHostError,
  onNew,
  onSetup,
  onWarehouse,
  onQueue,
  license = null,
}: ShiftListProps) {
  const { t } = useTranslation();
  const blocked = opensBlocked(license);
  const { hostId, deviceId } = pairing;
  const [copies, setCopies] = useState<Copies>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [entering, setEntering] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EntryRefusal | null>(null);
  const [requestedPage, setRequestedPage] = useState(1);
  const alive = useRef(true);
  const start = useRef<HTMLHeadingElement>(null);
  // The guard of one entry at a time: two presses in one turn both pass a
  // check of `entering`, which only the next render changes.
  const running = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    start.current?.focus();
  }, []);
  // The latest props, for an entry's answer that lands after a render.
  const current = useRef({ online, onEntered, onHostError });
  useLayoutEffect(() => {
    current.current = { online, onEntered, onHostError };
  });

  useEffect(() => {
    let cancelled = false;
    const pairing = { hostId, deviceId };
    Promise.all([readShiftCopies(local, pairing, lineId), readRefusedCloses(local, pairing)]).then(
      ([read, refused]) => {
        if (!cancelled) setCopies({ kind: "ready", copies: read, refused });
      },
      () => {
        if (!cancelled) setCopies({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, outboxVersion, attempt]);

  const choose = async (copy: ShiftCopy) => {
    if (running.current) return;
    running.current = true;
    setEntering(copy.id);
    setRefusal(null);
    try {
      const result = await enterShift(
        {
          local,
          pairing: { hostId, deviceId },
          online: current.current.online,
          enter,
          now: () => new Date(),
        },
        copy,
      );
      if (!alive.current) return;
      if (result.kind === "entered") {
        current.current.onEntered(result.shift);
        return;
      }
      if (result.kind === "rejected") {
        current.current.onHostError(result.error);
        return;
      }
      setRefusal(result.reason);
      // The host may have changed the shift (closed, opened elsewhere): read again.
      setAttempt((value) => value + 1);
    } finally {
      running.current = false;
      if (alive.current) setEntering(null);
    }
  };

  const busy = entering !== null;
  // Not alerts as well (`role="presentation"` drops the component's own role):
  // inside a polite region each would be read twice.
  const standing =
    refusal !== null ? (
      <Alert tone="error" role="presentation">
        {t(`floor.shifts.refused.${refusal}`)}
      </Alert>
    ) : null;
  // Without the host, the list that did not update says nothing more.
  const linkState = !online ? (
    <Alert tone="warn" role="presentation">
      {t("floor.shifts.offline")}
    </Alert>
  ) : shiftReads.failed ? (
    <Alert tone="warn" role="presentation">
      {t("floor.shifts.readHostFailed")}
    </Alert>
  ) : null;
  const cards = copies.kind === "ready" ? copies.copies : [];
  const pageCount = Math.max(1, Math.ceil(cards.length / SHIFT_PAGE_SIZE));
  // The page is clamped where it is read: a list that got shorter shows its last page.
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const shown = cards.slice((page - 1) * SHIFT_PAGE_SIZE, page * SHIFT_PAGE_SIZE);
  const body = () => {
    if (copies.kind === "loading") {
      return <p className="shift-selection__state">{t("floor.shifts.loading")}</p>;
    }
    if (copies.kind === "failed") {
      return (
        <div className="shift-selection__state">
          <Alert
            tone="error"
            action={
              <Button size="floor" variant="secondary" onClick={() => setAttempt((v) => v + 1)}>
                {t("floor.shifts.retry")}
              </Button>
            }
          >
            {t("floor.shifts.readFailed")}
          </Alert>
        </div>
      );
    }
    if (copies.copies.length === 0) {
      // Static by design, as on the cloud station: a quiet mark, never a control.
      return (
        <div className="shift-selection__state shift-selection__state--empty">
          <span className="shift-selection__empty-mark" aria-hidden="true" />
          <p>{t(shiftReads.done === 0 ? "floor.shifts.notRead" : "floor.shifts.empty")}</p>
        </div>
      );
    }
    return (
      <div className="shift-selection__grid">
        {shown.map((copy) => (
          <ShiftCard
            key={copy.id}
            copy={copy}
            local={local}
            refusal={
              copies.refused.has(copy.id) && copy.localState === "closing"
                ? { code: copies.refused.get(copy.id) ?? null }
                : null
            }
            action={cardAction(copy, deviceId, online, blocked)}
            busy={busy}
            onAction={() => void choose(copy)}
          />
        ))}
      </div>
    );
  };

  return (
    <FloorScreen
      className="shift-hub"
      title={t("floor.shifts.title")}
      titleRef={start}
      header={
        <>
          <div className="shift-selection__message" aria-live="polite">
            {standing}
            {linkState}
            {busy && <p>{t("floor.shifts.entering")}</p>}
          </div>
          {onWarehouse !== undefined && (
            <div className="shift-selection__header-action">
              <Button size="floor" variant="secondary" disabled={busy} onClick={onWarehouse}>
                {t("floor.warehouse.open")}
              </Button>
            </div>
          )}
        </>
      }
      actions={
        <FloorFooter ariaLabel={t("floor.shifts.actions")}>
          <div className="shift-hub__primary">
            {blocked === null && (
              <Button size="floor" disabled={busy || !online} onClick={onNew}>
                {t("floor.shifts.new")}
              </Button>
            )}
            {blocked !== null && (
              // In place of «Новая смена» (spec §9.6), from the license the station last heard.
              <p className="shift-hub__hint">{t(`floor.shifts.refused.${blocked}`)}</p>
            )}
            {blocked === null && !online && (
              <p className="shift-hub__hint">{t("floor.shifts.newNeedsLink")}</p>
            )}
          </div>
          <div className="shift-selection__secondary-actions">
            {onSetup !== undefined && (
              <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
                {t("floor.shifts.setup")}
              </Button>
            )}
            {onQueue !== undefined && (
              <Button size="floor" variant="secondary" disabled={busy} onClick={onQueue}>
                {t("floor.shifts.queue")}
              </Button>
            )}
          </div>
        </FloorFooter>
      }
    >
      <div className="shift-selection__content">
        <div className="shift-selection__slot">{body()}</div>
        {pageCount > 1 ? (
          <Pager
            page={page}
            pageCount={pageCount}
            onPageChange={setRequestedPage}
            ariaLabel={t("floor.shifts.pagination")}
            previousLabel={t("floor.shifts.previousPage")}
            nextLabel={t("floor.shifts.nextPage")}
            pageLabel={(current, count) =>
              t("floor.shifts.page", { page: current, pageCount: count })
            }
            className="shift-selection__pager"
          />
        ) : null}
      </div>
    </FloorScreen>
  );
}
