import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Input } from "@markiro/ui";
import type {
  DeviceReplacementPreparation,
  DeviceReplacementList,
  deviceReplacementExecutionPreviewSchema,
} from "@markiro/platform-contracts";
import type { z } from "zod";
import {
  requestReplacementDrain,
  previewReplacementExecution,
  previewEmergencyReplacement,
  executeReplacement,
  issueReplacementRecoveryCode,
  closeReplacementRecovery,
  issueReplacementTargetCode,
  replacementErrorKind,
} from "./replacement-api.js";
import {
  replacementKeys,
  useReplacementCache,
  useReplacementPending,
  type WorkflowAttempt,
  type WorkflowOperation,
} from "./replacement-state.js";

type Preview = z.output<typeof deviceReplacementExecutionPreviewSchema>;
type Dialog = {
  kind: "normal" | "emergency" | "close";
  reason: string;
  acknowledged: boolean;
  preview?: Preview;
};
const grid = { display: "grid", gap: "var(--sp-3)", minWidth: 0 } as const;

export function DeviceReplacementWorkflow({
  tenantId,
  preparation: p,
  canWrite,
  refresh,
}: {
  tenantId: string;
  preparation: DeviceReplacementPreparation;
  canWrite: boolean;
  refresh: (auth?: boolean) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = replacementKeys.workflow(tenantId, p.id);
  const [attempt, setAttempt] = useReplacementCache<WorkflowAttempt | null>(key, null);
  const [dialog, setDialog] = useReplacementCache<Dialog | null>(
    replacementKeys.dialog(tenantId, p.id),
    null,
  );
  const [notice, setNotice] = useState<"authorization" | "conflict" | "codeLost" | null>(null);
  // Plaintext exists only in this mounted view, never in Query Cache or a saved receipt.
  const [secret, setSecret] = useState<{
    code: string;
    expiresAt: string;
    purpose: "source" | "target";
  } | null>(null);
  const busy = useReplacementPending(tenantId);
  const allowed = canWrite && notice !== "authorization";
  const locked = busy || Boolean(attempt);
  const date = (at: string) => (
    <time dateTime={at}>{new Date(at).toLocaleString(i18n.resolvedLanguage ?? i18n.language)}</time>
  );
  const field = (name: string, value: ReactNode) => (
    <div
      key={name}
      style={{
        minWidth: 0,
        paddingBlock: "var(--sp-2)",
        borderBottom: "1px solid var(--line)",
        overflowWrap: "anywhere",
      }}
    >
      <dt style={{ color: "var(--fg-3)", font: "var(--text-body-sm)" }}>
        {t(`deviceReplacement.workflow.${name}`)}
      </dt>
      <dd style={{ margin: 0, fontFamily: "var(--font-mono)" }}>{value}</dd>
    </div>
  );
  const accept = (preparation: DeviceReplacementPreparation) => {
    qc.setQueryData<DeviceReplacementList>(replacementKeys.list(tenantId), (previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) =>
              item.preparation.id === preparation.id ? { preparation, needsReview: false } : item,
            ),
          }
        : previous,
    );
  };
  const perform = async (operation: WorkflowOperation) => {
    const current = qc.getQueryData<WorkflowAttempt>(key);
    if (!allowed || busy || current?.pending) return;
    const op = current?.operation ?? operation;
    setAttempt({ operation: op, pending: true });
    setNotice(null);
    setSecret(null);
    try {
      if (op.kind === "normalPreview" || op.kind === "emergencyPreview") {
        const preview =
          op.kind === "normalPreview"
            ? await previewReplacementExecution(tenantId, p.id, op.request)
            : await previewEmergencyReplacement(tenantId, p.id, op.request);
        setDialog({
          kind: preview.mode,
          reason: op.kind === "emergencyPreview" ? op.request.reason : "",
          acknowledged: false,
          preview,
        });
      } else if (op.kind === "targetCode") {
        const targetId = p.execution?.targetDeviceId;
        if (!targetId) throw new Error("Missing replacement target");
        const result = await issueReplacementTargetCode(tenantId, p.id, targetId, op.request);
        accept(result.preparation);
        setSecret({ code: result.code, expiresAt: result.expiresAt, purpose: "target" });
      } else if (op.kind === "recoveryCode") {
        const result = await issueReplacementRecoveryCode(tenantId, p.id, op.request);
        accept(result.preparation);
        setSecret({ code: result.code, expiresAt: result.expiresAt, purpose: "source" });
      } else {
        const result =
          op.kind === "drain"
            ? await requestReplacementDrain(tenantId, p.id, op.request)
            : op.kind === "execute"
              ? await executeReplacement(tenantId, p.id, op.request)
              : await closeReplacementRecovery(tenantId, p.id, op.request);
        accept(result.preparation);
        setDialog(null);
      }
      setAttempt(null);
      await refresh();
    } catch (error) {
      const kind = replacementErrorKind(error);
      if (kind === "uncertain" && op.kind !== "targetCode" && op.kind !== "recoveryCode") {
        setAttempt({ operation: op, pending: false, notice: "uncertain" });
      } else {
        setAttempt(null);
        setNotice(kind === "uncertain" ? "codeLost" : kind);
        if (kind !== "uncertain") setDialog(null);
        await refresh(kind === "authorization");
      }
    }
  };
  const revisionRequest = (execution = false) => ({
    requestId: crypto.randomUUID(),
    expectedRevision: execution ? (p.execution?.revision ?? p.revision) : p.revision,
  });
  const report = p.readiness?.report;
  const recovery = p.recovery?.state ?? p.execution?.recoveryState;
  const openRecovery = recovery === "required" || recovery === "draining";
  const recoveryReadiness = p.state === "completed" && recovery === "draining";
  const beforeExecution = ["prepared", "draining", "ready"].includes(p.state);
  const renew =
    p.state === "draining" &&
    p.readiness?.eligibility.reasons.some((reason) =>
      ["report_stale", "facts_changed", "credential_epoch_mismatch"].includes(reason),
    );
  const reasonCopy = (reason: string) => {
    const recoveryKey = `deviceReplacement.workflow.recoveryBlocker.${reason}`;
    return recoveryReadiness && i18n.exists(recoveryKey)
      ? t(recoveryKey)
      : t(`deviceReplacement.workflow.blocker.${reason}`, {
          defaultValue: t("deviceReplacement.workflow.unknownBlocker", { reason }),
        });
  };
  const dialogTitle =
    dialog?.kind === "close" ? "close" : dialog?.kind === "emergency" ? "emergency" : "normal";
  const dialogConfirm =
    dialog?.kind === "close"
      ? "confirmClose"
      : dialog?.kind === "emergency"
        ? dialog.preview
          ? "confirmEmergency"
          : "emergencyPreview"
        : "confirmNormal";
  const confirm = () => {
    if (!dialog) return;
    if (attempt) {
      void perform(attempt.operation);
      return;
    }
    if (dialog.kind === "close") {
      void perform({
        kind: "recoveryClose",
        request: { ...revisionRequest(true), reason: dialog.reason.trim() },
      });
      return;
    }
    if (dialog.preview) {
      if (dialog.kind === "emergency" && !dialog.acknowledged) return;
      void perform({
        kind: "execute",
        request: {
          requestId: dialog.preview.requestId,
          expectedRevision: dialog.preview.expectedRevision,
          previewId: dialog.preview.id,
          mode: dialog.preview.mode,
        },
      });
    } else if (dialog.kind === "emergency")
      void perform({
        kind: "emergencyPreview",
        request: { ...revisionRequest(), reason: dialog.reason.trim() },
      });
  };
  return (
    <div style={grid}>
      {p.readiness && p.state === "completed" ? (
        <p style={{ margin: 0 }}>
          {t(`deviceReplacement.workflow.${recoveryReadiness ? "recoveryReport" : "savedReport"}`)}
        </p>
      ) : null}
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
          gap: "0 var(--sp-4)",
          margin: 0,
        }}
      >
        {field("revision", p.revision)}
        {p.readiness ? (
          <>
            {field("epoch", p.readiness.credentialEpoch)}
            {field(
              "received",
              p.readiness.receivedAt
                ? date(p.readiness.receivedAt)
                : t("deviceReplacement.workflow.notReported"),
            )}
          </>
        ) : null}
        {report ? (
          <>
            {Object.entries(report.pending).map(([name, value]) =>
              field(
                name,
                typeof value === "number" ? value : t("deviceReplacement.workflow.unsupported"),
              ),
            )}
            {field(
              "conflicts",
              report.conflicts === "unsupported"
                ? t("deviceReplacement.workflow.unsupported")
                : report.conflicts,
            )}
            {field(
              "unknownPrints",
              report.unknownPrints === "unsupported"
                ? t("deviceReplacement.workflow.unsupported")
                : report.unknownPrints,
            )}
            {field("activeTasks", report.activeTasks.length)}
            {field("installedGrants", report.installedGrants.length)}
            {field("journal", report.journal.highestSequence)}
            {field("storageRevision", report.storageRevision)}
            {field("reportSequence", report.reportSequence)}
            {field("clientBuild", report.clientBuild)}
          </>
        ) : null}
      </dl>
      {p.readiness && !report ? (
        <Alert tone="warn">{t("deviceReplacement.workflow.noMeasurements")}</Alert>
      ) : null}
      {beforeExecution && p.drainEligibility?.status === "blocked" && !p.readiness ? (
        <Alert tone="warn">{reasonCopy("client_upgrade_required")}</Alert>
      ) : null}
      {p.readiness?.eligibility.status === "blocked" && (beforeExecution || recoveryReadiness) ? (
        <Alert tone="warn">
          {recoveryReadiness ? (
            <p style={{ margin: 0 }}>{t("deviceReplacement.workflow.recoveryBlockers")}</p>
          ) : null}
          <ul style={{ margin: 0, paddingInlineStart: "var(--sp-5)" }}>
            {[...new Set(p.readiness.eligibility.reasons)].map((reason) => (
              <li key={reason}>{reasonCopy(reason)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <p style={{ margin: 0 }}>{t(`deviceReplacement.workflow.next.${p.state}`)}</p>
      {p.execution ? (
        <>
          <Badge tone={p.execution.mode === "emergency" ? "warn" : "info"}>
            {t(`deviceReplacement.workflow.mode.${p.execution.mode}`)}
          </Badge>
          <dl style={{ margin: 0, ...grid }}>
            {field("executionRevision", p.execution.revision)}
            {field("executionStep", t(`deviceReplacement.workflow.step.${p.execution.step}`))}
            {p.execution.targetDeviceId ? field("targetId", p.execution.targetDeviceId) : null}
            {p.execution.executedAt ? field("executedAt", date(p.execution.executedAt)) : null}
          </dl>
          <Alert tone={p.execution.mode === "emergency" ? "warn" : "info"}>
            {t("deviceReplacement.workflow.boundary")} {date(p.execution.newWorkAllowedAt)}.{" "}
            {t("deviceReplacement.workflow.boundaryHint")}
          </Alert>
          {recovery ? (
            <Alert tone={openRecovery || recovery === "evidence_unavailable" ? "warn" : "ok"}>
              {t(`deviceReplacement.workflow.recovery.${recovery}`)}
              {p.recovery?.closedAt ? <> {date(p.recovery.closedAt)}</> : null}
            </Alert>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <Alert tone="error">
          {t(
            notice === "codeLost"
              ? "deviceReplacement.workflow.codeLost"
              : `deviceReplacement.${notice}`,
          )}
        </Alert>
      ) : null}
      {attempt?.notice ? <Alert tone="error">{t("deviceReplacement.uncertain")}</Alert> : null}
      {secret && allowed ? (
        <section aria-label={t(`deviceReplacement.workflow.secret.${secret.purpose}`)} style={grid}>
          <h3>{t(`deviceReplacement.workflow.secret.${secret.purpose}`)}</h3>
          <output style={{ font: "700 1.5rem var(--font-mono)", letterSpacing: ".08em" }}>
            {secret.code}
          </output>
          <p style={{ margin: 0 }}>
            {t("deviceReplacement.workflow.codeExpires")} {date(secret.expiresAt)}
          </p>
          <Button variant="secondary" onClick={() => setSecret(null)}>
            {t("deviceReplacement.workflow.hideCode")}
          </Button>
        </section>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>
          {t("deviceReplacement.workflow.refresh")}
        </Button>
        {allowed && attempt?.notice ? (
          <Button disabled={busy} onClick={() => void perform(attempt.operation)}>
            {t("deviceReplacement.workflow.retry")}
          </Button>
        ) : null}
        {allowed && !attempt ? (
          <>
            {p.state === "prepared" || renew ? (
              <Button
                disabled={locked || p.drainEligibility?.status === "blocked"}
                onClick={() => void perform({ kind: "drain", request: revisionRequest() })}
              >
                {t("deviceReplacement.workflow.drain")}
              </Button>
            ) : null}
            {p.state === "ready" && !dialog?.preview ? (
              <Button
                disabled={locked || p.drainEligibility?.status === "blocked"}
                onClick={() => void perform({ kind: "normalPreview", request: revisionRequest() })}
              >
                {t("deviceReplacement.workflow.preview")}
              </Button>
            ) : null}
            {beforeExecution ? (
              <Button
                variant="destructive"
                disabled={locked}
                onClick={() => setDialog({ kind: "emergency", reason: "", acknowledged: false })}
              >
                {t("deviceReplacement.workflow.emergency")}
              </Button>
            ) : null}
            {p.state === "completed" && p.execution?.targetDeviceId ? (
              <Button
                disabled={locked}
                onClick={() => void perform({ kind: "targetCode", request: revisionRequest(true) })}
              >
                {t("deviceReplacement.workflow.targetCode")}
              </Button>
            ) : null}
            {p.state === "completed" && openRecovery ? (
              <>
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() =>
                    void perform({ kind: "recoveryCode", request: revisionRequest(true) })
                  }
                >
                  {t("deviceReplacement.workflow.recoveryCode")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={locked}
                  onClick={() => setDialog({ kind: "close", reason: "", acknowledged: false })}
                >
                  {t("deviceReplacement.workflow.close")}
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={Boolean(dialog) && allowed && !attempt?.notice}
        title={t(`deviceReplacement.workflow.${dialogTitle}`)}
        description={
          <div style={grid}>
            <p style={{ margin: 0 }}>{t(`deviceReplacement.workflow.dialog.${dialogTitle}`)}</p>
            {dialog?.kind === "emergency" || dialog?.kind === "close" ? (
              <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
                <Input
                  label={t(
                    `deviceReplacement.workflow.${dialog.kind === "close" ? "closeReason" : "emergencyReason"}`,
                  )}
                  value={dialog.reason}
                  maxLength={1000}
                  onChange={(event) =>
                    setDialog({
                      kind: dialog.kind,
                      reason: event.target.value,
                      acknowledged: false,
                    })
                  }
                />
              </fieldset>
            ) : null}
            {dialog?.preview ? (
              <>
                <p style={{ margin: 0 }}>
                  {t("deviceReplacement.workflow.boundary")} {date(dialog.preview.newWorkAllowedAt)}
                </p>
                <p style={{ margin: 0 }}>
                  {t("deviceReplacement.workflow.previewRevision", {
                    revision: dialog.preview.expectedRevision,
                  })}
                </p>
                <p style={{ margin: 0 }}>
                  {t("deviceReplacement.workflow.previewExpires")} {date(dialog.preview.expiresAt)}
                </p>
                {dialog.kind === "emergency" ? (
                  <Checkbox
                    label={t("deviceReplacement.workflow.acknowledge")}
                    checked={dialog.acknowledged}
                    disabled={busy}
                    onCheckedChange={(checked) => setDialog({ ...dialog, acknowledged: checked })}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        }
        confirmLabel={t(`deviceReplacement.workflow.${dialogConfirm}`)}
        cancelLabel={t("deviceReplacement.back")}
        tone={dialog?.kind === "normal" ? "default" : "destructive"}
        busy={busy}
        confirmDisabled={
          !dialog ||
          (dialog.kind !== "normal" && !dialog.reason.trim()) ||
          (dialog.kind === "emergency" && Boolean(dialog.preview) && !dialog.acknowledged)
        }
        onConfirm={confirm}
        onCancel={() => {
          if (!busy) setDialog(null);
        }}
      />
    </div>
  );
}
