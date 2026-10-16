import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { DeviceLicense, EnteredShift, ShiftEnter } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readRefusedCloses } from "../close/shift-close.js";
import { readOutboxStatus, type OutboxStatus } from "../outbox-status.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { opensBlocked } from "../license.js";
import { queueBadge } from "./hub-layout.js";
import { readAcceptedCounts } from "./shift-accepted.js";
import { ShiftHubView, type HubCopies } from "./ShiftHub.js";

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
  const [copies, setCopies] = useState<HubCopies>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [entering, setEntering] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EntryRefusal | null>(null);
  const [requestedPage, setRequestedPage] = useState(1);
  const [outbox, setOutbox] = useState<OutboxStatus | null>(null);
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
    Promise.all([readShiftCopies(local, pairing, lineId), readRefusedCloses(local, pairing)])
      .then(async ([read, refused]) => {
        // Only a shift this station entered and that has a plan can show «Принято N из M».
        const counted = read.filter((copy) => copy.entered && (copy.plannedQty ?? 0) > 0);
        const accepted = await readAcceptedCounts(
          local,
          pairing,
          counted.map((copy) => copy.id),
        );
        return { read, refused, accepted };
      })
      .then(
        ({ read, refused, accepted }) => {
          if (!cancelled) setCopies({ kind: "ready", copies: read, refused, accepted });
        },
        () => {
          if (!cancelled) setCopies({ kind: "failed" });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, outboxVersion, attempt]);

  // The queue button's count: read with the list, so a refusal or a wait shows on the hub.
  useEffect(() => {
    let cancelled = false;
    readOutboxStatus(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setOutbox(next);
      },
      () => {
        if (!cancelled) setOutbox(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftReads.done, outboxVersion]);

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
  return (
    <ShiftHubView
      local={local}
      copies={copies}
      deviceId={deviceId}
      online={online}
      blocked={blocked}
      busy={busy}
      notRead={shiftReads.done === 0}
      requestedPage={requestedPage}
      onPageChange={setRequestedPage}
      messages={
        <>
          {standing}
          {linkState}
          {busy && <p>{t("floor.shifts.entering")}</p>}
        </>
      }
      badge={queueBadge(outbox)}
      titleRef={start}
      onChoose={(copy) => void choose(copy)}
      onRetry={() => setAttempt((value) => value + 1)}
      onNew={onNew}
      {...(onSetup === undefined ? {} : { onSetup })}
      {...(onWarehouse === undefined ? {} : { onWarehouse })}
      {...(onQueue === undefined ? {} : { onQueue })}
    />
  );
}
