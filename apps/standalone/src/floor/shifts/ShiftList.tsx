import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { EnteredShift } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readShiftCopies, type ShiftCopy, type WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { cardAction, ShiftCard } from "./ShiftCard.js";

/** What the list says it was brought back for: the office closed the shift the operator worked in. */
export type ShiftListNotice = { kind: "office_closed"; number: string };

export interface ShiftListProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The station's line: the list shows its shifts. */
  lineId: string;
  operator: FloorSession;
  /** The link to the host is online. */
  online: boolean;
  /** `ShellState.shiftReads`: the list reads its copies again after every read. */
  shiftReads: { done: number; failed: boolean };
  notice: ShiftListNotice | null;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  onEntered: (shift: WorkShift) => void;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  onNew: () => void;
  onSignOut: () => void;
  /** The workstation setup (plan 2a7); none — no button. */
  onSetup?: () => void;
}

type Copies = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; copies: ShiftCopy[] };

/**
 * The shifts of the station's line (stage 2a spec §5.7.1, the cloud station's
 * `ShiftSelection` on local data): the copies this station keeps, read again
 * after every read of the host's list, so the list stays on screen with the
 * host away. One entry at a time; «Сменить оператора» is never held by an
 * entry, so one that never settles does not trap the station here, and an
 * answer that lands after the screen is gone is dropped.
 *
 * What the list says of itself (a refusal of the entry or the office's close of
 * the shift, and the state of the link) is said together in one polite region
 * that is there before any of it: the first never hides the second. The focus
 * starts on the line that names the operator, so a keyboard or a screen reader
 * does not begin on the page after the work screen or the new shift is gone.
 */
export function ShiftList({
  local,
  pairing,
  lineId,
  operator,
  online,
  shiftReads,
  notice,
  enter,
  onEntered,
  onHostError,
  onNew,
  onSignOut,
  onSetup,
}: ShiftListProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [copies, setCopies] = useState<Copies>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [entering, setEntering] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<EntryRefusal | null>(null);
  const alive = useRef(true);
  const start = useRef<HTMLParagraphElement>(null);
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
    readShiftCopies(local, { hostId, deviceId }, lineId).then(
      (read) => {
        if (!cancelled) setCopies({ kind: "ready", copies: read });
      },
      () => {
        if (!cancelled) setCopies({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, shiftReads.done, attempt]);

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
    ) : notice !== null ? (
      <Alert tone="info" role="presentation">
        {t("floor.shifts.officeClosed", { number: notice.number })}
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
  const body = () => {
    if (copies.kind === "loading") return <p>{t("floor.shifts.loading")}</p>;
    if (copies.kind === "failed") {
      return (
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
      );
    }
    if (copies.copies.length === 0) {
      return <p>{t(shiftReads.done === 0 ? "floor.shifts.notRead" : "floor.shifts.empty")}</p>;
    }
    return (
      <div className="shift-list__cards">
        {copies.copies.map((copy) => (
          <ShiftCard
            key={copy.id}
            copy={copy}
            action={cardAction(copy, deviceId, online)}
            busy={busy}
            onAction={() => void choose(copy)}
          />
        ))}
      </div>
    );
  };

  return (
    <Card className="standalone-card shift-list" title={t("floor.shifts.title")} titleAs="h2">
      <div className="standalone-form">
        <p ref={start} tabIndex={-1} className="floor-sign-in__prompt">
          {t("floor.operator.signedIn", { name: operator.name, login: operator.login })}
        </p>
        <div className="floor-sign-in__message floor-sign-in__message--stack" aria-live="polite">
          {standing}
          {linkState}
          {busy && <p>{t("floor.shifts.entering")}</p>}
        </div>
        {body()}
        <div className="standalone-form__actions">
          <Button size="floor" disabled={busy || !online} onClick={onNew}>
            {t("floor.shifts.new")}
          </Button>
          {onSetup !== undefined && (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
              {t("floor.shifts.setup")}
            </Button>
          )}
          {/* Never held by an entry: one that never settles must not trap the station here. */}
          <Button size="floor" variant="secondary" onClick={onSignOut}>
            {t("floor.operator.signOut")}
          </Button>
        </div>
        {!online && <p className="shift-card__hint">{t("floor.shifts.newNeedsLink")}</p>}
      </div>
    </Card>
  );
}
