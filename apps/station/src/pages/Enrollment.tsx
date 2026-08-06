import { useEffect, useState } from "react";
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

type EnrollmentState = "waiting" | "redeeming" | "success" | "service";

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
  runConfigTransition = (transition) => transition(),
}: EnrollmentProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [state, setState] = useState<EnrollmentState>("waiting");
  const [error, setError] = useState<PairingError | "service" | "setup_required" | null>(() =>
    pairingServerUrl ? null : "setup_required",
  );
  const [serverUrl, setServerUrl] = useState(() => pairingServerUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  const busy = state === "redeeming";

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
    setState("redeeming");
    setError(null);
    const result = await redeemStationPairing(pairingServerUrl, code);
    if (!result.ok) {
      setError(result.error);
      setState("waiting");
      return;
    }

    try {
      await runConfigTransition(() =>
        persistStationProvisioning(result.provisioning, {
          machineId,
          ...(expectedDeviceId ? { expectedDeviceId } : {}),
          exec: tauriExecutor,
          writeConfig,
        }),
      );
      setState("success");
      onEnrolled();
    } catch {
      // A roster/config failure is deliberately indistinguishable from a
      // recoverable availability problem; never surface provisioning data.
      setError("unavailable");
      setState("waiting");
    }
  }

  async function serviceConnect() {
    if (busy || !serverUrl || !apiKey) return;
    setState("redeeming");
    setError(null);
    try {
      const client = createStationClient({ machineId, apiKey, serverUrl });
      await client.whoami();
      await runConfigTransition(() => writeConfig({ machineId, apiKey, serverUrl }));
      setState("success");
      onEnrolled();
    } catch {
      setError("service");
      setState("service");
    }
  }

  const serviceMode = state === "service";

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
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
              label={t("enroll.serverUrl")}
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              autoComplete="url"
            />
            <Input
              label={t("enroll.apiKey")}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
            <Button onClick={() => void serviceConnect()} disabled={busy || !serverUrl || !apiKey}>
              {t("enroll.serviceConnect")}
            </Button>
            <Button variant="secondary" onClick={() => setState("waiting")} disabled={busy}>
              {t("enroll.backToPairing")}
            </Button>
          </>
        ) : (
          <>
            <Input
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
              onClick={() => void redeem()}
              disabled={busy || code.length !== 8 || !pairingServerUrl}
            >
              {busy ? t("enroll.redeeming") : t("enroll.submit")}
            </Button>
            {onSetup ? (
              <Button variant="secondary" onClick={onSetup} disabled={busy}>
                {t("enroll.setup")}
              </Button>
            ) : null}
            {expectedDeviceId ? null : (
              <Button variant="secondary" onClick={() => setState("service")} disabled={busy}>
                {t("enroll.serviceMode")}
              </Button>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
