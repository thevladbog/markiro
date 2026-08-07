import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
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

const directConfigTransition = (transition: () => Promise<void>): Promise<void> => transition();

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
  const operationSequence = useRef(0);
  const activeOperation = useRef<EnrollmentOperation | null>(null);
  const lifecycleIdentity = useRef<EnrollmentLifecycleIdentity>({
    machineId,
    expectedDeviceId,
    pairingServerUrl,
    runConfigTransition,
  });

  const busy = state === "redeeming";

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
      setCode("");
      setState("waiting");
      setError(pairingServerUrl ? null : "setup_required");
      setServerUrl("");
      setApiKey("");
    }
    return () => {
      operationSequence.current += 1;
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
      if (/^\d{8}$/.test(raw)) setCode(raw);
    });
  }, [scanSource]);

  async function redeem() {
    if (busy || !/^\d{8}$/.test(code)) return;
    if (!pairingServerUrl) {
      setError("setup_required");
      return;
    }
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
      setState("success");
      onEnrolled();
    } catch {
      if (!operationIsCurrent(operation)) return;
      // A roster/config failure is deliberately indistinguishable from a
      // recoverable availability problem; never surface provisioning data.
      setError("unavailable");
      setState("waiting");
    } finally {
      finishOperation(operation);
    }
  }

  async function serviceConnect() {
    if (expectedDeviceId || busy || !serverUrl || !apiKey) return;
    const operation = beginOperation();
    setState("redeeming");
    setError(null);
    try {
      const client = createStationClient({ machineId, apiKey, serverUrl });
      await client.whoami(operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      await runConfigTransition(() => writeConfig({ machineId, apiKey, serverUrl }));
      if (!operationIsCurrent(operation)) return;
      setState("success");
      onEnrolled();
    } catch {
      if (!operationIsCurrent(operation)) return;
      setError("service");
      setState("service");
    } finally {
      finishOperation(operation);
    }
  }

  const serviceMode = state === "service" && !expectedDeviceId;

  return (
    <main className="station-centered-screen">
      <Card style={{ minWidth: 480, padding: 32 }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("enroll.title")}</h1>
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
        {error ? <Alert tone="error">{t(`enroll.errors.${error}`)}</Alert> : null}
        {state === "success" ? <p role="status">{t("enroll.success")}</p> : null}
        {serviceMode ? (
          <>
            <Input
              size="floor"
              label={t("enroll.serverUrl")}
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              autoComplete="url"
            />
            <Input
              size="floor"
              label={t("enroll.apiKey")}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
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
              onClick={() => setState("waiting")}
              disabled={busy}
            >
              {t("enroll.backToPairing")}
            </Button>
          </>
        ) : (
          <>
            <Input
              size="floor"
              label={t("enroll.code")}
              value={code}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              autoComplete="one-time-code"
              mono
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void redeem();
                }
              }}
            />
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
                onClick={() => setState("service")}
                disabled={busy}
              >
                {t("enroll.serviceMode")}
              </Button>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
