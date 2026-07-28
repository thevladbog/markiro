import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { KioskBootstrapDto } from "../api/types.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../credentials/operator.js";
import { classifyKioskScan, type KioskScan } from "../domain-guard/classify.js";
import { isWebSerialSupported } from "../scanner/keyboard.js";
import type { ScanListener, ScanSource } from "../scanner/source.js";
import {
  createWebSerialSource,
  requestSerialPort,
  type SerialPort,
} from "../scanner/web-serial.js";
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
 * instead of a shrug, and — crucially — is told what to do about it.
 *
 * `incomplete` therefore has TWO labels, picked on whether this device has Web
 * Serial at all. On a laptop the fix is the better transport; on a tablet that
 * advice is a dead end, and the actionable fix is the scanner's own
 * configuration, which can be told to transmit GS (FNC1). Sending a tablet
 * after a transport it does not have, on the one diagnostic this screen exists
 * to deliver, would waste the visit.
 */
const RESULT_KEY: Record<KioskScan["kind"], string> = {
  km: "scannerSetup.resultKm",
  badge: "scannerSetup.resultBadge",
  incomplete: "scannerSetup.resultIncomplete",
  unknown: "scannerSetup.resultUnknown",
};

function resultKey(kind: KioskScan["kind"], serialSupported: boolean): string {
  if (kind === "incomplete" && !serialSupported) return "scannerSetup.resultIncompleteNoSerial";
  return RESULT_KEY[kind];
}

/**
 * Caps the gate entry. Neither a personnel number nor a PIN comes close, so
 * this bounds nothing real — it bounds the DISPLAY, which is 3rem type with
 * 0.5rem letter-spacing and would run off a portrait kiosk long before an
 * accidental lean on the pad stopped adding digits. Pairing caps its own entry
 * the same way (`Pairing.tsx`, `CODE_LENGTH`).
 */
const ENTRY_MAX = 12;

/** Personnel number first, then PIN — the station's two stages
 * (`apps/station/src/pages/OperatorLogin.tsx`), in kiosk styling. Never a
 * roster picker: the roster is org-wide and can be large. */
type Stage = "login" | "pin";

export interface ScannerSetupProps {
  paired: boolean;
  /** null before pairing — an unpaired device has no roster to check against,
   * and by design needs none (see the access tiers below). */
  bootstrap: KioskBootstrapDto | null;
  /**
   * THE TEST SCAN's transport, and deliberately NOT `subscribe` below.
   *
   * The two exist because this screen reads a scanner for two different
   * reasons, and they want different answers:
   *
   *  - the test scan has to certify THE TRANSPORT THE INSTALLER JUST PICKED.
   *    A port granted seconds ago is one the shell is not reading yet — its
   *    fan-out would never deliver a byte of it — so this stays a raw
   *    `ScanSource` the screen starts itself, and is replaced outright by a
   *    source over the granted port the moment there is one (`activeSource`
   *    below). Certifying through the fan-out instead would green-light
   *    whatever the shell happened to be on, which is the exact
   *    false-green-light Task 11's review caught;
   *  - the gate is signing an operator in on the RUNNING kiosk, which is
   *    `subscribe`'s job.
   *
   * MUST BE REFERENTIALLY STABLE across renders. The test-scan effect below
   * lists it in its dependencies, so a source built inline in the parent's JSX
   * is a different object on every render: the listener would be torn down and
   * re-subscribed each time. That is not merely wasteful — the keyboard wedge
   * accumulates the payload in the closure that teardown discards, so a
   * re-render landing mid-scan silently truncates it and the installer sees a
   * good scanner report «не распознано». Hold it in a `useMemo`/`useRef` or a
   * module-level singleton.
   */
  scanSource: ScanSource;
  /**
   * THE GATE's scanner: the shell's fan-out over the transport that is
   * CURRENTLY RUNNING — the very subscription `Idle` and `Cart` take.
   *
   * NOT `scanSource.start`, and that is not a stylistic preference.
   * `createWebSerialSource` is SINGLE-SUBSCRIBER (`port.readable` is locked by
   * the first reader), and on a serial kiosk the shell has held the port open
   * since boot — so a listener this screen starts on that same source reads
   * nothing whatsoever and the gate's badge tier is silently dead. Silently,
   * because PIN sign-in still works, so nobody is ever locked out to notice;
   * and on Web Serial, which is the configuration this product recommends.
   * Through the fan-out, the gate hears exactly what the running kiosk hears.
   *
   * MUST BE REFERENTIALLY STABLE for the same reason `scanSource` must: the
   * gate effect lists it in its dependencies. Returns its own unsubscribe.
   */
  subscribe: (listener: ScanListener) => () => void;
  /**
   * Announces the settled transport, and for "serial" the port the installer
   * just granted.
   *
   * The port has to travel this way because of when it can be obtained:
   * `navigator.serial.requestPort()` needs transient user activation, so the
   * radio below is the only place in the entire flow allowed to ask for it —
   * the app shell mounts on boot without a gesture. The shell builds its
   * app-level `createWebSerialSource` from what arrives here.
   */
  onTransportChange?: (transport: Transport, port?: SerialPort) => void;
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
  subscribe,
  onTransportChange,
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
  // The grant, not the mode. A `SerialPort` cannot be stored (it is not
  // structured-cloneable, and the grant itself belongs to the browser's
  // permission store), so it lives for this session only and is handed up to
  // the shell via `onTransportChange`.
  const [grantedPort, setGrantedPort] = useState<SerialPort | null>(null);
  const [portRefused, setPortRefused] = useState(false);
  const [result, setResult] = useState<KioskScan | null>(null);

  const serialSupported = isWebSerialSupported();

  /**
   * What the test scan actually runs on.
   *
   * Before any grant this is the injected source: the parent hands down the
   * transport that is genuinely running, which is the point of the prop. The
   * moment a port is granted here, that injected source is stale by
   * construction — the shell has not rebuilt anything yet — so the granted
   * port takes over. Anything else would certify a transport that was never
   * exercised: the installer picks Web Serial, the wedge answers the test
   * scan, and the green light says nothing about the port. GS handling is
   * exactly what the two transports disagree about and exactly what the
   * verdict below reports, so this is the whole diagnostic.
   */
  const activeSource = useMemo(
    () => (transport === "serial" && grantedPort ? createWebSerialSource(grantedPort) : scanSource),
    [transport, grantedPort, scanSource],
  );

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

  /**
   * WHILE THE GATE IS SHUT a scan is a sign-in attempt and nothing else, and
   * it is read off the RUNNING transport through the shell's fan-out.
   *
   * Never off `scanSource`: on a serial kiosk the shell owns that port's only
   * reader, so starting a second listener on it would read nothing at all and
   * the badge would simply never open the gate (see the `subscribe` prop). The
   * fan-out is a set membership change and takes nothing away from the screen
   * standing behind this one.
   *
   * `unlocked` in the dependencies performs the handover: the moment the gate
   * opens this unsubscribes and the test scan below takes over, so exactly one
   * of the two is ever listening.
   */
  useEffect(() => {
    if (unlocked) return;
    return subscribe((raw) => {
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
  }, [subscribe, unlocked, bootstrap]);

  // ONCE IT IS OPEN the same gesture means the opposite thing: not «let me
  // in» but «tell me what you made of this», answered by the transport the
  // installer picked rather than by the one the shell is running.
  useEffect(() => {
    if (!unlocked || !activeSource.isAvailable()) return;
    return activeSource.start((raw) => setResult(classifyKioskScan(raw)));
  }, [activeSource, unlocked]);

  /** Selection settled: apply it, remember it, announce it. */
  function commit(next: Transport, port?: SerialPort): void {
    setTransport(next);
    onTransportChange?.(next, port);
    // Fire-and-forget on purpose: a device whose IndexedDB refused the write
    // still has a working scanner for this session, and blocking the pick on
    // a store round trip would make the radio feel dead under a gloved hand.
    void writeScannerSettings({ transport: next }).catch((err: unknown) =>
      console.error("kiosk: could not persist the scanner transport", err),
    );
  }

  /**
   * Web Serial needs a PORT, not just a mode. `navigator.serial.requestPort()`
   * is the only call that can produce one, and the browser honours it only
   * under transient user activation — which this radio's change handler has
   * and nothing else in the flow does. Storing "serial" without asking would
   * leave every later `getPorts()` empty and the transport dead.
   */
  async function chooseSerial(): Promise<void> {
    try {
      const port = await requestSerialPort();
      setGrantedPort(port);
      setPortRefused(false);
      commit("serial", port);
    } catch (err) {
      // The picker was dismissed, or the browser refused. The choice is NOT
      // applied and NOT stored: a stored "serial" with no grant behind it is a
      // mode the next boot would try to honour and silently fail at. Say so —
      // an installer whose choice vanished without a word walks away believing
      // the kiosk is on Web Serial.
      console.warn("kiosk: no serial port was granted", err);
      setPortRefused(true);
    }
  }

  function choose(next: Transport): void {
    if (next === "serial") {
      void chooseSerial();
      return;
    }
    setPortRefused(false);
    commit("keyboard");
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
          maxLength={ENTRY_MAX}
        />
        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="secondary" style={{ minHeight: 64 }} onClick={onClose}>
            {t("scannerSetup.cancel")}
          </Button>
          {/* Pairing has this on the very same device (`Pairing.tsx`), and the
              gate needs it more: without a clear, one mistyped digit under a
              glove can only be resolved by submitting, absorbing the
              deliberately uninformative error, and re-entering BOTH stages. It
              clears the current stage only — going back a stage is what a
              failed sign-in does, and conflating the two would throw away a
              correct personnel number to fix a PIN. */}
          <Button
            variant="secondary"
            style={{ minHeight: 64 }}
            disabled={(stage === "login" ? login : pin).length === 0 || busy}
            onClick={() => {
              if (stage === "login") setLogin("");
              else setPin("");
            }}
          >
            {t("scannerSetup.clear")}
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
            {/* The picker was dismissed, so the pick did not happen. Naming
                that is the whole point: the radio has visibly snapped back to
                the keyboard, and an unexplained snap-back reads as a broken
                screen rather than as «choose a port». */}
            {portRefused ? <Alert tone="warn">{t("scannerSetup.serialNotGranted")}</Alert> : null}
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
          {result ? t(resultKey(result.kind, serialSupported)) : t("scannerSetup.testWaiting")}
        </div>
      </section>
      <Button style={{ minHeight: 64, minWidth: 240 }} onClick={onClose}>
        {t("scannerSetup.done")}
      </Button>
    </main>
  );
}
