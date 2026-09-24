import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import {
  readBoxReconciliationLastChecked,
  readBoxReconciliationIssues,
  readBoxReconciliationShifts,
  readBoxReconciliationSummary,
  type BoxReconciliationIssue,
  type BoxReconciliationSummary,
} from "../lib/box-reconciliation.js";
import type { ServerReachability } from "../lib/api-client.js";
import type { SqlExecutor } from "../lib/mirror.js";

export interface SyncDetailsDialogProps {
  open: boolean;
  exec: SqlExecutor;
  shiftId: string | null;
  serverReachability?: ServerReachability;
  onClose: () => void;
  onReconcileNow: () => Promise<void>;
}

export function SyncDetailsDialog({
  open,
  exec,
  shiftId,
  serverReachability = "checking",
  onClose,
  onReconcileNow,
}: SyncDetailsDialogProps) {
  const { t } = useTranslation();
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(shiftId);
  const effectiveShiftId = shiftId ?? selectedShiftId;
  const [summary, setSummary] = useState<BoxReconciliationSummary | null>(null);
  const [issues, setIssues] = useState<BoxReconciliationIssue[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [shifts, setShifts] = useState<
    { shiftId: string; label: string; pending: number; issues: number }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (open) setSelectedShiftId(shiftId);
  }, [open, shiftId]);
  const refresh = useCallback(async () => {
    try {
      const [nextSummary, nextIssues, nextShifts, nextLastCheckedAt] = await Promise.all([
        readBoxReconciliationSummary(exec, effectiveShiftId ?? undefined),
        readBoxReconciliationIssues(exec, effectiveShiftId ?? undefined),
        effectiveShiftId ? Promise.resolve([]) : readBoxReconciliationShifts(exec),
        readBoxReconciliationLastChecked(exec, effectiveShiftId ?? undefined),
      ]);
      setSummary(nextSummary);
      setIssues(nextIssues);
      setShifts(nextShifts);
      setLastCheckedAt(nextLastCheckedAt);
      setError(false);
    } catch {
      setError(true);
    }
  }, [exec, effectiveShiftId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(interval);
  }, [open, refresh]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReconcileNow();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const counters = summary
    ? ([
        ["localClosed", summary.localClosed],
        ["delivered", summary.delivered],
        ["confirmed", summary.confirmed],
        ["pending", summary.pending],
        ["issues", summary.issues],
      ] as const)
    : [];

  return (
    <FullScreenDialog
      open={open}
      title={t("boxReconciliation.title")}
      backLabel={t("boxReconciliation.close")}
      onClose={onClose}
      footer={
        <Button size="floor" disabled={busy} onClick={() => void run()}>
          {t(busy ? "boxReconciliation.checking" : "boxReconciliation.checkNow")}
        </Button>
      }
    >
      {error ? <p role="alert">{t("boxReconciliation.readError")}</p> : null}
      {shiftId === null && selectedShiftId !== null ? (
        <Button size="floor" onClick={() => setSelectedShiftId(null)}>
          {t("boxReconciliation.allShifts")}
        </Button>
      ) : null}
      <p>
        {effectiveShiftId
          ? (shifts.find((item) => item.shiftId === effectiveShiftId)?.label ??
            t("boxReconciliation.currentShift"))
          : t("boxReconciliation.wholeDevice")}
      </p>
      <dl className="station-box-reconciliation-counters">
        {counters.map(([key, value]) => (
          <div key={key}>
            <dt>{t(`boxReconciliation.${key}`)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {serverReachability === "unreachable" ? (
        <p>{t("boxReconciliation.offlineRetry")}</p>
      ) : summary && summary.pending > 0 ? (
        <p>{t("boxReconciliation.automaticRepair")}</p>
      ) : null}
      {lastCheckedAt ? (
        <p>
          {t("boxReconciliation.lastChecked", { time: new Date(lastCheckedAt).toLocaleString() })}
        </p>
      ) : null}
      {shifts.length > 0 ? (
        <section aria-label={t("boxReconciliation.shifts")}>
          <h3>{t("boxReconciliation.shifts")}</h3>
          <ul>
            {shifts.map((shift) => (
              <li key={shift.shiftId}>
                <Button size="floor" onClick={() => setSelectedShiftId(shift.shiftId)}>
                  {shift.label}: {t("boxReconciliation.pending")} {shift.pending},{" "}
                  {t("boxReconciliation.issues")} {shift.issues}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {issues.length > 0 ? (
        <section aria-label={t("boxReconciliation.issueList")}>
          <h3>{t("boxReconciliation.issueList")}</h3>
          <ul>
            {issues.map((issue) => (
              <li key={issue.boxId}>
                <strong>{issue.sscc ?? issue.boxId}</strong> —{" "}
                {t(`boxReconciliation.reason.${issue.reasonCode}`, {
                  defaultValue: issue.reasonCode,
                })}
                {` · ${issue.localItemCount} / ${issue.serverItemCount ?? "—"}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </FullScreenDialog>
  );
}
