import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FloorNotice, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import { operatorStillAllowed, type FloorOperator } from "./sign-in.js";

export interface FloorOperatorScreenProps {
  operator: FloorOperator;
  local: LocalExecutor;
  pairing: Pairing;
  link: HostStatus | null;
  sync: SyncState;
  /** Nobody touched the station this long: the operator is signed out. */
  idleTimeoutMs?: number;
  /** `null` is the operator's own «Сменить оператора». */
  onSignOut: (notice: FloorNotice | null) => void;
}

/**
 * The floor with an operator signed in: stage 1's stub until the shifts of
 * plan 2a (spec §5.6). It names the operator and offers «Сменить оператора»;
 * the operator is signed out after `idleTimeoutMs` without a touch, and
 * after a sync that took the operator out of this pairing's copies (the host
 * turned them off). A failed read of the copies signs nobody out: the floor
 * works offline.
 */
export function FloorOperatorScreen({
  operator,
  local,
  pairing,
  link,
  sync,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
  onSignOut,
}: FloorOperatorScreenProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    const lock = createOperatorIdleLock({
      target: window,
      timeoutMs: idleTimeoutMs,
      onIdle: () => onSignOut("idle"),
    });
    lock.start();
    return () => lock.stop();
  }, [idleTimeoutMs, onSignOut]);

  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    operatorStillAllowed({ local, pairing: { hostId, deviceId }, now: Date.now }, operator.id).then(
      (allowed) => {
        if (!cancelled && !allowed) onSignOut("removed");
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, operator.id, sync.synced, onSignOut]);

  return (
    <Card className="standalone-card" title={t("floor.title")} titleAs="h2">
      <div className="standalone-form">
        <p className="floor-sign-in__prompt">
          {t("floor.operator.signedIn", { name: operator.name, login: operator.login })}
        </p>
        {operator.role !== null && <p>{operator.role}</p>}
        <p>{t("floor.operator.stub")}</p>
        <HostStatusLine status={link} sync={sync} />
        <div className="standalone-form__actions">
          <Button size="floor" variant="secondary" onClick={() => onSignOut(null)}>
            {t("floor.operator.signOut")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
