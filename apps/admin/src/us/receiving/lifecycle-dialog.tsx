import { useEffect, useRef, useState } from "react";
import { Button, Modal, Textarea } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import {
  amendReceivingSchema,
  voidReceivingSchema,
  receivingLiveRecordSchema,
  type AmendReceivingInput,
  type VoidReceivingInput,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { UsClientError, UsReceivingLifecycleError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingConflictDetails } from "./conflict-details.js";

type Command = { record: ReceivingLiveRecord } & (
  { action: "amend"; input: AmendReceivingInput } | { action: "void"; input: VoidReceivingInput }
);
type Props = Pick<
  MasterDataViewProps,
  "client" | "mutationPending" | "beginMutation" | "onForbidden" | "onSessionLost"
> & {
  record: ReceivingLiveRecord;
  disabled?: boolean;
  onOpenRecord: (record: ReceivingLiveRecord) => void;
};

/** Owns one explicit operation until its current-state read settles or is abandoned. */
export function ReceivingLifecycleActions({
  record,
  client,
  mutationPending,
  beginMutation,
  onForbidden,
  onSessionLost,
  onOpenRecord,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const [action, setAction] = useState<"amend" | "void" | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<"edit" | "unknown" | "read_failed" | "rejected">("edit");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [conflictDetail, setConflictDetail] = useState<UsReceivingLifecycleError["detail"] | null>(
    null,
  );
  const command = useRef<Command | null>(null);
  const acknowledged = useRef<ReceivingOperationReceiptV2 | null>(null);
  const release = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      command.current = null;
      acknowledged.current = null;
      release.current?.();
      release.current = null;
    };
  }, []);
  useEffect(() => {
    if (!action) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [action]);

  function reset() {
    command.current = null;
    acknowledged.current = null;
    release.current?.();
    release.current = null;
    setAction(null);
    setReason("");
    setPhase("edit");
    setConflictDetail(null);
  }
  async function denied(error: unknown) {
    if (!(error instanceof UsClientError)) return false;
    if (error.code === "session_required") {
      reset();
      onSessionLost();
      return true;
    }
    if (error.code === "forbidden") {
      reset();
      await onForbidden();
      return true;
    }
    return false;
  }
  async function loadPreview() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setPreviewFailed(false);
    setPreview(null);
    try {
      const lines = record.content.kind === "finalized" ? record.content.snapshot.items : [];
      const lots = [...new Map(lines.map((line) => [line.lotId, line.tlc])).entries()];
      const results = await Promise.all(
        lots.map(async ([id, tlc]) => {
          const basis = await client.getLotReceivingBasis(id, { limit: 1, offset: 0 });
          return basis.supportCount === 1 &&
            basis.items[0]?.eventId.toLowerCase() === record.id.toLowerCase()
            ? (tlc ?? id)
            : null;
        }),
      );
      if (alive.current) setPreview(results.filter((value): value is string => value !== null));
    } catch (error) {
      if (alive.current && !(await denied(error))) setPreviewFailed(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  function open(next: "amend" | "void") {
    if (busy.current || release.current || disabled || mutationPending) return;
    release.current = beginMutation();
    setAction(next);
    setPreview(null);
    setPreviewFailed(false);
    if (next === "void") void loadPreview();
  }
  function close() {
    if (busy.current) return;
    if (command.current && !window.confirm(t("receiving.leaveUncertain"))) return;
    reset();
  }
  async function settle(readOnly = false) {
    if (busy.current || !action || (action === "void" && preview === null && !readOnly)) return;
    if (!readOnly && !command.current) {
      const base = {
        commandVersion: 2,
        operationKey: crypto.randomUUID(),
        expectedLifecycleVersion: record.lifecycle.lifecycleVersion,
        reason,
      };
      const captured = receivingLiveRecordSchema.parse(record);
      if (action === "amend") {
        const parsed = amendReceivingSchema.safeParse(base);
        if (!parsed.success) return;
        command.current = { action, input: parsed.data, record: captured };
      } else {
        const parsed = voidReceivingSchema.safeParse({
          ...base,
          expectedDraftVersion: record.status === "draft" ? record.draftVersion : null,
        });
        if (!parsed.success) return;
        command.current = { action, input: parsed.data, record: captured };
      }
    }
    busy.current = true;
    setPending(true);
    try {
      const held = command.current;
      if (!readOnly && !acknowledged.current && held) {
        const result =
          held.action === "amend"
            ? await client.amendReceiving(held.record.id, held.input, held.record)
            : await client.voidReceiving(held.record.id, held.input, held.record);
        if (!alive.current) return;
        acknowledged.current = result;
      }
      const current = await client.getReceivingRecord(acknowledged.current?.eventId ?? record.id);
      if (!alive.current) return;
      reset();
      onOpenRecord(current);
    } catch (error) {
      if (!alive.current || (await denied(error))) return;
      if (!readOnly && !acknowledged.current && error instanceof UsReceivingLifecycleError)
        setConflictDetail(error.detail);
      setPhase(
        acknowledged.current
          ? "read_failed"
          : readOnly ||
              (error instanceof UsClientError &&
                !["unavailable", "invalid_response", "rate_limited"].includes(error.code))
            ? "rejected"
            : "unknown",
      );
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  const currentFinal =
    record.status === "finalized" &&
    record.lifecycle.currentEventId === record.id &&
    record.lifecycle.pendingDraftId === null;
  const pendingDraft = record.status === "draft" && record.lifecycle.pendingDraftId === record.id;
  if (!currentFinal && !pendingDraft) return null;
  const validReason = amendReceivingSchema.safeParse({
    commandVersion: 2,
    operationKey: record.id,
    expectedLifecycleVersion: record.lifecycle.lifecycleVersion,
    reason,
  }).success;
  return (
    <>
      <div className="us-rec-confirm-actions">
        {currentFinal ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || mutationPending}
            onClick={() => open("amend")}
          >
            {t("receiving.correctReceipt")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || mutationPending}
          onClick={() => open("void")}
        >
          {t("receiving.voidReceipt")}
        </Button>
      </div>
      {action ? (
        <Modal
          open
          title={t(action === "amend" ? "receiving.correctReceipt" : "receiving.voidReceipt")}
          closeLabel={t("receiving.cancel")}
          onClose={close}
          width={640}
          className="us-rec-confirm"
          footer={
            <div className="us-rec-confirm-actions">
              <Button type="button" variant="secondary" disabled={pending} onClick={close}>
                {t("receiving.cancel")}
              </Button>
              {phase === "read_failed" || phase === "rejected" ? (
                <Button type="button" disabled={pending} onClick={() => void settle(true)}>
                  {t(
                    phase === "read_failed" ? "receiving.retryCurrent" : "receiving.reloadCurrent",
                  )}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={pending || !validReason || (action === "void" && preview === null)}
                  onClick={() => void settle()}
                >
                  {t(
                    phase === "unknown"
                      ? "receiving.retryOperation"
                      : action === "amend"
                        ? "receiving.startCorrection"
                        : "receiving.confirmVoid",
                  )}
                </Button>
              )}
            </div>
          }
        >
          <p>
            {record.eventNumber} · {t("receiving.revision")} {record.revision}
          </p>
          <p>
            {t(
              action === "amend"
                ? "receiving.amendConsequence"
                : record.status === "draft"
                  ? "receiving.voidDraftConsequence"
                  : "receiving.voidConsequence",
            )}
          </p>
          {action === "void" ? (
            <section aria-live="polite">
              {previewFailed ? (
                <>
                  <p role="alert">{t("receiving.basisPreviewFailed")}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => void loadPreview()}
                  >
                    {t("receiving.retryBasisPreview")}
                  </Button>
                </>
              ) : preview === null ? (
                <p>{t("receiving.checkingBasis")}</p>
              ) : (
                <>
                  <h3>{t("receiving.losingBasis")}</h3>
                  {preview.length ? (
                    <ul>
                      {preview.map((label, index) => (
                        <li key={index}>{label}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t("receiving.noLostBasis")}</p>
                  )}
                  <p>{t("receiving.basisPreviewHint")}</p>
                </>
              )}
            </section>
          ) : null}
          <Textarea
            label={t("receiving.reason")}
            value={reason}
            maxLength={2000}
            disabled={pending || command.current !== null}
            onChange={(event) => setReason(event.target.value)}
          />
          {phase !== "edit" ? (
            <div role="alert">
              <p>
                {t(
                  phase === "read_failed"
                    ? "receiving.currentUnavailable"
                    : phase === "unknown"
                      ? "receiving.operationUnknown"
                      : "receiving.operationRejected",
                )}
              </p>
              <ReceivingConflictDetails detail={conflictDetail} />
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
