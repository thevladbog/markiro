import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, Select, Textarea } from "@markiro/ui";
import {
  createTraceabilityLotSchema,
  patchLotSourceSchema,
  postLotStatusSchema,
  type TraceabilityLot,
  type TraceabilityLotSource,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, UsLotDuplicateError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { LotReferencePicker } from "./reference-picker.js";
import { allowedLotStatuses } from "./shared.js";

export type LotEditorMode =
  { kind: "create" } | { kind: "source" | "status"; lot: TraceabilityLot };
type Props = MasterDataViewProps & {
  mode: LotEditorMode;
  canManageQa: boolean;
  onCancel: () => void;
  onDone: (lot: TraceabilityLot, notice: string | null) => void;
  onInvalidate: () => void;
};

export function LotEditor({
  mode,
  client,
  canWrite,
  canManageQa,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onForbidden,
  onSessionLost,
  onCancel,
  onDone,
  onInvalidate,
}: Props) {
  const { t } = useTranslation();
  const lot = mode.kind === "create" ? null : mode.lot;
  const initialSource = lot?.source ?? null;
  const [productId, setProductId] = useState(lot?.productId ?? "");
  const [tlc, setTlc] = useState(lot?.tlc ?? "");
  const [sourceKind, setSourceKind] = useState(initialSource?.kind ?? "absent");
  const [locationId, setLocationId] = useState(
    initialSource?.kind === "location"
      ? initialSource.locationId
      : (initialSource?.resolvedLocationId ?? ""),
  );
  const [referenceValue, setReferenceValue] = useState(
    initialSource?.kind === "reference" ? initialSource.referenceValue : "",
  );
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const alert = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const permitted = mode.kind === "status" ? canManageQa : canWrite;
  const disabled = pending || mutationPending || !permitted;
  const source: TraceabilityLotSource =
    sourceKind === "absent"
      ? null
      : sourceKind === "location"
        ? { kind: "location", locationId }
        : {
            kind: "reference",
            referenceKind: "web_url",
            referenceValue,
            resolvedLocationId: locationId,
          };
  const sourceChanged = JSON.stringify(source) !== JSON.stringify(initialSource);
  const dirty =
    reason !== "" ||
    status !== "" ||
    sourceChanged ||
    tlc !== (lot?.tlc ?? "") ||
    productId !== (lot?.productId ?? "") ||
    referenceValue !== (initialSource?.kind === "reference" ? initialSource.referenceValue : "");
  const unchanged = mode.kind === "source" && !sourceChanged;

  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (failure && !pending) alert.current?.focus();
  }, [failure, pending]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, pending]);

  function cancel() {
    if (busy.current || mutationPending || (dirty && !window.confirm(t("md.discardConfirm"))))
      return;
    onCancel();
  }

  async function reload(id: string) {
    if (busy.current || mutationPending || (dirty && !window.confirm(t("md.discardConfirm"))))
      return;
    busy.current = true;
    setPending(true);
    const release = beginMutation();
    try {
      const result = await client.getLot(id);
      if (alive.current) onDone(result, null);
    } catch (error) {
      if (!alive.current) return;
      setFailure("reloadError");
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || mutationPending || !permitted || blocked || unchanged) return;
    const parsed =
      mode.kind === "create"
        ? createTraceabilityLotSchema.safeParse({
            productId,
            tlc,
            source,
            assignmentBasis: "imported",
          })
        : mode.kind === "source"
          ? patchLotSourceSchema.safeParse({ source, reason, expectedRevision: mode.lot.revision })
          : postLotStatusSchema.safeParse({ status, reason, expectedRevision: mode.lot.revision });
    if (!parsed.success) {
      setFailure("invalid");
      alert.current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    setFailure(null);
    setDuplicateId(null);
    const release = beginMutation();
    try {
      const result =
        mode.kind === "create"
          ? await client.createLot(parsed.data)
          : mode.kind === "source"
            ? await client.changeLotSource(mode.lot.id, parsed.data)
            : await client.changeLotStatus(mode.lot.id, parsed.data);
      if (alive.current)
        onDone(
          result,
          mode.kind === "create"
            ? "lots.saved"
            : mode.kind === "source"
              ? "lots.corrected"
              : "lots.statusSaved",
        );
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof UsLotDuplicateError) {
        setDuplicateId(error.existingId);
        setFailure("duplicate");
      } else if (error instanceof UsClientError && error.code === "session_required")
        onSessionLost();
      else if (error instanceof UsClientError && error.code === "forbidden") {
        setFailure("permission");
        await onForbidden();
      } else if (
        error instanceof UsClientError &&
        ["lot_revision_conflict", "conflict", "lot_source_locked"].includes(error.code)
      ) {
        setBlocked(true);
        onInvalidate();
        setFailure(error.code === "lot_source_locked" ? "locked" : "conflict");
      } else if (error instanceof UsClientError && error.code === "lot_reference_archived")
        setFailure("archivedReference");
      else {
        setFailure("failed");
        if (lot) {
          setBlocked(true);
          onInvalidate();
        }
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }

  const title =
    mode.kind === "create" ? "add" : mode.kind === "source" ? "correct" : "changeStatus";
  const pickerProps = { client, disabled, onForbidden, onSessionLost };
  return (
    <div className="us-lot-page" aria-busy={pending}>
      <Button variant="secondary" disabled={pending || mutationPending} onClick={cancel}>
        ← {t("md.cancel")}
      </Button>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t(`lots.${title}`)}
          </h1>
          {mode.kind !== "create" ? (
            <p>{t(mode.kind === "source" ? "lots.sourceIntro" : "lots.statusIntro")}</p>
          ) : null}
        </div>
      </header>
      <form className="us-md-form us-lot-panel" noValidate onSubmit={(event) => void submit(event)}>
        {failure ? (
          <p ref={alert} role="alert" tabIndex={-1} className="us-md-field-error">
            {t(`lots.${failure}`)}
          </p>
        ) : null}
        {!permitted ? <p role="status">{t("lots.permission")}</p> : null}
        {lot ? (
          <dl className="us-lot-facts">
            <div>
              <dt>{t("lots.tlc")}</dt>
              <dd>{lot.tlc}</dd>
            </div>
            <div>
              <dt>{t("lots.revision")}</dt>
              <dd>{lot.revision}</dd>
            </div>
            <div>
              <dt>{t("lots.currentStatus")}</dt>
              <dd>{t(`lots.states.${lot.status}`)}</dd>
            </div>
          </dl>
        ) : (
          <>
            <LotReferencePicker
              {...pickerProps}
              kind="product"
              label={t("lots.product")}
              value={productId}
              onChange={setProductId}
            />
            <Input
              label={t("lots.tlc")}
              required
              disabled={disabled}
              value={tlc}
              onChange={(event) => setTlc(event.target.value)}
            />
            <Input label={t("lots.basis")} readOnly value={t("lots.imported")} />
          </>
        )}
        {mode.kind !== "status" ? (
          <>
            <Select
              native
              label={t("lots.sourceKind")}
              disabled={disabled}
              value={sourceKind}
              onValueChange={setSourceKind}
              options={["absent", "location", "reference"].map((value) => ({
                value,
                label: t(`lots.${value}`),
              }))}
            />
            {sourceKind === "reference" ? (
              <Input
                label={t("lots.referenceValue")}
                value={referenceValue}
                disabled={disabled}
                required
                maxLength={1024}
                hint={t("lots.referenceHint")}
                onChange={(event) => setReferenceValue(event.target.value)}
              />
            ) : null}
            {sourceKind !== "absent" ? (
              <LotReferencePicker
                {...pickerProps}
                kind="location"
                label={t(sourceKind === "reference" ? "lots.resolvedLocation" : "lots.location")}
                value={locationId}
                onChange={setLocationId}
              />
            ) : null}
          </>
        ) : (
          <Select
            native
            label={t("lots.newStatus")}
            required
            disabled={disabled}
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "", label: t("lots.choose") },
              ...allowedLotStatuses(mode.lot).map((value) => ({
                value,
                label: t(`lots.states.${value}`),
              })),
            ]}
          />
        )}
        {lot ? (
          <>
            <Textarea
              label={t("lots.reason")}
              required
              maxLength={2000}
              value={reason}
              disabled={disabled}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="us-lot-note">{t("lots.auditNote")}</p>
          </>
        ) : null}
        <div className="us-lot-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={pending || mutationPending}
            onClick={cancel}
          >
            {t("md.cancel")}
          </Button>
          <Button type="submit" loading={pending} disabled={disabled || blocked || unchanged}>
            {t(
              mode.kind === "create"
                ? "lots.save"
                : mode.kind === "source"
                  ? "lots.saveSource"
                  : "lots.saveStatus",
            )}
          </Button>
          {lot && blocked ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending || mutationPending}
              onClick={() => void reload(lot.id)}
            >
              {t("lots.reload")}
            </Button>
          ) : null}
          {duplicateId ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending || mutationPending}
              onClick={() => void reload(duplicateId)}
            >
              {t("lots.openExisting")}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
