import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, ConfirmDialog, Modal } from "@markiro/ui";
import type {
  UsPlanApproveBody,
  UsPlanDetailResponse,
  UsPlanListResponse,
  UsPlanValidationResponse,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, UsPlanValidationError, type UsBrowserClient } from "../client.js";
import { planCopy } from "./copy.js";

type Draft = Extract<UsPlanDetailResponse, { status: "draft" }>;
type Receipt = Awaited<ReturnType<UsBrowserClient["approvePlan"]>>;
type Confirmations = UsPlanApproveBody["confirmations"];
const empty: Confirmations = {
  procedures: false,
  backupAndRecovery: false,
  contact: false,
  nonFarmScope: false,
};
const checks = ["procedures", "backupAndRecovery", "contact", "nonFarmScope"] as const;
export type PlanApprovalProps = {
  client: UsBrowserClient;
  draft: Draft;
  availability: UsPlanListResponse["publicationAvailability"];
  canManageQa: boolean;
  dirty: boolean;
  saving: boolean;
  onApproved: (receipt: Receipt) => Promise<void>;
  onDiscarded: () => Promise<void>;
  onReload: () => Promise<void>;
  onMutationPendingChange: (pending: boolean) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

// A newly saved revision has a new intent. Closing/reopening a dialog alone must
// not lose the request identity after a response may have been lost.
export function PlanApproval(props: PlanApprovalProps) {
  return <ApprovalIntent key={`${props.draft.id}:${props.draft.draftRevision}`} {...props} />;
}
function ApprovalIntent(props: PlanApprovalProps) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<"approve" | "discard" | null>(null);
  const [confirmations, setConfirmations] = useState(empty);
  const [validation, setValidation] = useState<UsPlanValidationResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [completed, setCompleted] = useState<Receipt | "discarded" | null>(null);
  const approvalIntentKey = useRef<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const current = useRef(props);
  current.current = props;
  const priorAccess = useRef(props.canManageQa);
  const { onMutationPendingChange } = props;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!priorAccess.current && props.canManageQa) setDenied(false);
    priorAccess.current = props.canManageQa;
    if (!props.canManageQa || props.dirty || props.saving) setValidation(null);
  }, [props.canManageQa, props.dirty, props.saving]);
  useEffect(() => {
    if (!pending) return;
    onMutationPendingChange(true);
    return () => onMutationPendingChange(false);
  }, [pending, onMutationPendingChange]);
  const blocked = !props.canManageQa || props.dirty || props.saving || denied;
  const storageUnavailable = props.availability !== "available" || unavailable;
  const assertionsReady =
    props.draft.provenance === "trusted_synthetic" || checks.every((id) => confirmations[id]);
  const ready =
    !blocked &&
    !storageUnavailable &&
    !stale &&
    !completed &&
    assertionsReady &&
    validation?.issues.length === 0 &&
    validation.publicationAvailability === "available";

  async function fail(value: unknown) {
    if (value instanceof UsPlanValidationError) {
      setValidation({
        versionId: props.draft.id,
        draftRevision: props.draft.draftRevision,
        issues: value.issues,
        publicationAvailability: props.availability,
      });
      setError("usPlan.approvalIssues");
    } else if (value instanceof UsClientError && value.code === "forbidden") {
      setDenied(true);
      setValidation(null);
      setError("usPlan.inspectionForbidden");
      await props.onForbidden();
    } else if (value instanceof UsClientError && value.code === "session_required") {
      setDenied(true);
      setValidation(null);
      setError("usPlan.session");
      props.onSessionLost();
    } else if (
      value instanceof UsClientError &&
      value.code === "us_plan_artifact_storage_unconfigured"
    ) {
      setUnavailable(true);
      setValidation(null);
      setError("usPlan.publicationUnavailable");
    } else if (
      value instanceof UsClientError &&
      /(?:conflict|not_draft|attempt_fenced|version_not_found)$/.test(value.code)
    ) {
      setStale(true);
      setValidation(null);
      setError("usPlan.approvalStale");
    } else setError("usPlan.approvalRetry");
  }
  async function run(operation: "validate" | "approve" | "discard" | "reload" | "refresh") {
    if (
      busy.current ||
      blocked ||
      (operation === "approve" && !ready) ||
      (operation === "validate" && storageUnavailable)
    )
      return;
    busy.current = true;
    setPending(true);
    setError(null);
    const { id, draftRevision } = props.draft;
    try {
      if (operation === "validate") {
        setValidation(null);
        const result = await props.client.validatePlan(id, {
          expectedRevision: draftRevision,
          confirmations,
        });
        if (!alive.current || !current.current.canManageQa || current.current.dirty) return;
        if (result.versionId !== id || result.draftRevision !== draftRevision)
          throw new UsClientError("us_plan_revision_conflict");
        setValidation(result);
        setUnavailable(result.publicationAvailability !== "available");
      } else if (operation === "approve") {
        const key = approvalIntentKey.current ?? crypto.randomUUID();
        approvalIntentKey.current = key;
        setAttempted(true);
        const receipt = await props.client.approvePlan(id, {
          expectedRevision: draftRevision,
          idempotencyKey: key,
          confirmations,
        });
        if (!alive.current) return;
        if (receipt.id !== id || receipt.versionNumber !== props.draft.versionNumber)
          throw new UsClientError("invalid_response");
        setCompleted(receipt);
        if (current.current.canManageQa && !current.current.dirty) await props.onApproved(receipt);
      } else if (operation === "discard") {
        await props.client.discardPlan(id, { expectedRevision: draftRevision });
        if (!alive.current) return;
        setCompleted("discarded");
        await props.onDiscarded();
      } else if (operation === "refresh") {
        if (completed === "discarded") await props.onDiscarded();
        else if (completed) await props.onApproved(completed);
      } else {
        await props.onReload();
        if (!alive.current) return;
        setStale(false);
        setUnavailable(false);
        setValidation(null);
        // A reload reconciles an ambiguous receipt. Keep its key until the saved
        // revision actually changes; changed payload reuse would conflict.
        setDialog(null);
      }
    } catch (value) {
      if (alive.current) await fail(value);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  function close() {
    if (busy.current) return;
    setDialog(null);
    if (!attempted) {
      setConfirmations(empty);
      setValidation(null);
    }
  }
  return (
    <section className="us-plan-approval" aria-label={t("usPlan.approvalActions")}>
      {props.canManageQa ? (
        <div className="us-plan-links">
          <Button
            disabled={blocked || pending || storageUnavailable || Boolean(completed)}
            onClick={() => {
              setError(null);
              setDialog("approve");
            }}
          >
            {t("usPlan.approve")}
          </Button>
          <Button
            variant="destructive"
            disabled={blocked || pending || Boolean(completed)}
            onClick={() => {
              setError(null);
              setDialog("discard");
            }}
          >
            {t("usPlan.discardDraft")}
          </Button>
          {completed ? (
            <Button disabled={pending || blocked} onClick={() => void run("refresh")}>
              {t("usPlan.refreshPublished")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.dirty || props.saving ? <p role="status">{t("usPlan.approvalSaveFirst")}</p> : null}
      {storageUnavailable ? <p>{t("usPlan.publicationUnavailable")}</p> : null}
      {completed ? <p role="status">{t("usPlan.refreshRequired")}</p> : null}
      {!dialog && error ? <p role="alert">{t(error)}</p> : null}
      <Modal
        open={dialog === "approve"}
        title={t("usPlan.approvalActions")}
        closeLabel={t("usPlan.cancel")}
        onClose={close}
        width={640}
        footer={
          <>
            <Button variant="secondary" disabled={pending} onClick={close}>
              {t("usPlan.cancel")}
            </Button>
            <Button disabled={!ready || pending} onClick={() => void run("approve")}>
              {t("usPlan.approve")}
            </Button>
          </>
        }
      >
        <div className="us-plan-approval-content">
          <p>{t("usPlan.savedRevision", { revision: props.draft.draftRevision })}</p>
          <p>{t("usPlan.selfApproval")}</p>
          <p>{t("usPlan.approvalActor")}</p>
          <p>{t("usPlan.confirmationHelp")}</p>
          {props.draft.provenance === "trusted_synthetic" ? <p>{t("usPlan.synthetic")}</p> : null}
          <fieldset className="us-plan-confirmations" disabled={blocked || pending || attempted}>
            <legend>{t("usPlan.freshConfirmations")}</legend>
            {checks.map((id) => (
              <Checkbox
                key={id}
                checked={confirmations[id]}
                disabled={blocked || pending || attempted}
                label={t(`usPlan.checks.${id}`)}
                onCheckedChange={(value) => {
                  setConfirmations((before) => ({ ...before, [id]: value }));
                  setValidation(null);
                }}
              />
            ))}
          </fieldset>
          <Button
            variant="secondary"
            disabled={blocked || pending || storageUnavailable || stale || Boolean(completed)}
            onClick={() => void run("validate")}
          >
            {t("usPlan.checkApproval")}
          </Button>
          {pending ? <p role="status">{t("usPlan.approvalPending")}</p> : null}
          {error ? <p role="alert">{t(error)}</p> : null}
          {storageUnavailable ? <p>{t("usPlan.publicationUnavailable")}</p> : null}
          {validation ? (
            <div role="status">
              <p>{t("usPlan.validatedRevision", { revision: validation.draftRevision })}</p>
              {validation.issues.length ? (
                <ul className="us-plan-issues">
                  {validation.issues.map((issue, index) => (
                    <li key={index}>
                      {t(
                        issue.section === "plan"
                          ? "usPlan.title"
                          : `usPlan.fields.${issue.section}`,
                      )}
                      :{" "}
                      {t(
                        `usPlan.issues.${Object.hasOwn(planCopy["en-US"].issues, issue.code) ? issue.code : "unknown"}`,
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t("usPlan.approvalReady")}</p>
              )}
            </div>
          ) : null}
          {stale || unavailable ? (
            <Button
              variant="secondary"
              disabled={pending || blocked}
              onClick={() => void run("reload")}
            >
              {t("usPlan.reloadSaved")}
            </Button>
          ) : null}
          {completed ? (
            <Button disabled={pending || blocked} onClick={() => void run("refresh")}>
              {t("usPlan.refreshPublished")}
            </Button>
          ) : null}
        </div>
      </Modal>
      <ConfirmDialog
        open={dialog === "discard"}
        title={t("usPlan.discardDraft")}
        description={t("usPlan.discardDescription", {
          revision: props.draft.draftRevision,
          version: props.draft.versionNumber,
        })}
        confirmLabel={completed ? t("usPlan.refreshPublished") : t("usPlan.discardDraft")}
        cancelLabel={t("usPlan.cancel")}
        tone="destructive"
        busy={pending}
        confirmDisabled={blocked}
        error={error ? t(error) : undefined}
        onCancel={close}
        onConfirm={() => void run(completed ? "refresh" : "discard")}
      />
    </section>
  );
}
