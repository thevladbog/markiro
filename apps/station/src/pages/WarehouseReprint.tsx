import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog, Input } from "@markiro/ui";
import type { StationClient } from "../lib/api-client.js";
import type { SqlExecutor } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { HardwareConfig } from "../lib/hardware-config.js";
import type { PrintTarget } from "../lib/hardware.js";
import type { CredentialGeneration, FloorWorkBarrier } from "../lib/credential-recovery.js";
import type { WarehouseWorkState, createWarehouseWork } from "../lib/warehouse-reprint/work.js";
import type { WarehouseSession } from "../lib/warehouse-reprint/types.js";
import { useWarehouseReprint } from "../lib/use-warehouse-reprint.js";
import { resolvePrinter } from "../lib/printer-routing.js";
import { resolveWarehouseReprintScan } from "@markiro/domain";
import { TemplatePicker } from "../ui/warehouse-reprint/TemplatePicker.js";
import { ReprintStatus } from "../ui/warehouse-reprint/ReprintStatus.js";
export interface WarehouseReprintProps {
  exec: SqlExecutor;
  client: StationClient;
  deviceId: string;
  operatorId: string;
  credentialGeneration: CredentialGeneration;
  source: ScanSource;
  hardwareConfig: HardwareConfig;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  onExit(): void;
  onJournalChange?: () => void;
  onSetup?(): void;
  onFloorWorkRegister?: (barrier: FloorWorkBarrier) => () => void;
}
export function WarehouseReprint(props: WarehouseReprintProps) {
  const options = useMemo(
    () => ({
      exec: props.exec,
      client: props.client,
      generation: props.credentialGeneration,
      deviceId: props.deviceId,
      operatorId: props.operatorId,
      hardware: () => props.hardwareConfig,
      print: (target: PrintTarget, bytes: Uint8Array) => props.print(target, bytes),
      onJournalChange: () => props.onJournalChange?.(),
    }),
    [props],
  );
  const { state, work } = useWarehouseReprint(options, props.onFloorWorkRegister);
  return <WarehouseReprintView {...props} state={state} work={work} />;
}
export function WarehouseReprintView(
  props: WarehouseReprintProps & {
    state: WarehouseWorkState;
    work: Pick<
      ReturnType<typeof createWarehouseWork>,
      | "scan"
      | "configure"
      | "newSession"
      | "start"
      | "close"
      | "requestVerification"
      | "cancelVerification"
      | "reprint"
      | "sendPrepared"
    >;
  },
) {
  const { t } = useTranslation();
  const [picker, setPicker] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [manualTouched, setManualTouched] = useState(false);
  const manualFormId = useId();
  const manualCode = manualValue.trim();
  const manualValid =
    manualCode.length > 0 && resolveWarehouseReprintScan(manualCode).kind !== "invalid";
  const closeManual = () => {
    setManual(false);
    setManualValue("");
    setManualTouched(false);
  };
  const [reasonDraft, setReason] = useState<WarehouseSession["reason"] | null>(null);
  const [reasonDialog, setReasonDialog] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState<WarehouseSession["reason"]>("not_printed");
  const { state, work } = props;
  const session = state.session;
  const reason = reasonDraft ?? session?.reason ?? "damaged";
  const unresolved =
    state.job &&
    ["prepared", "sending", "delivery_unknown", "failed_before_send"].includes(state.job.state);
  useEffect(() => {
    if (picker || reasonDialog || manual || state.busy || session?.status !== "active") return;
    props.source.clearPendingInput?.();
    return props.source.start((raw) => {
      void work.scan(raw);
    });
  }, [props.source, picker, reasonDialog, manual, state.busy, session?.status, work]);
  const editable = state.initialized && !state.busy && !unresolved;
  const manualAction = (
    <Button
      size="floor"
      variant="primary"
      disabled={!editable || state.verification || session?.status !== "active"}
      onClick={() => {
        setManualValue("");
        setManualTouched(false);
        setManual(true);
      }}
    >
      {t("warehouse.manualTitle")}
    </Button>
  );
  return (
    <main className="warehouse-reprint" data-testid="warehouse-reprint-screen">
      <header className="warehouse-heading">
        <div>
          <p>{t("inventory.warehouseTitle")}</p>
          <h1>{t("warehouse.title")}</h1>
        </div>
        <div className="warehouse-heading-actions">
          {manualAction}
          <Button
            size="floor"
            variant="secondary"
            disabled={state.busy}
            onClick={() => {
              void work.close().then(() => props.onExit());
            }}
          >
            {t("warehouse.pauseExit")}
          </Button>
        </div>
      </header>
      {state.error ? (
        <Alert tone="error">
          {t(`warehouse.errors.${state.error}`, {
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
        <div className="warehouse-main">
          {session?.status !== "active" && !unresolved ? (
            <section className="warehouse-session-setup">
              <h2>{t("warehouse.sessionSetup")}</h2>
              <p>{t("warehouse.sessionScope")}</p>
              <fieldset disabled={!editable}>
                <legend>{t("warehouse.reason")}</legend>
                <div className="warehouse-reasons">
                  {(["not_printed", "damaged", "lost"] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="session-reason"
                        value={value}
                        checked={reason === value}
                        onChange={() => setReason(value)}
                      />
                      {t(`warehouse.reasons.${value}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button
                size="floor"
                disabled={!editable || !session?.unitTemplate || !session.boxTemplate}
                onClick={() => {
                  if (session)
                    void work
                      .configure(reason, session.unitTemplate, session.boxTemplate)
                      .then(() => work.start());
                }}
              >
                {t("warehouse.start")}
              </Button>
            </section>
          ) : (
            <ReprintStatus
              job={state.job}
              duplicate={state.duplicate}
              verification={state.verification}
            />
          )}
          {state.busy ? <p role="status">{t("warehouse.working")}</p> : null}
          {state.job &&
          ["sent", "verified", "delivery_unknown", "failed_before_send", "prepared"].includes(
            state.job.state,
          ) ? (
            <div className="warehouse-recovery-actions">
              {session?.status !== "active" ? (
                <Button size="floor" onClick={() => void work.start()}>
                  {t("warehouse.resume")}
                </Button>
              ) : null}
              {state.job.state === "sent" || state.job.state === "delivery_unknown" ? (
                <Button
                  size="floor"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => work.requestVerification()}
                >
                  {t("warehouse.verifyButton")}
                </Button>
              ) : null}
              {state.verification ? (
                <Button size="floor" variant="secondary" onClick={() => work.cancelVerification()}>
                  {t("warehouse.cancelVerification")}
                </Button>
              ) : null}
              {state.job.state === "prepared" ? (
                <Button size="floor" disabled={state.busy} onClick={() => void work.sendPrepared()}>
                  {t("warehouse.sendPrepared")}
                </Button>
              ) : (
                <>
                  <label>
                    {t("warehouse.reprintReason")}
                    <select
                      value={recoveryReason}
                      disabled={state.busy}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "not_printed" || value === "damaged" || value === "lost")
                          setRecoveryReason(value);
                      }}
                    >
                      {(["not_printed", "damaged", "lost"] as const).map((value) => (
                        <option key={value} value={value}>
                          {t(`warehouse.reasons.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="floor"
                    disabled={state.busy}
                    onClick={() => void work.reprint(recoveryReason)}
                  >
                    {t("warehouse.reprintButton")}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
        <aside className="warehouse-session-panel">
          <h2>{t("warehouse.session")}</h2>
          {state.historyIssue ? (
            <Alert tone="warn">
              {t("warehouse.historyProblem", {
                reason: t(`warehouse.historyReasons.${state.historyIssue}`, {
                  defaultValue: state.historyIssue,
                }),
              })}
            </Alert>
          ) : null}
          <p>
            {t("warehouse.reason")}: {t(`warehouse.reasons.${session?.reason ?? reason}`)}
          </p>
          <strong className="warehouse-sent-count">{session?.sentCount ?? 0}</strong>
          <p>{t("warehouse.sentCount")}</p>
          <p>{t("warehouse.unitSelected", { name: session?.unitTemplate?.name ?? "—" })}</p>
          <p>{t("warehouse.boxSelected", { name: session?.boxTemplate?.name ?? "—" })}</p>
          <Button
            size="floor"
            variant="secondary"
            disabled={!editable || !state.catalog}
            onClick={() => setPicker(true)}
          >
            {t("warehouse.chooseTemplates")}
          </Button>
          <p className="warehouse-session-note">{t("warehouse.independent")}</p>
        </aside>
      </div>
      <footer className="warehouse-footer">
        <Button
          size="floor"
          variant="secondary"
          disabled={!editable}
          onClick={() => setReasonDialog(true)}
        >
          {t("warehouse.changeReason")}
        </Button>
        <Button
          size="floor"
          variant="secondary"
          disabled={!editable}
          onClick={() => void work.newSession()}
        >
          {t("warehouse.newSession")}
        </Button>
      </footer>
      {manual ? (
        <FullScreenDialog
          open
          title={t("warehouse.manualTitle")}
          onClose={closeManual}
          backLabel={t("warehouse.cancel")}
          backPlacement="footer"
          footer={
            <Button
              size="floor"
              type="submit"
              form={manualFormId}
              disabled={!editable || state.verification || !manualValid}
            >
              {t("warehouse.manualSubmit")}
            </Button>
          }
        >
          <form
            id={manualFormId}
            className="warehouse-manual-form"
            onSubmit={(event) => {
              event.preventDefault();
              setManualTouched(true);
              if (!editable || state.verification || session?.status !== "active" || !manualValid)
                return;
              closeManual();
              void work.scan(manualCode);
            }}
          >
            <p>{t("warehouse.manualIntro")}</p>
            <Input
              size="floor"
              mono
              label={t("warehouse.manualLabel")}
              hint={t("warehouse.manualHint")}
              {...(manualTouched && !manualValid ? { error: t("warehouse.manualInvalid") } : {})}
              value={manualValue}
              maxLength={2048}
              spellCheck={false}
              onChange={(event) => setManualValue(event.target.value)}
              onBlur={() => setManualTouched(true)}
            />
            <p>{t("warehouse.manualEffect")}</p>
          </form>
        </FullScreenDialog>
      ) : null}
      {reasonDialog ? (
        <FullScreenDialog
          open
          title={t("warehouse.changeReason")}
          onClose={() => {
            setReasonDialog(false);
            setReason(null);
          }}
          backLabel={t("warehouse.cancel")}
          footer={
            <Button
              size="floor"
              disabled={!editable}
              onClick={() => {
                if (session)
                  void work
                    .configure(reason, session.unitTemplate, session.boxTemplate)
                    .then(() => {
                      setReasonDialog(false);
                      setReason(null);
                    });
              }}
            >
              {t("warehouse.applyReason")}
            </Button>
          }
        >
          <fieldset>
            <legend>{t("warehouse.reason")}</legend>
            <div className="warehouse-reasons">
              {(["not_printed", "damaged", "lost"] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="reason-draft"
                    checked={reason === value}
                    onChange={() => setReason(value)}
                  />
                  {t(`warehouse.reasons.${value}`)}
                </label>
              ))}
            </div>
          </fieldset>
        </FullScreenDialog>
      ) : null}
      {picker && state.catalog ? (
        <TemplatePicker
          catalog={state.catalog}
          unitDpi={resolvePrinter(props.hardwareConfig, "duplicate")?.dpi ?? null}
          boxDpi={resolvePrinter(props.hardwareConfig, "box")?.dpi ?? null}
          unitTemplate={session?.unitTemplate ?? null}
          boxTemplate={session?.boxTemplate ?? null}
          onCancel={() => setPicker(false)}
          onApply={(unit, box) => {
            void work.configure(reason, unit, box).then(() => setPicker(false));
          }}
        />
      ) : null}
    </main>
  );
}
