import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, Select, FullScreenDialog } from "@markiro/ui";
import {
  encodeMonoRaster,
  nominalSheetGeometry,
  renderMonoLabel,
  renderPalletSheet,
  withPrinterDpi,
  formatLabelDate,
  shelfLifeExpiryDate,
  warehouseReasonSchema,
} from "@markiro/domain";
import type { WarehouseReprintProps } from "../../pages/WarehouseReprint.js";
import type {
  createWarehousePalletWork,
  PalletWorkState,
} from "../../lib/warehouse-reprint/pallet-work.js";
import { parseOrganizationBranding } from "../../lib/organization-branding.js";
import { rasterizeDriverText } from "../../lib/rasterizer.js";
import { resolvePrinter, printerMode } from "../../lib/printer-routing.js";
import { LabelRasterPreview } from "../LabelRasterPreview.js";
import { WindowsDeliveryStatus } from "../WindowsDeliveryStatus.js";
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
    [skipDialog, setSkipDialog] = useState(false),
    [retryDialog, setRetryDialog] = useState(false);
  const source = state.selection?.source ?? state.job?.source;
  const unresolved =
    state.job &&
    ["prepared", "sending", "failed_before_send", "delivery_unknown"].includes(state.job.state);
  const busy = state.busy || props.modeBusy;
  const printer = unresolved ? state.job?.profile : resolvePrinter(props.hardwareConfig, "pallet");
  useEffect(() => {
    if (!state.initialized || busy || skipDialog || retryDialog) return;
    props.source.clearPendingInput?.();
    return props.source.start((value) => {
      void work.scan(value);
    });
  }, [props.source, state.initialized, busy, skipDialog, retryDialog, work]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError(false);
    if (!source) return;
    void (async () => {
      const saved = source.rendering,
        branding = saved.brandingJson ? parseOrganizationBranding(saved.brandingJson) : null;
      let page;
      if (saved.kind === "a4") {
        if (!branding) throw new Error("Missing saved branding");
        page = await renderPalletSheet(
          saved.template.spec,
          {
            ...saved.facts,
            organizationName: branding.organizationName,
            ...(branding.organizationInn !== undefined
              ? { organizationInn: branding.organizationInn }
              : {}),
            logo: branding.logo,
          },
          nominalSheetGeometry(saved.template.spec),
          rasterizeDriverText,
        );
      } else {
        page = await renderMonoLabel(
          withPrinterDpi(saved.template, printer?.dpi ?? saved.template.dpi),
          saved.fields,
          rasterizeDriverText,
          { logo: branding?.logo ?? null },
        );
      }
      if (active) setPreview(encodeMonoRaster(page));
    })().catch(() => {
      if (active) setPreviewError(true);
    });
    return () => {
      active = false;
    };
  }, [source, printer?.dpi]);
  const name =
    source?.rendering.kind === "a4"
      ? source.rendering.facts.productPrintName
      : source?.rendering.fields["product.printName"] || source?.rendering.fields["product.name"];
  const production =
    source?.rendering.kind === "a4"
      ? source.rendering.facts.productionDate
        ? formatLabelDate(source.rendering.facts.productionDate)
        : ""
      : source?.rendering.fields.date;
  const expiryIso =
    source?.rendering.kind === "a4" && source.rendering.facts.productionDate
      ? shelfLifeExpiryDate(
          source.rendering.facts.productionDate,
          source.rendering.facts.shelfLifeDays,
        )
      : null;
  const expiry =
    source?.rendering.kind === "a4"
      ? expiryIso
        ? formatLabelDate(expiryIso)
        : ""
      : source?.rendering.fields.expiry;
  return (
    <div className="warehouse-pallet-view">
      <header className="warehouse-header">
        <h1>{t("warehouse.pallet.title")}</h1>
        <Button
          size="floor"
          disabled={busy || Boolean(unresolved)}
          onClick={() => void props.onFinish()}
        >
          {t("warehouse.finishSession")}
        </Button>
      </header>
      {state.error ? (
        <Alert tone="error">
          {t(`warehouse.errors.${state.error}`, {
            defaultValue: t("warehouse.errors.WAREHOUSE_OPERATION_FAILED"),
          })}
        </Alert>
      ) : null}
      <form
        className="warehouse-pallet-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (raw.trim()) {
            void work.scan(raw.trim());
            setRaw("");
          }
        }}
      >
        <Input
          label={t("warehouse.pallet.scan")}
          value={raw}
          disabled={busy || Boolean(unresolved) || state.verification}
          onChange={(event) => setRaw(event.currentTarget.value)}
        />
        <Button
          type="submit"
          size="floor"
          disabled={busy || Boolean(unresolved) || state.verification || !raw.trim()}
        >
          {t("warehouse.pallet.find")}
        </Button>
      </form>
      <Select
        label={t("warehouse.reason")}
        value={state.reason}
        disabled={busy || Boolean(unresolved)}
        options={(["not_printed", "damaged", "lost"] as const).map((value) => ({
          value,
          label: t(`warehouse.reasons.${value}`),
        }))}
        onValueChange={(value) => void work.setReason(warehouseReasonSchema.parse(value))}
      />
      {state.selection?.offline ? <Alert tone="warn">{t("warehouse.pallet.local")}</Alert> : null}
      {source ? (
        <div className="warehouse-pallet-content">
          <div className="warehouse-pallet-preview">
            {preview ? (
              <LabelRasterPreview bytes={preview} label={t("warehouse.pallet.preview")} />
            ) : null}
            {previewError ? <Alert tone="error">{t("warehouse.pallet.previewError")}</Alert> : null}
          </div>
          <section>
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
                {source.rendering.kind === "a4"
                  ? source.rendering.template.name
                  : t("warehouse.pallet.thermal")}
              </dd>
              <dt>{t("warehouse.pallet.printer")}</dt>
              <dd>{printer?.name ?? t("warehouse.errors.WAREHOUSE_PRINTER_UNCONFIGURED")}</dd>
            </dl>
            {state.job ? (
              <Alert
                tone={
                  state.job.state === "sent" || state.job.state === "verified" ? "info" : "warn"
                }
              >
                {t(`warehouse.pallet.states.${state.job.state}`)}
              </Alert>
            ) : null}
            {state.job && printer && printerMode(printer) === "windows_driver" ? (
              <WindowsDeliveryStatus
                exec={props.exec}
                scope={state.job.deliveryScope}
                purpose="pallet"
                jobId={state.job.source.sscc}
                revision={`${state.job.jobId}:${state.job.state}`}
              />
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
            {state.verification ? (
              <>
                <Alert tone="info">{t("warehouse.pallet.verifyHint")}</Alert>
                <Button size="floor" onClick={() => work.cancelVerification()}>
                  {t("warehouse.cancel")}
                </Button>
              </>
            ) : null}
            <div className="warehouse-pallet-actions">
              {state.selection ? (
                <>
                  <Button
                    size="floor"
                    disabled={busy || !printer || previewError || !preview}
                    onClick={() => void work.confirm(source.revision)}
                  >
                    {t("warehouse.pallet.confirm")}
                  </Button>
                  <Button size="floor" disabled={busy} onClick={() => work.cancel()}>
                    {t("warehouse.cancel")}
                  </Button>
                </>
              ) : null}
              {state.job &&
              ["prepared", "failed_before_send", "delivery_unknown"].includes(state.job.state) ? (
                <Button
                  size="floor"
                  disabled={busy || state.verification}
                  onClick={() => setRetryDialog(true)}
                >
                  {t("warehouse.pallet.retry")}
                </Button>
              ) : null}
              {state.job && ["sent", "delivery_unknown"].includes(state.job.state) ? (
                <Button size="floor" disabled={busy} onClick={() => work.verify()}>
                  {t("warehouse.pallet.verify")}
                </Button>
              ) : null}
              {unresolved ? (
                <Button
                  size="floor"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setSkipDialog(true)}
                >
                  {t("warehouse.pallet.skip")}
                </Button>
              ) : null}
            </div>
          </section>
        </div>
      ) : (
        <Alert tone="info">{t("warehouse.pallet.empty")}</Alert>
      )}
      <FullScreenDialog
        open={retryDialog}
        onClose={() => setRetryDialog(false)}
        title={t("warehouse.pallet.retry")}
        footer={
          <>
            <Button size="floor" onClick={() => setRetryDialog(false)}>
              {t("warehouse.cancel")}
            </Button>
            <Button
              size="floor"
              onClick={() => {
                setRetryDialog(false);
                void work.retry();
              }}
            >
              {t("warehouse.pallet.confirm")}
            </Button>
          </>
        }
      >
        <p>
          {t(
            state.job?.state === "delivery_unknown"
              ? "warehouse.pallet.unknownWarning"
              : "warehouse.pallet.retryHint",
          )}
        </p>
      </FullScreenDialog>
      <FullScreenDialog
        open={skipDialog}
        onClose={() => setSkipDialog(false)}
        title={t("warehouse.pallet.skip")}
        footer={
          <>
            <Button size="floor" onClick={() => setSkipDialog(false)}>
              {t("warehouse.cancel")}
            </Button>
            <Button
              size="floor"
              onClick={() => {
                setSkipDialog(false);
                void work.skip();
              }}
            >
              {t("warehouse.pallet.skip")}
            </Button>
          </>
        }
      >
        <p>{t("warehouse.pallet.skipHint")}</p>
      </FullScreenDialog>
    </div>
  );
}
