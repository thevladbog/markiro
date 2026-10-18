import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, Select, FullScreenDialog } from "@markiro/ui";
import {
  formatLabelDate,
  shelfLifeExpiryDate,
  warehouseReasonSchema,
  resolveWarehouseReprintScan,
  makePalletRenderingV2,
} from "@markiro/domain";
import type { WarehouseReprintProps } from "../../pages/WarehouseReprint.js";
import type {
  createWarehousePalletWork,
  PalletWorkState,
} from "../../lib/warehouse-reprint/pallet-work.js";
import { resolvePrinter } from "../../lib/printer-routing.js";
import {
  palletTemplateUnavailable,
  previewPalletRendering,
} from "../../lib/warehouse-reprint/pallet-rendering.js";
import { LabelRasterPreview } from "../LabelRasterPreview.js";
import { WindowsDeliveryStatus } from "../WindowsDeliveryStatus.js";
import { BarcodeIcon } from "../BarcodeIcon.js";
import { PalletTemplatePicker } from "./PalletTemplatePicker.js";
import { PalletDeliveryRecovery } from "./PalletDeliveryRecovery.js";
export function PalletConfirmation(
  props: WarehouseReprintProps & {
    state: PalletWorkState;
    work: ReturnType<typeof createWarehousePalletWork>;
    onFinish: () => Promise<void>;
    modeBusy: boolean;
  },
) {
  const { t } = useTranslation(),
    { state, work } = props;
  const [raw, setRaw] = useState(""),
    [preview, setPreview] = useState<Uint8Array | null>(null),
    [previewError, setPreviewError] = useState(false),
    [dialog, setDialog] = useState<
      "manual" | "reason" | "picker" | "retry" | "skip" | "finish" | null
    >(null),
    [originalResolution, setOriginalResolution] = useState<"confirmed" | "skipped" | null>(null),
    [reason, setReason] = useState(state.reason),
    formId = useId();
  const source = state.selection?.source ?? state.job?.source;
  const unresolved = Boolean(
    state.job &&
    ["prepared", "sending", "failed_before_send", "delivery_unknown"].includes(state.job.state),
  );
  const busy = state.busy || props.modeBusy,
    editable = state.initialized && !busy && !unresolved;
  const printer =
    (unresolved ? state.job?.profile : resolvePrinter(props.hardwareConfig, "pallet")) ?? null;
  const saved = useMemo(() => {
    if (state.selection && state.choice)
      return makePalletRenderingV2(state.selection.source, state.choice).rendering;
    return state.job?.rendering?.rendering ?? source?.rendering;
  }, [state.selection, state.choice, state.job?.rendering, source]);
  const selectedName = state.selection
    ? state.choice?.id === null
      ? t("warehouse.pallet.original")
      : state.choice?.name
    : state.job?.rendering?.templateId === null
      ? t("warehouse.pallet.original")
      : state.job?.rendering?.templateName;
  const unavailable =
    state.selection && state.choice
      ? palletTemplateUnavailable(state.selection.source, state.choice, printer)
      : null;
  useEffect(() => {
    if (!state.initialized || busy || dialog || originalResolution) return;
    props.source.clearPendingInput?.();
    return props.source.start((value) => void work.scan(value));
  }, [props.source, state.initialized, busy, dialog, originalResolution, work]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError(false);
    if (saved)
      void previewPalletRendering(saved, printer?.dpi ?? null)
        .then((bytes) => {
          if (active) setPreview(bytes);
        })
        .catch(() => {
          if (active) setPreviewError(true);
        });
    return () => {
      active = false;
    };
  }, [saved, printer?.dpi]);
  const name =
    saved?.kind === "a4"
      ? saved.facts.productPrintName
      : saved?.fields["product.printName"] || saved?.fields["product.name"];
  const production =
    saved?.kind === "a4"
      ? saved.facts.productionDate
        ? formatLabelDate(saved.facts.productionDate)
        : ""
      : saved?.fields.date;
  const expiryIso =
    saved?.kind === "a4" && saved.facts.productionDate
      ? shelfLifeExpiryDate(saved.facts.productionDate, saved.facts.shelfLifeDays)
      : null;
  const expiry =
    saved?.kind === "a4" ? (expiryIso ? formatLabelDate(expiryIso) : "") : saved?.fields.expiry;
  const diagnostic = state.diagnostic;
  const canResolve =
    diagnostic &&
    diagnostic.originDeviceId === props.deviceId &&
    diagnostic.sourceRevision &&
    diagnostic.attemptId &&
    diagnostic.productionSequence &&
    ["delivery_unknown", "failed_before_send"].includes(diagnostic.kind);
  const close = () => {
    setDialog(null);
    setRaw("");
  };
  return (
    <main className="warehouse-reprint" data-testid="warehouse-pallet-screen">
      <header className="warehouse-heading">
        <div>
          <p>{t("inventory.warehouseTitle")}</p>
          <h1>{t("warehouse.pallet.title")}</h1>
        </div>
        <div className="warehouse-heading-actions">
          <Button
            size="floor"
            variant="primary"
            disabled={!editable || state.verification}
            onClick={() => {
              setRaw("");
              setDialog("manual");
            }}
          >
            {t("warehouse.manualTitle")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={busy}
            onClick={() => void work.close().then(() => props.onExit())}
          >
            {t("warehouse.pauseExit")}
          </Button>
        </div>
      </header>
      {state.error && !diagnostic ? (
        <Alert tone="error">
          {t("warehouse.errors." + state.error, {
            defaultValue: t("warehouse.errors.WAREHOUSE_OPERATION_FAILED"),
          })}
          {props.onSetup && state.error.includes("PRINTER") ? (
            <Button size="floor" onClick={() => props.onSetup?.()}>
              {t("warehouse.setupPrinter")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      <div className="warehouse-work-grid">
        <section className="warehouse-main">
          {diagnostic ? (
            <section className="warehouse-pallet-diagnostic">
              <Alert tone="warn">{t("warehouse.pallet.diagnostics." + diagnostic.kind)}</Alert>
              <dl className="warehouse-pallet-facts">
                <dt>SSCC</dt>
                <dd>{diagnostic.sscc}</dd>
                <dt>{t("warehouse.pallet.origin")}</dt>
                <dd>
                  {diagnostic.originDeviceId === props.deviceId
                    ? t("warehouse.pallet.thisStation")
                    : (diagnostic.originDeviceId ?? "—")}
                </dd>
                <dt>{t("warehouse.pallet.shift")}</dt>
                <dd>{state.diagnosticShiftNumber ?? t("warehouse.pallet.shiftUnavailable")}</dd>
                <dt>{t("warehouse.pallet.attempt")}</dt>
                <dd>{diagnostic.attemptId ?? "—"}</dd>
              </dl>
              <div className="warehouse-recovery-actions">
                <Button size="floor" disabled={busy} onClick={() => void work.refreshOriginal()}>
                  {t("warehouse.pallet.refreshStatus")}
                </Button>
                {canResolve ? (
                  <>
                    <Button
                      size="floor"
                      variant="secondary"
                      disabled={busy || diagnostic.kind === "failed_before_send"}
                      onClick={() => setOriginalResolution("confirmed")}
                    >
                      {t("warehouse.pallet.resolveConfirm")}
                    </Button>
                    <Button
                      size="floor"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setOriginalResolution("skipped")}
                    >
                      {t("warehouse.pallet.resolveSkip")}
                    </Button>
                  </>
                ) : diagnostic.originDeviceId !== props.deviceId &&
                  ["delivery_unknown", "failed_before_send"].includes(diagnostic.kind) ? (
                  <p>{t("warehouse.pallet.resolveAtOrigin")}</p>
                ) : null}
              </div>
            </section>
          ) : null}
          {state.selection?.offline ? (
            <Alert tone="warn">{t("warehouse.pallet.local")}</Alert>
          ) : null}
          {source && saved ? (
            <section className="warehouse-pallet-card" aria-live="polite">
              <div className="warehouse-pallet-content">
                <div className="warehouse-pallet-preview">
                  {preview ? (
                    <LabelRasterPreview bytes={preview} label={t("warehouse.pallet.preview")} />
                  ) : (
                    <p role="status">
                      {t(
                        previewError ? "warehouse.pallet.previewError" : "warehouse.previewLoading",
                      )}
                    </p>
                  )}
                </div>
                <div>
                  <h2>{name}</h2>
                  <dl className="warehouse-pallet-facts">
                    <dt>SSCC</dt>
                    <dd>{source.sscc}</dd>
                    <dt>{t("warehouse.pallet.boxes")}</dt>
                    <dd>{source.boxCount}</dd>
                    <dt>{t("warehouse.pallet.units")}</dt>
                    <dd>{source.itemCount}</dd>
                    {production ? (
                      <>
                        <dt>{t("warehouse.pallet.date")}</dt>
                        <dd>{production}</dd>
                      </>
                    ) : null}
                    {expiry ? (
                      <>
                        <dt>{t("warehouse.pallet.expiry")}</dt>
                        <dd>{expiry}</dd>
                      </>
                    ) : null}
                    <dt>{t("warehouse.pallet.template")}</dt>
                    <dd>
                      {selectedName ??
                        (saved.kind === "a4" ? saved.template.name : t("warehouse.pallet.thermal"))}
                    </dd>
                    <dt>{t("warehouse.pallet.printer")}</dt>
                    <dd>{printer?.name ?? t("warehouse.errors.WAREHOUSE_PRINTER_UNCONFIGURED")}</dd>
                  </dl>
                </div>
              </div>
              {state.verification ? (
                <Alert tone="info">{t("warehouse.pallet.verifyHint")}</Alert>
              ) : null}
              {state.job && !state.selection ? (
                <Alert
                  tone={
                    state.job.state === "failed_before_send"
                      ? "error"
                      : state.job.state === "delivery_unknown"
                        ? "warn"
                        : "info"
                  }
                >
                  {t("warehouse.pallet.states." + state.job.state)}
                </Alert>
              ) : null}
              {unavailable ? (
                <Alert tone="warn">{t("warehouse.errors." + unavailable)}</Alert>
              ) : null}
              <p className="warehouse-session-note">
                {saved.kind === "a4"
                  ? t("warehouse.pallet.sheetCount", { copies: saved.template.spec.page.copies })
                  : `${printer?.language.toUpperCase() ?? "—"} · ${printer?.dpi ?? "—"} dpi`}
              </p>
              <div className="warehouse-pallet-actions">
                {state.selection ? (
                  <>
                    <Button
                      size="floor"
                      disabled={!editable || !preview || previewError || Boolean(unavailable)}
                      onClick={() => void work.confirm(source.revision)}
                    >
                      {t("warehouse.pallet.confirm")}
                    </Button>
                    <Button
                      size="floor"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => work.cancel()}
                    >
                      {t("warehouse.cancel")}
                    </Button>
                  </>
                ) : null}
                {state.job &&
                ["prepared", "failed_before_send", "delivery_unknown"].includes(state.job.state) ? (
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setDialog("retry")}
                  >
                    {t("warehouse.pallet.retry")}
                  </Button>
                ) : null}
                {state.job && ["sent", "delivery_unknown"].includes(state.job.state) ? (
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => work.verify()}
                  >
                    {t("warehouse.pallet.verify")}
                  </Button>
                ) : null}
                {state.verification ? (
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => work.cancelVerification()}
                  >
                    {t("warehouse.cancelVerification")}
                  </Button>
                ) : null}
                {unresolved ? (
                  <Button
                    size="floor"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setDialog("skip")}
                  >
                    {t("warehouse.pallet.skip")}
                  </Button>
                ) : null}
              </div>
            </section>
          ) : !diagnostic ? (
            <section className="warehouse-status">
              <BarcodeIcon className="warehouse-scan-mark" />
              <h2>{t("warehouse.pallet.scan")}</h2>
              <p>{t("warehouse.pallet.empty")}</p>
            </section>
          ) : null}
          {state.job ? (
            <WindowsDeliveryStatus
              exec={props.exec}
              scope={state.job.deliveryScope}
              purpose="pallet"
              jobId={state.job.source.sscc}
              revision={state.job.state}
            />
          ) : null}
          {busy ? <p role="status">{t("warehouse.working")}</p> : null}
        </section>
        <aside className="warehouse-session-panel">
          <h2>{t("warehouse.session")}</h2>
          <p>
            {t("warehouse.reason")}: {t("warehouse.reasons." + state.reason)}
          </p>
          <strong className="warehouse-sent-count">{state.session?.sentCount ?? 0}</strong>
          <p>{t("warehouse.sentCount")}</p>
          <p>
            {t("warehouse.pallet.template")}: {selectedName ?? t("warehouse.pallet.original")}
          </p>
          <p>
            {t("warehouse.pallet.printer")}: {printer?.name ?? "—"}
          </p>
          <Button
            size="floor"
            variant="secondary"
            disabled={!editable || !state.selection}
            onClick={() => {
              setDialog("picker");
              void work.refreshTemplates();
            }}
          >
            {t("warehouse.chooseTemplates")}
          </Button>
          {!state.selection ? (
            <p className="warehouse-session-note">
              {t(
                diagnostic?.kind === "sync_pending"
                  ? "warehouse.pallet.pickAfterSync"
                  : "warehouse.pallet.pickAfterLookup",
              )}
            </p>
          ) : !state.catalog ? (
            <p className="warehouse-session-note">{t("warehouse.pallet.v2Unavailable")}</p>
          ) : null}
          {props.onSetup ? (
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => props.onSetup?.()}
            >
              {t("warehouse.setupPrinter")}
            </Button>
          ) : null}
          <p className="warehouse-session-note">{t("warehouse.independent")}</p>
        </aside>
      </div>
      <footer className="warehouse-footer">
        <Button
          size="floor"
          variant="secondary"
          disabled={!editable}
          onClick={() => {
            setReason(state.reason);
            setDialog("reason");
          }}
        >
          {t("warehouse.changeReason")}
        </Button>
        <Button
          size="floor"
          variant="secondary"
          disabled={!editable}
          onClick={() => setDialog("finish")}
        >
          {t("warehouse.finishSession")}
        </Button>
      </footer>
      {dialog === "manual" ? (
        <FullScreenDialog
          open
          title={t("warehouse.manualTitle")}
          onClose={close}
          backLabel={t("warehouse.cancel")}
          footer={
            <Button
              size="floor"
              type="submit"
              form={formId}
              disabled={!editable || resolveWarehouseReprintScan(raw.trim()).kind === "invalid"}
            >
              {t("warehouse.pallet.find")}
            </Button>
          }
        >
          <form
            id={formId}
            className="warehouse-manual-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editable || resolveWarehouseReprintScan(raw.trim()).kind === "invalid") return;
              close();
              void work.scan(raw.trim());
            }}
          >
            <p>{t("warehouse.pallet.empty")}</p>
            <Input
              size="floor"
              mono
              label={t("warehouse.pallet.scan")}
              value={raw}
              maxLength={2048}
              onChange={(e) => setRaw(e.currentTarget.value)}
            />
          </form>
        </FullScreenDialog>
      ) : null}
      {dialog === "reason" ? (
        <FullScreenDialog
          open
          title={t("warehouse.changeReason")}
          onClose={close}
          backLabel={t("warehouse.cancel")}
          footer={
            <Button
              size="floor"
              disabled={!editable}
              onClick={() => void work.setReason(reason).then(close)}
            >
              {t("warehouse.applyReason")}
            </Button>
          }
        >
          <div className="warehouse-confirm-body">
            <Select
              label={t("warehouse.reason")}
              value={reason}
              options={(["not_printed", "damaged", "lost"] as const).map((value) => ({
                value,
                label: t("warehouse.reasons." + value),
              }))}
              onValueChange={(value) => setReason(warehouseReasonSchema.parse(value))}
            />
          </div>
        </FullScreenDialog>
      ) : null}
      {dialog === "picker" && state.selection ? (
        <PalletTemplatePicker
          source={state.selection.source}
          catalog={state.catalog}
          choice={state.choice}
          profile={printer}
          busy={busy}
          onClose={close}
          onRefresh={() => void work.refreshTemplates()}
          error={state.error}
          onApply={(choice) =>
            void work.selectTemplate(choice).then(() => {
              if (!work.getSnapshot().error) close();
            })
          }
        />
      ) : null}
      {dialog === "retry" || dialog === "skip" || dialog === "finish" ? (
        <FullScreenDialog
          open
          title={t(
            dialog === "retry"
              ? "warehouse.pallet.retry"
              : dialog === "skip"
                ? "warehouse.pallet.skip"
                : "warehouse.finishSession",
          )}
          onClose={close}
          backLabel={t("warehouse.cancel")}
          backDisabled={busy}
          footer={
            <Button
              size="floor"
              disabled={busy || (dialog === "finish" && unresolved)}
              onClick={() => {
                const d = dialog;
                close();
                if (d === "retry") void work.retry();
                else if (d === "skip") void work.skip();
                else void props.onFinish();
              }}
            >
              {t(
                dialog === "skip"
                  ? "warehouse.pallet.skip"
                  : dialog === "finish"
                    ? "warehouse.finishConfirm"
                    : "warehouse.pallet.confirm",
              )}
            </Button>
          }
        >
          <div className="warehouse-confirm-body">
            <p>
              {t(
                dialog === "finish"
                  ? "warehouse.finishCount"
                  : dialog === "skip"
                    ? "warehouse.pallet.skipHint"
                    : state.job?.state === "delivery_unknown"
                      ? "warehouse.pallet.unknownWarning"
                      : "warehouse.pallet.retryHint",
                { count: state.session?.sentCount ?? 0 },
              )}
            </p>
          </div>
        </FullScreenDialog>
      ) : null}
      {originalResolution && diagnostic ? (
        <PalletDeliveryRecovery
          diagnostic={diagnostic}
          outcome={originalResolution}
          source={props.source}
          busy={busy}
          onClose={() => setOriginalResolution(null)}
          error={state.error === "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED" ? null : state.error}
          onResolve={(scan, why) =>
            void work.resolveOriginal(originalResolution, scan, why).then(() => {
              if (!work.getSnapshot().error) setOriginalResolution(null);
            })
          }
        />
      ) : null}
    </main>
  );
}
