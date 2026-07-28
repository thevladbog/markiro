import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, PinPad } from "@markiro/ui";
import { KioskApiError, pairKiosk } from "../api/client.js";
import type { ScanSource } from "../scanner/source.js";
import { assertMeasurableGeneratedAt, replaceSnapshot } from "../store/cache.js";
import { writeConfig } from "../store/config.js";

/** `POST /kiosk/pair` accepts `/^\d{8}$/` — the admin panel issues nothing else. */
const CODE_LENGTH = 8;

export interface PairingProps {
  defaultServerUrl: string;
  scanSource: ScanSource;
  onPaired: () => void;
  onConfigureScanner: () => void;
}

/** Which message the failure earns. The split is the whole point: a mistyped
 * code and a dead network need different instructions from the worker. */
type PairingError = "code" | "connection";

/**
 * The first screen an unpaired device shows: redeem a pairing code, and store
 * the identity and dataset the response carries.
 *
 * Scanner setup is reachable from here WITHOUT any credential, and deliberately
 * so — the scanner is often what reads the pairing code off the admin panel, so
 * gating it behind a pairing that needs it would deadlock the device.
 * `nextKioskView` ranks `scanner-setup` above `pairing` for the same reason.
 */
export function Pairing({
  defaultServerUrl,
  scanSource,
  onPaired,
  onConfigureScanner,
}: PairingProps): React.JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [serverOpen, setServerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError | null>(null);

  useEffect(() => {
    if (!listening) return;
    return scanSource.start((raw) => {
      // A wedge payload can arrive with framing characters around the digits,
      // and the pad caps entry at eight anyway. A longer payload (someone
      // scanned a marking code by mistake) is truncated rather than silently
      // dropped: the worker sees what landed and the server rejects it as an
      // invalid code, which is a legible failure rather than a dead button.
      const digits = raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
      if (!digits) return;
      setCode(digits);
      setListening(false);
    });
  }, [listening, scanSource]);

  async function submit(): Promise<void> {
    if (busy || code.length !== CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pairKiosk(serverUrl, code);
      // Checked BEFORE the first write. A device that stored its token and then
      // rejected the snapshot would be half-paired: it looks paired, holds no
      // dataset, and cannot be re-paired without a factory reset. Failing the
      // whole pair leaves it exactly where it was — unpaired and retryable.
      assertMeasurableGeneratedAt(result.bootstrap);
      await writeConfig({
        serverUrl,
        token: result.token,
        kioskName: result.device.kioskName,
        place: result.device.place,
        // Continues the counter instead of restarting at 0, so a re-paired
        // device cannot collide with the idempotency keys of its own past orders.
        nextDeviceSeq: result.nextDeviceSeq,
      });
      // The response embeds the bootstrap so the kiosk is usable the moment it
      // pairs — no second round trip on a network that may already be gone.
      await replaceSnapshot(result.bootstrap, new Date());
      onPaired();
    } catch (err) {
      if (err instanceof KioskApiError && err.status === 401) {
        setError("code");
        setCode(""); // wrong code: the entry has to be redone anyway
      } else {
        // Transport, server, or a bootstrap we refused. The code itself is fine
        // as far as we know, so it is KEPT and the retry can reuse it.
        setError("connection");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 20 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("pairing.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>{t("pairing.prompt")}</p>
      <div
        aria-label="code"
        style={{ fontSize: "3rem", letterSpacing: "0.5rem", minHeight: "3rem" }}
      >
        {code}
      </div>
      {error ? (
        <Alert
          tone="error"
          action={
            error === "connection" ? (
              <Button style={{ minHeight: 56 }} disabled={busy} onClick={() => void submit()}>
                {t("pairing.retry")}
              </Button>
            ) : null
          }
        >
          {error === "code" ? t("pairing.invalidCode") : t("pairing.connectionFailed")}
        </Alert>
      ) : null}
      <PinPad value={code} onChange={setCode} maxLength={CODE_LENGTH} />
      <div style={{ display: "flex", gap: 12 }}>
        <Button
          variant="secondary"
          style={{ minHeight: 64 }}
          disabled={busy || code.length === 0}
          onClick={() => setCode("")}
        >
          {t("pairing.clear")}
        </Button>
        <Button
          variant="secondary"
          style={{ minHeight: 64 }}
          disabled={busy || listening || !scanSource.isAvailable()}
          onClick={() => setListening(true)}
        >
          {listening ? t("pairing.scanWaiting") : t("pairing.scan")}
        </Button>
        <Button
          style={{ minHeight: 64 }}
          loading={busy}
          disabled={code.length !== CODE_LENGTH}
          onClick={() => void submit()}
        >
          {t("pairing.submit")}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Button variant="secondary" style={{ minHeight: 44 }} onClick={onConfigureScanner}>
          {t("pairing.scannerSetup")}
        </Button>
        {/* Collapsed by default: an on-prem deployment must be able to change
            the address, but a SaaS build bakes the origin in and the field
            would only be one more thing between a worker and a paired kiosk. */}
        <Button
          variant="secondary"
          style={{ minHeight: 44 }}
          onClick={() => setServerOpen((open) => !open)}
        >
          {t("pairing.serverToggle")}
        </Button>
      </div>
      {serverOpen ? (
        <Input
          label={t("pairing.server")}
          value={serverUrl}
          inputMode="url"
          mono
          onChange={(event) => setServerUrl(event.target.value)}
        />
      ) : null}
    </main>
  );
}
