import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { KioskBootstrapDto } from "../api/types.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../credentials/operator.js";
import { classifyKioskScan, type KioskScan } from "../domain-guard/classify.js";
import { isWebSerialSupported } from "../scanner/keyboard.js";
import type { ScanSource } from "../scanner/source.js";
import {
  readScannerSettings,
  writeScannerSettings,
  type ScannerSettings,
} from "../store/config.js";

type Transport = ScannerSettings["transport"];

/**
 * One label per verdict of `classifyKioskScan`, and `incomplete` gets its OWN.
 * That fourth label is the entire diagnostic point of this screen: an
 * installer whose keyboard wedge swallows the GS separator sees it named here
 * and knows the fix is Web Serial. Folding it into «не распознано» would turn
 * the one failure this screen exists to diagnose into a shrug.
 */
const RESULT_KEY: Record<KioskScan["kind"], string> = {
  km: "scannerSetup.resultKm",
  badge: "scannerSetup.resultBadge",
  incomplete: "scannerSetup.resultIncomplete",
  unknown: "scannerSetup.resultUnknown",
};

/** Personnel number first, then PIN — the station's two stages
 * (`apps/station/src/pages/OperatorLogin.tsx`), in kiosk styling. Never a
 * roster picker: the roster is org-wide and can be large. */
type Stage = "login" | "pin";

export interface ScannerSetupProps {
  paired: boolean;
  /** null before pairing — an unpaired device has no roster to check against,
   * and by design needs none (see the access tiers below). */
  bootstrap: KioskBootstrapDto | null;
  /** The live source, so the test scan exercises the transport actually
   * running rather than a freshly built one. */
  scanSource: ScanSource;
  onClose: () => void;
}

/**
 * Scanner setup: pick the transport, then prove it works with a test scan.
 *
 * Access is TWO-TIER, and the split is the point (design brief 07 §5):
 *
 *  - BEFORE pairing the screen opens with no credential whatsoever. The
 *    scanner is usually what reads the pairing code off the admin panel, and
 *    there is no session to authenticate against yet, so gating it here would
 *    deadlock the device — it could not pair without a scanner and could not
 *    configure the scanner without pairing.
 *  - AFTER pairing it is a settings screen on an unattended machine, so it
 *    takes operator credentials: a badge scan, or personnel number + PIN,
 *    verified against the cached roster by Task 7's `credentials/operator.ts`.
 *    Any active operator qualifies — there is no separate role in MVP.
 *
 * The gate is a real branch, not a CSS hide: while it is closed the settings
 * are not in the document at all. A hidden-but-present pane would still be
 * reachable by tab key or screen reader on a machine a customer is standing
 * in front of.
 */
export function ScannerSetup({
  paired,
  bootstrap,
  scanSource,
  onClose,
}: ScannerSetupProps): React.JSX.Element {
  const { t } = useTranslation();
  // Unpaired devices start open. `paired` never changes under this screen —
  // pairing routes away from it — so the initializer is the whole story.
  const [unlocked, setUnlocked] = useState(!paired);
  const [stage, setStage] = useState<Stage>("login");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  // A boolean, not a reason. ONE generic error regardless of cause, matching
  // the station: saying which half was wrong would let anyone standing at the
  // kiosk enumerate personnel numbers a digit at a time.
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transport, setTransport] = useState<Transport>("keyboard");
  const [result, setResult] = useState<KioskScan | null>(null);

  const serialSupported = isWebSerialSupported();

  useEffect(() => {
    let alive = true;
    void readScannerSettings()
      .then((saved) => {
        if (!alive || !saved) return;
        // A stored "serial" on a device that has no Web Serial (the app moved
        // to a tablet) is not applied: that radio is not rendered, so
        // honouring it would leave the group with nothing checked. The stored
        // value is left untouched — back on the laptop the choice is still there.
        if (saved.transport === "serial" && !serialSupported) return;
        setTransport(saved.transport);
      })
      .catch((err: unknown) => console.error("kiosk: could not read the scanner settings", err));
    return () => {
      alive = false;
    };
  }, [serialSupported]);

  // One listener, two jobs, switched by the gate: while closed a scan is a
  // badge sign-in attempt; once open it is the test scan. `unlocked` in the
  // dependencies is what performs the handover — the source is torn down and
  // resubscribed exactly once, when the gate opens.
  useEffect(() => {
    if (!scanSource.isAvailable()) return;
    return scanSource.start((raw) => {
      if (unlocked) {
        setResult(classifyKioskScan(raw));
        return;
      }
      void (async () => {
        const operator = bootstrap ? await verifyOperatorBadge(raw, bootstrap) : null;
        if (operator) {
          setFailed(false);
          setUnlocked(true);
        } else {
          setFailed(true);
        }
      })();
    });
  }, [scanSource, unlocked, bootstrap]);

  function choose(next: Transport): void {
    setTransport(next);
    // Fire-and-forget on purpose: a device whose IndexedDB refused the write
    // still has a working scanner for this session, and blocking the pick on
    // a store round trip would make the radio feel dead under a gloved hand.
    void writeScannerSettings({ transport: next }).catch((err: unknown) =>
      console.error("kiosk: could not persist the scanner transport", err),
    );
  }

  async function submitPin(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const operator = bootstrap ? await verifyOperatorPin(login, pin, bootstrap) : null;
      if (operator) {
        setFailed(false);
        setUnlocked(true);
        return;
      }
      // Back to the first stage, as the station does: the operator does not
      // know which half we rejected, so re-entering both is the honest ask.
      setFailed(true);
      setLogin("");
      setPin("");
      setStage("login");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 20 }}>
        <h1 style={{ fontSize: "2.25rem" }}>{t("scannerSetup.gateTitle")}</h1>
        <p style={{ fontSize: "1.25rem" }}>{t("scannerSetup.gatePrompt")}</p>
        <p style={{ fontSize: "1.25rem", color: "var(--fg-3)" }}>
          {stage === "login" ? t("scannerSetup.gateLogin") : t("scannerSetup.gatePin")}
        </p>
        {/* The single live region of this branch — the settings branch has its
            own, and the two never coexist. The PIN is shown as dots: a kiosk
            screen is a public one. */}
        <div role="status" style={{ fontSize: "3rem", letterSpacing: "0.5rem", minHeight: "3rem" }}>
          {stage === "login" ? login : "•".repeat(pin.length)}
        </div>
        {failed ? <Alert tone="error">{t("scannerSetup.gateError")}</Alert> : null}
        <PinPad
          value={stage === "login" ? login : pin}
          onChange={stage === "login" ? setLogin : setPin}
        />
        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="secondary" style={{ minHeight: 64 }} onClick={onClose}>
            {t("scannerSetup.cancel")}
          </Button>
          {stage === "login" ? (
            <Button
              style={{ minHeight: 64 }}
              disabled={login.length === 0}
              onClick={() => {
                setFailed(false);
                setStage("pin");
              }}
            >
              {t("scannerSetup.gateNext")}
            </Button>
          ) : (
            <Button
              style={{ minHeight: 64 }}
              loading={busy}
              disabled={pin.length === 0}
              onClick={() => void submitPin()}
            >
              {t("scannerSetup.gateSubmit")}
            </Button>
          )}
        </div>
        {/* The way out when signing in is impossible at all — an empty roster,
            a snapshot that never arrived, credentials nobody remembers. Without
            this line such a kiosk is bricked with no visible exit; with it, the
            cabinet can unbind the device and issue a new code, and the unpaired
            tier above opens setup again. */}
        <p style={{ maxWidth: 640, fontSize: "1rem", color: "var(--fg-3)", textAlign: "center" }}>
          {t("scannerSetup.gateRecovery")}
        </p>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("scannerSetup.title")}</h1>
      {/* `fieldset`/`legend` rather than a div and a heading: the radios are one
          answer to one question, and that is exactly what the group role says. */}
      <fieldset style={{ display: "grid", gap: 16, border: 0, padding: 0, maxWidth: 640 }}>
        <legend style={{ fontSize: "1.5rem", paddingBottom: 12 }}>
          {t("scannerSetup.transportTitle")}
        </legend>
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 12, fontSize: "1.25rem" }}>
            <input
              type="radio"
              name="kiosk-scan-transport"
              value="keyboard"
              checked={transport === "keyboard"}
              onChange={() => choose("keyboard")}
              style={{ width: 28, height: 28 }}
            />
            <span>{t("scannerSetup.transportKeyboard")}</span>
          </label>
          <p style={{ margin: 0, fontSize: "1rem", color: "var(--fg-3)" }}>
            {t("scannerSetup.transportKeyboardHint")}
          </p>
        </div>
        {/* Offered only where it can actually run. A tablet has no
            `navigator.serial`, and showing it a port picker it cannot open
            would be an installer's dead end, not a choice. */}
        {serialSupported ? (
          <div style={{ display: "grid", gap: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 12, fontSize: "1.25rem" }}>
              <input
                type="radio"
                name="kiosk-scan-transport"
                value="serial"
                checked={transport === "serial"}
                onChange={() => choose("serial")}
                style={{ width: 28, height: 28 }}
              />
              <span>{t("scannerSetup.transportSerial")}</span>
            </label>
            <p style={{ margin: 0, fontSize: "1rem", color: "var(--fg-3)" }}>
              {t("scannerSetup.transportSerialHint")}
            </p>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "1rem", color: "var(--fg-3)" }}>
            {t("scannerSetup.transportSerialUnavailable")}
          </p>
        )}
      </fieldset>
      <section style={{ display: "grid", justifyItems: "center", gap: 12 }}>
        <h2 style={{ fontSize: "1.5rem", margin: 0 }}>{t("scannerSetup.testTitle")}</h2>
        <p style={{ margin: 0, fontSize: "1.125rem" }}>{t("scannerSetup.testPrompt")}</p>
        {/* Only the recognised KIND is echoed, never the payload: a badge is a
            credential, and printing it at arm's length on an unattended screen
            would hand it to whoever is standing there. */}
        <div
          role="status"
          style={{ minHeight: "4rem", fontSize: "1.5rem", maxWidth: 640, textAlign: "center" }}
        >
          {result ? t(RESULT_KEY[result.kind]) : t("scannerSetup.testWaiting")}
        </div>
      </section>
      <Button style={{ minHeight: 64, minWidth: 240 }} onClick={onClose}>
        {t("scannerSetup.done")}
      </Button>
    </main>
  );
}
