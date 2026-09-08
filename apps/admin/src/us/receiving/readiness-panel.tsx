import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { ReceivingLiveRecord, ReceivingFinalizeResult } from "@markiro/platform-contracts";
import type { ReceivingDraftView } from "./live-record.js";
import { UsClientError, UsReceivingIncompleteError, type UsBrowserClient } from "../client.js";
import { ReceivingFinalizationDialog } from "./finalization-dialog.js";
import "./readiness.css";

type CheckResult = Awaited<ReturnType<UsBrowserClient["checkReceivingReadiness"]>>;
type CheckState = {
  context: string;
  pending: boolean;
  result: CheckResult | null;
  error: "conflict" | "failed" | "denied" | null;
};

export function ReceivingReadinessPanel({
  client,
  record,
  dirty,
  generation,
  disabled,
  onReload,
  onForbidden,
  onSessionLost,
  canManageQa = false,
  beginMutation,
  onFinalizationLocked,
  onOpenRecord,
  onAcknowledged,
}: {
  client: UsBrowserClient;
  record: ReceivingDraftView | null;
  dirty: boolean;
  generation: number;
  disabled: boolean;
  onReload: () => Promise<void>;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  canManageQa?: boolean;
  beginMutation?: () => () => void;
  onFinalizationLocked?: (locked: boolean) => void;
  onOpenRecord?: (record: ReceivingLiveRecord) => void;
  onAcknowledged?: (result: ReceivingFinalizeResult) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [check, setCheck] = useState<CheckState | null>(null);
  const [conflicted, setConflicted] = useState<ReceivingDraftView | null>(null);
  const [confirmation, setConfirmation] = useState<{ context: string; result: CheckResult } | null>(
    null,
  );
  const [finalizationFailure, setFinalizationFailure] = useState(false);
  const [finalizationIssues, setFinalizationIssues] = useState<CheckResult["issues"]>([]);
  const requestGeneration = useRef(0);
  const identity = `${record?.id}/${record?.draftVersion}/${record?.lifecycle.lifecycleVersion}/${record?.status}`;
  const context = `${identity}/${generation}/${dirty}/${disabled}`;
  const confirmationContext = `${identity}/${generation}/${dirty}/${canManageQa}`;
  const confirmationCurrent = confirmation?.context === confirmationContext;
  const currentContext = useRef(context);
  currentContext.current = context;
  const current = check?.context === context;
  const pending = current && check?.pending === true;
  const conflict = conflicted !== null && conflicted === record;
  const canCheck =
    record !== null &&
    record.status === "draft" &&
    record.revision === 1 &&
    !dirty &&
    !disabled &&
    !pending &&
    !conflict;
  const result = check?.result ?? null;
  const errors = result?.issues.filter((issue) => issue.severity === "error").length ?? 0;
  const warnings = result?.issues.filter((issue) => issue.severity === "warning").length ?? 0;

  useEffect(() => {
    setConfirmation(null);
    setCheck(null);
    requestGeneration.current += 1;
  }, [canManageQa]);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  async function runCheck() {
    if (!canCheck || !record) return;
    const request = ++requestGeneration.current;
    const requestedContext = context;
    const accepts = () =>
      request === requestGeneration.current && currentContext.current === requestedContext;
    setCheck({ context, pending: true, result: null, error: null });
    setConfirmation(null);
    setFinalizationFailure(false);
    setFinalizationIssues([]);
    try {
      const response = await client.checkReceivingReadiness(record.id, record.draftVersion);
      if (!accepts()) return;
      if (
        response.rootId.toLowerCase() !== record.lifecycle.rootId.toLowerCase() ||
        response.expectedLifecycleVersion !== record.lifecycle.lifecycleVersion ||
        response.previousRevisionId !== null
      )
        throw new UsClientError("receiving_draft_conflict");
      setCheck({ context, pending: false, result: response, error: null });
    } catch (error) {
      if (!accepts()) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      if (code === "session_required") {
        setCheck(null);
        onSessionLost();
        return;
      }
      if (code === "forbidden") {
        setCheck({ context, pending: false, result: null, error: "denied" });
        await onForbidden();
        return;
      }
      const stale =
        code === "receiving_draft_conflict" ||
        code === "receiving_already_finalized" ||
        code === "conflict" ||
        code === "receiving_draft_not_found";
      if (stale) setConflicted(record);
      setCheck({ context, pending: false, result: null, error: stale ? "conflict" : "failed" });
    }
  }

  return (
    <section
      className="us-rec-section us-rec-readiness"
      aria-labelledby="receiving-readiness"
      aria-busy={pending}
    >
      <div className="us-rec-readiness-heading">
        <div>
          <h2 id="receiving-readiness">{t("receivingReadiness.title")}</h2>
          <p className="us-rec-hint">{t("receivingReadiness.intro")}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!canCheck}
          onClick={() => void runCheck()}
        >
          {t("receivingReadiness.check")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="us-rec-readiness-status">
        {pending ? <p>{t("receivingReadiness.checking")}</p> : null}
        {!record ? (
          <p>{t("receivingReadiness.saveFirst")}</p>
        ) : dirty ? (
          <p>{t("receivingReadiness.saveChanges")}</p>
        ) : disabled ? (
          <p>{t("receivingReadiness.unavailableWhileSaving")}</p>
        ) : null}
        {!current && check ? <p>{t("receivingReadiness.stale")}</p> : null}
        {current && result ? (
          <p className={`us-rec-readiness-summary ${errors ? "is-blocked" : "is-complete"}`}>
            {t(errors ? "receivingReadiness.blocked" : "receivingReadiness.complete", {
              count: errors,
            })}
            {warnings ? ` ${t("receivingReadiness.warnings", { count: warnings })}.` : ""}
          </p>
        ) : null}
      </div>
      {conflict || (current && check?.error) ? (
        <div role="alert" className="us-md-notice us-md-notice--alert">
          <p>{t(`receivingReadiness.${conflict ? "conflict" : check?.error}`)}</p>
          {conflict ? (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => void onReload()}
            >
              {t("receivingReadiness.reload")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className={`us-rec-readiness-findings ${current ? "" : "is-stale"}`}>
          <p className="us-rec-hint">
            {t("receivingReadiness.checked", {
              version: result.draftVersion,
              date: new Intl.DateTimeFormat(i18n.language, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: record?.timeZone ?? "UTC",
              }).format(new Date(result.checkedAt)),
            })}
          </p>
          {current && result.exemptReviewRequiredLines.length ? (
            <p className="us-md-notice">
              {t("receivingReadiness.pendingQa", {
                lines: result.exemptReviewRequiredLines.join(", "),
              })}
            </p>
          ) : null}
          {!current && result.issues.length ? <p>{t("receivingReadiness.staleIssues")}</p> : null}
          {(["header", "lines", "documents"] as const).map((group) => {
            const issues = result.issues.filter((issue) => issue.group === group);
            if (!issues.length) return null;
            return (
              <section
                key={group}
                aria-labelledby={`readiness-group-${group}`}
                className="us-rec-readiness-group"
              >
                <h3 id={`readiness-group-${group}`}>{t(`receivingReadiness.${group}`)}</h3>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.line}-${issue.field}-${issue.code}-${issue.detail}-${index}`}>
                      <span className={`us-rec-readiness-severity is-${issue.severity}`}>
                        {t(`receivingReadiness.${issue.severity}`)}
                      </span>
                      <div>
                        <strong>
                          {issue.line ? `${t("receiving.line", { number: issue.line })} · ` : ""}
                          {t(`receivingReadiness.fields.${issue.field}`)}
                          {issue.detail
                            ? ` · ${t(`receivingReadiness.details.${issue.detail}`)}`
                            : ""}
                        </strong>
                        <p>
                          {issue.field === "documents" && issue.code === "required"
                            ? t(
                                `receivingReadiness.${issue.severity === "warning" ? "documentRecommended" : "documentRequired"}`,
                              )
                            : t(`receivingReadiness.codes.${issue.code}`)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
      <p className="us-rec-hint us-rec-readiness-scope">{t("receivingReadiness.scope")}</p>
      {finalizationFailure ? (
        <div role="alert" className="us-md-notice us-md-notice--alert">
          <p>{t("receiving.finalizeConflict")}</p>
          <ul>
            {finalizationIssues.map((issue, index) => (
              <li key={index}>
                {issue.line ? `${t("receiving.line", { number: issue.line })} · ` : ""}
                {t(`receivingReadiness.fields.${issue.field}`)}:{" "}
                {t(`receivingReadiness.codes.${issue.code}`)}
                {issue.detail ? ` · ${t(`receivingReadiness.details.${issue.detail}`)}` : ""}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => void onReload()}
          >
            {t("receiving.reloadCurrent")}
          </Button>
        </div>
      ) : null}
      {canManageQa &&
      current &&
      result?.state === "complete" &&
      !dirty &&
      !disabled &&
      !conflict ? (
        <Button
          type="button"
          onClick={() => setConfirmation({ context: confirmationContext, result })}
        >
          {t("receiving.finalize")}
        </Button>
      ) : null}
      {confirmationCurrent &&
      confirmation &&
      record &&
      beginMutation &&
      onFinalizationLocked &&
      onOpenRecord &&
      onAcknowledged ? (
        <ReceivingFinalizationDialog
          client={client}
          record={record}
          readiness={confirmation.result}
          beginMutation={beginMutation}
          onLocked={onFinalizationLocked}
          onClose={() => setConfirmation(null)}
          onReload={onReload}
          onAcknowledged={async (result) => {
            setConfirmation(null);
            await onAcknowledged(result);
          }}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
          onConflict={(error) => {
            setConfirmation(null);
            setCheck(null);
            setFinalizationFailure(true);
            setFinalizationIssues(error instanceof UsReceivingIncompleteError ? error.issues : []);
            if (
              [
                "receiving_draft_conflict",
                "receiving_already_finalized",
                "receiving_operation_conflict",
                "receiving_draft_not_found",
                "conflict",
              ].includes(error.code)
            )
              setConflicted(record);
          }}
        />
      ) : null}
    </section>
  );
}
