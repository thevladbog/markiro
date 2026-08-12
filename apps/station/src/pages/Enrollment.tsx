import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, PinPad } from "@markiro/ui";
import { createStationClient } from "../lib/api-client.js";
import { writeConfig } from "../lib/config.js";
import {
  persistStationProvisioning,
  redeemStationPairing,
  type PairingError,
} from "../lib/pairing.js";
import { tauriExecutor } from "../lib/sqlite.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { SealedWorkSummary } from "../lib/credential-recovery.js";
import { StationBrand } from "../ui/StationBrand.js";

export interface EnrollmentProps {
  machineId: string;
  /** Pins recovery pairing to the device record that owns the local queue. */
  expectedDeviceId?: string;
  sealedWork?: SealedWorkSummary;
  onEnrolled: () => void;
  pairingServerUrl: string | null;
  onSetup?: () => void;
  scanSource?: ScanSource;
  /** Serializes credential/config persistence with any identity migration. */
  runConfigTransition?: (transition: () => Promise<void>) => Promise<void>;
}

export type EnrollmentState = "waiting" | "redeeming" | "success" | "service";
export type EnrollmentErrorState = PairingError | "service" | "setup_required";

interface EnrollmentOperation {
  readonly id: number;
  readonly controller: AbortController;
}

interface EnrollmentLifecycleIdentity {
  readonly machineId: string;
  readonly expectedDeviceId: string | undefined;
  readonly pairingServerUrl: string | null;
  readonly runConfigTransition: (transition: () => Promise<void>) => Promise<void>;
}

interface EnrollmentSuccessSummary {
  readonly organizationName: string;
  readonly lineName?: string;
}

const directConfigTransition = (transition: () => Promise<void>): Promise<void> => transition();

export function normalizePairingKeyboardInput(current: string, key: string): string {
  if (/^\d$/.test(key)) return `${current}${key}`.slice(0, 8);
  if (key === "Backspace") return current.slice(0, -1);
  if (key === "Delete") return "";
  return current;
}

/**
 * First-run pairing is deliberately code-first. The legacy URL/key path is a
 * service recovery action, not an ordinary operator workflow, and still
 * proves reachability/authentication before it can write a credential.
 */
export function Enrollment({
  machineId,
  expectedDeviceId,
  sealedWork,
  onEnrolled,
  pairingServerUrl,
  onSetup,
  scanSource,
  runConfigTransition = directConfigTransition,
}: EnrollmentProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [state, setState] = useState<EnrollmentState>("waiting");
  const [error, setError] = useState<EnrollmentErrorState | null>(() =>
    pairingServerUrl ? null : "setup_required",
  );
  const [serverUrl, setServerUrl] = useState(() => pairingServerUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [successSummary, setSuccessSummary] = useState<EnrollmentSuccessSummary | null>(null);
  const operationSequence = useRef(0);
  const activeOperation = useRef<EnrollmentOperation | null>(null);
  const redeemInFlight = useRef(false);
  const serviceInFlight = useRef(false);
  const successTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successSequence = useRef(0);
  const lifecycleIdentity = useRef<EnrollmentLifecycleIdentity>({
    machineId,
    expectedDeviceId,
    pairingServerUrl,
    runConfigTransition,
  });

  const busy = state === "redeeming";
  const requiresNewCode = error === "invalid" || error === "expired" || error === "locked";
  const canRetry = error === "unavailable";

  function clearSuccessTransition(): void {
    successSequence.current += 1;
    if (successTimeout.current !== null) clearTimeout(successTimeout.current);
    successTimeout.current = null;
  }

  function scheduleEnrolled(): void {
    clearSuccessTransition();
    const sequence = successSequence.current;
    successTimeout.current = setTimeout(() => {
      if (successSequence.current === sequence) onEnrolled();
    }, 900);
  }

  function beginOperation(): EnrollmentOperation {
    activeOperation.current?.controller.abort();
    const operation = {
      id: ++operationSequence.current,
      controller: new AbortController(),
    };
    activeOperation.current = operation;
    return operation;
  }

  function operationIsCurrent(operation: EnrollmentOperation): boolean {
    return activeOperation.current === operation && !operation.controller.signal.aborted;
  }

  function finishOperation(operation: EnrollmentOperation): void {
    if (activeOperation.current === operation) activeOperation.current = null;
  }

  useLayoutEffect(() => {
    const previous = lifecycleIdentity.current;
    const changed =
      previous.machineId !== machineId ||
      previous.expectedDeviceId !== expectedDeviceId ||
      previous.pairingServerUrl !== pairingServerUrl ||
      previous.runConfigTransition !== runConfigTransition;
    lifecycleIdentity.current = {
      machineId,
      expectedDeviceId,
      pairingServerUrl,
      runConfigTransition,
    };
    if (changed) {
      clearSuccessTransition();
      redeemInFlight.current = false;
      serviceInFlight.current = false;
      setCode("");
      setState("waiting");
      setError(pairingServerUrl ? null : "setup_required");
      setServerUrl("");
      setApiKey("");
      setSuccessSummary(null);
    }
    return () => {
      clearSuccessTransition();
      operationSequence.current += 1;
      redeemInFlight.current = false;
      serviceInFlight.current = false;
      activeOperation.current?.controller.abort();
      activeOperation.current = null;
    };
  }, [machineId, expectedDeviceId, pairingServerUrl, runConfigTransition]);

  // A configured serial scanner has no focused DOM input to type into. The
  // same source is therefore consumed here and in the floor, but only an
  // exact pairing code is accepted while this recovery screen is active.
  useEffect(() => {
    if (!scanSource) return;
    return scanSource.start((raw) => {
      if (!busy && /^\d{8}$/.test(raw)) setCode(raw);
    });
  }, [busy, scanSource]);

  async function redeem() {
    if (busy || redeemInFlight.current || !/^\d{8}$/.test(code)) return;
    if (!pairingServerUrl) {
      setError("setup_required");
      return;
    }
    redeemInFlight.current = true;
    const operation = beginOperation();
    setState("redeeming");
    setError(null);
    try {
      const result = await redeemStationPairing(
        pairingServerUrl,
        code,
        operation.controller.signal,
      );
      if (!operationIsCurrent(operation)) return;
      if (!result.ok) {
        setError(result.error);
        setState("waiting");
        return;
      }
      await runConfigTransition(() =>
        persistStationProvisioning(result.provisioning, {
          machineId,
          ...(expectedDeviceId ? { expectedDeviceId } : {}),
          exec: tauriExecutor,
          writeConfig,
        }),
      );
      if (!operationIsCurrent(operation)) return;
      setSuccessSummary({
        organizationName: result.provisioning.organizationName,
        ...(result.provisioning.lineName ? { lineName: result.provisioning.lineName } : {}),
      });
      setState("success");
      scheduleEnrolled();
    } catch {
      if (!operationIsCurrent(operation)) return;
      // A roster/config failure is deliberately indistinguishable from a
      // recoverable availability problem; never surface provisioning data.
      setError("unavailable");
      setState("waiting");
    } finally {
      redeemInFlight.current = false;
      finishOperation(operation);
    }
  }

  async function serviceConnect() {
    if (expectedDeviceId || busy || !serverUrl || !apiKey) return;
    serviceInFlight.current = true;
    const operation = beginOperation();
    setState("redeeming");
    setError(null);
    try {
      const client = createStationClient({ machineId, apiKey, serverUrl });
      await client.whoami(operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      await runConfigTransition(() => writeConfig({ machineId, apiKey, serverUrl }));
      if (!operationIsCurrent(operation)) return;
      setSuccessSummary(null);
      setState("success");
      scheduleEnrolled();
    } catch {
      if (!operationIsCurrent(operation)) return;
      setError("service");
      setState("service");
    } finally {
      serviceInFlight.current = false;
      finishOperation(operation);
    }
  }

  function handleCodeKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (busy) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void redeem();
      return;
    }
    const next = normalizePairingKeyboardInput(code, event.key);
    if (next !== code) {
      event.preventDefault();
      setCode(next);
    }
  }

  const serviceMode =
    (state === "service" || (busy && serviceInFlight.current)) && !expectedDeviceId;
  const showRecoveryPanel = error !== null && !serviceMode;

  const status = busy ? <p role="status">{t("enroll.redeemingDetail")}</p> : null;
  const errorNotice = error ? <Alert tone="error">{t(`enroll.errors.${error}`)}</Alert> : null;

  const pairingPanel = (
    <>
      <header className="station-enrollment__panel-heading">
        <h1 id="station-enrollment-title">{t("enroll.title")}</h1>
      </header>
      {sealedWork ? (
        <Alert tone="warn">
          <p data-testid="sealed-work-summary">
            {t("enroll.sealedWork", {
              scans: sealedWork.scans,
              boxes: sealedWork.boxes,
              exceptions: sealedWork.exceptions,
            })}
          </p>
        </Alert>
      ) : null}
      {status}
      <Input
        className="station-enrollment__code-field"
        size="floor"
        label={t("enroll.code")}
        value={code}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={8}
        autoComplete="one-time-code"
        mono
        disabled={busy}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
        onKeyDown={handleCodeKeyDown}
      />
      <div className="station-enrollment__keypad">
        <PinPad
          value={code}
          onChange={setCode}
          maxLength={8}
          size="floor"
          disabled={busy}
          ariaLabel={t("enroll.keypad")}
          backspaceLabel={t("enroll.backspace")}
          clearLabel={t("enroll.clear")}
        />
      </div>
      <div className="station-enrollment__actions station-enrollment__actions--pairing">
        <Button
          size="floor"
          onClick={() => void redeem()}
          disabled={busy || code.length !== 8 || !pairingServerUrl}
        >
          {busy ? t("enroll.redeeming") : t("enroll.submit")}
        </Button>
        {onSetup ? (
          <Button size="floor" variant="secondary" onClick={onSetup} disabled={busy}>
            {t("enroll.setup")}
          </Button>
        ) : null}
        {expectedDeviceId ? null : (
          <Button
            size="floor"
            variant="secondary"
            onClick={() => {
              setError(null);
              setState("service");
            }}
            disabled={busy}
          >
            {t("enroll.serviceMode")}
          </Button>
        )}
      </div>
    </>
  );

  const servicePanel = (
    <>
      <header className="station-enrollment__panel-heading">
        <p className="station-enrollment__eyebrow">{t("enroll.serviceMode")}</p>
        <h1 id="station-enrollment-title">{t("enroll.serviceTitle")}</h1>
      </header>
      <Alert tone="warn">{t("enroll.serviceWarning")}</Alert>
      {errorNotice}
      {status}
      <Input
        size="floor"
        label={t("enroll.serverUrl")}
        value={serverUrl}
        onChange={(event) => setServerUrl(event.target.value)}
        autoComplete="url"
        disabled={busy}
      />
      <Input
        size="floor"
        label={t("enroll.apiKey")}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        autoComplete="off"
        disabled={busy}
      />
      <div className="station-enrollment__actions station-enrollment__actions--service">
        <Button
          size="floor"
          onClick={() => void serviceConnect()}
          disabled={busy || !serverUrl || !apiKey}
        >
          {t("enroll.serviceConnect")}
        </Button>
        <Button
          size="floor"
          variant="secondary"
          onClick={() => {
            setError(pairingServerUrl ? null : "setup_required");
            setState("waiting");
          }}
          disabled={busy}
        >
          {t("enroll.backToPairing")}
        </Button>
      </div>
    </>
  );

  const recoveryPanel = (
    <div className="station-enrollment__recovery-panel">
      <header className="station-enrollment__panel-heading">
        <h1 id="station-enrollment-title">{t("enroll.recoveryTitle")}</h1>
      </header>
      {errorNotice}
      {requiresNewCode ? (
        <p className="station-enrollment__recovery">{t("enroll.cabinetRecovery")}</p>
      ) : null}
      <div className="station-enrollment__actions station-enrollment__actions--recovery">
        {canRetry ? (
          <Button size="floor" onClick={() => void redeem()}>
            {t("enroll.retry")}
          </Button>
        ) : null}
        {requiresNewCode ? (
          <Button
            size="floor"
            variant="secondary"
            onClick={() => {
              setCode("");
              setError(null);
            }}
          >
            {t("enroll.enterNewCode")}
          </Button>
        ) : (
          <Button size="floor" variant="secondary" onClick={() => setError(null)}>
            {t("enroll.returnToPairing")}
          </Button>
        )}
      </div>
    </div>
  );

  const redeemingPanel = (
    <div className="station-enrollment__busy" role="status">
      <h1 id="station-enrollment-title">{t("enroll.title")}</h1>
      <p>{t("enroll.redeemingDetail")}</p>
    </div>
  );

  return (
    <main className="station-enrollment" aria-labelledby="station-enrollment-title">
      <aside className="station-enrollment__context">
        <StationBrand descriptor={t("app.stationDescriptor")} />
        <div className="station-enrollment__intro">
          <p>{t("app.stationPurpose")}</p>
          <p className="station-enrollment__cabinet">{t("enroll.cabinetAddress")}</p>
        </div>
        <ol className="station-enrollment__steps">
          <li>{t("enroll.steps.one")}</li>
          <li>{t("enroll.steps.two")}</li>
          <li>{t("enroll.steps.three")}</li>
        </ol>
      </aside>
      <section className="station-enrollment__entry">
        {state === "success" ? (
          <div className="station-enrollment__success" role="status">
            <h1 id="station-enrollment-title">{t("enroll.success")}</h1>
            {successSummary ? (
              <p>{`${successSummary.organizationName}${
                successSummary.lineName ? ` — ${successSummary.lineName}` : ""
              }`}</p>
            ) : null}
          </div>
        ) : busy ? (
          redeemingPanel
        ) : serviceMode ? (
          servicePanel
        ) : showRecoveryPanel ? (
          recoveryPanel
        ) : (
          pairingPanel
        )}
      </section>
    </main>
  );
}
