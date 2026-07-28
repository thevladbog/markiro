import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, PinPad } from "@markiro/ui";
import { KioskApiError, pairKiosk } from "../api/client.js";
import type { ScanSource } from "../scanner/source.js";
import {
  assertMeasurableGeneratedAt,
  replaceSnapshot,
  UnusableBootstrapError,
} from "../store/cache.js";
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
 * code, a dead network and a server bundle we cannot store need different
 * instructions from the worker — retype, retry, or fetch a new code. */
type PairingError = "code" | "connection" | "bundle" | "scan";

const MESSAGE_KEY: Record<PairingError, string> = {
  code: "pairing.invalidCode",
  connection: "pairing.connectionFailed",
  bundle: "pairing.badBundle",
  scan: "pairing.scanRejected",
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError | null>(null);

  // Listening starts at MOUNT rather than on a button press: the admin panel's
  // pairing modal renders the code as a barcode and tells the worker to scan
  // it, and at an unattended kiosk the instinct is simply to scan — a listener
  // that has to be armed first drops exactly that scan.
  //
  // It PAUSES while the server-address field is open, and only then: the
  // keyboard wedge is a window-level `keydown` handler, so it would otherwise
  // swallow every character typed into that field. `serverOpen` is the whole
  // reason this effect has a dependency other than the source; both are stable
  // across renders, so the listener is torn down once, when it must be.
  useEffect(() => {
    if (serverOpen || !scanSource.isAvailable()) return;
    return scanSource.start((raw) => {
      // A wedge payload can arrive with framing characters around the digits.
      // What survives must be EXACTLY eight, and nothing else is accepted:
      // truncating a longer one would submit the first eight digits of a
      // marking code as though the worker had meant to, and dropping a short
      // one silently leaves the dead button the pad exists to avoid. Say what
      // was wrong and keep listening — the next scan needs no reset.
      const digits = raw.replace(/\D/g, "");
      if (digits.length !== CODE_LENGTH) {
        setError("scan");
        return;
      }
      setCode(digits);
      setError(null);
    });
  }, [scanSource, serverOpen]);

  async function submit(): Promise<void> {
    if (busy || code.length !== CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pairKiosk(serverUrl, code);
      // Checked BEFORE anything is persisted, so the screen can name this
      // failure for what it is (`bundle`, below) instead of discovering it
      // halfway through a write sequence. `replaceSnapshot` refuses it too.
      assertMeasurableGeneratedAt(result.bootstrap);
      // THE ORDER OF THESE TWO WRITES IS LOAD-BEARING — do not tidy it.
      // `config.token` is the state-machine trigger: `nextKioskView` reads
      // `paired` from it, and once it is set this screen is unreachable. So the
      // snapshot goes FIRST and the token LAST. If the second write fails the
      // device is left with an orphan snapshot but is still unpaired, still on
      // this screen, and can be paired again with a fresh code. The reverse
      // order turns the same failure into a brick: a token with no dataset,
      // routed as paired, while the code it burned is already spent server-side
      // (`attemptRedeem` sets `usedAt`), so every retry can only 401 forever.
      //
      // The response embeds the bootstrap so the kiosk is usable the moment it
      // pairs — no second round trip on a network that may already be gone.
      await replaceSnapshot(result.bootstrap, new Date());
      await writeConfig({
        serverUrl,
        token: result.token,
        kioskName: result.device.kioskName,
        place: result.device.place,
        // Continues the counter instead of restarting at 0, so a re-paired
        // device cannot collide with the idempotency keys of its own past orders.
        nextDeviceSeq: result.nextDeviceSeq,
      });
      onPaired();
    } catch (err) {
      if (err instanceof KioskApiError && err.status === 401) {
        setError("code");
        setCode(""); // wrong code: the entry has to be redone anyway
      } else if (err instanceof UnusableBootstrapError) {
        // Not a network blink, and it must not be dressed as one: the code was
        // SPENT redeeming this response, so retrying with it can only 401. The
        // only exit is a new code, which is what the message asks for — and why
        // this branch offers no Retry button.
        setError("bundle");
      } else {
        // Transport, server, or a store that refused the write. The code itself
        // is fine as far as we know, so it is KEPT and the retry can reuse it.
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
      {/* Replaces the old «Сканировать код» button, which existed only to arm
          the listener. The listener is always armed now, so the honest thing to
          show is that a scan will be taken — and to hide the line exactly when
          it is not true, i.e. while the server field has the keyboard. */}
      {scanSource.isAvailable() && !serverOpen ? (
        <p style={{ fontSize: "1rem", color: "var(--fg-3)" }}>{t("pairing.scanHint")}</p>
      ) : null}
      {/* `role="status"`: what has been entered so far is announced as it
          changes, which is what a worker filling it by scanner needs. It was an
          `aria-label="code"` — a test hook no screen reader reads out. */}
      <div role="status" style={{ fontSize: "3rem", letterSpacing: "0.5rem", minHeight: "3rem" }}>
        {code}
      </div>
      {error ? (
        <Alert
          tone="error"
          action={
            // Retry is offered ONLY where retrying can work. A wrong code has to
            // be retyped, and a code already spent on an unusable bundle cannot
            // be redeemed twice — a button there would loop the worker forever.
            error === "connection" ? (
              <Button style={{ minHeight: 56 }} disabled={busy} onClick={() => void submit()}>
                {t("pairing.retry")}
              </Button>
            ) : null
          }
        >
          {t(MESSAGE_KEY[error])}
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
          style={{ minHeight: 64 }}
          loading={busy}
          disabled={code.length !== CODE_LENGTH}
          onClick={() => void submit()}
        >
          {t("pairing.submit")}
        </Button>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {/* Disabled while a pair is in flight: leaving this screen mid-request
            would let the pair complete behind the scanner-setup screen, with
            the device silently paired under a screen that knows nothing of it. */}
        <Button
          variant="secondary"
          style={{ minHeight: 44 }}
          disabled={busy}
          onClick={onConfigureScanner}
        >
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
