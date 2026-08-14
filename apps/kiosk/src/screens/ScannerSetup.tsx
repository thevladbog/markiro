import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, PinPad } from "@markiro/ui";
import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../credentials/operator.js";
import { classifyKioskScan, type KioskScan } from "../domain-guard/classify.js";
import { isWebSerialSupported } from "../scanner/keyboard.js";
import type { ScanListener } from "../scanner/source.js";
import { requestSerialPort, type SerialPort } from "../scanner/web-serial.js";
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
  sscc: "scannerSetup.resultUnknown",
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
const KEYBOARD_HINT_ID = "kiosk-scanner-keyboard-hint";
const SERIAL_HINT_ID = "kiosk-scanner-serial-hint";

/** Personnel number first, then PIN — the station's two stages
 * (`apps/station/src/pages/OperatorLogin.tsx`), in kiosk styling. Never a
 * roster picker: the roster is org-wide and can be large. */
type Stage = "login" | "pin";

export interface ScannerSetupProps {
  paired: boolean;
  /** null before pairing — an unpaired device has no roster to check against,
   * and by design needs none (see the access tiers below). */
  bootstrap: KioskBootstrapSnapshotDto | null;
  /**
   * THE DEVICE'S SCANNER, and the only one this screen has: the shell's
   * fan-out over the transport the kiosk is CURRENTLY running — the very
   * subscription `Idle`, `Cart` and `Pairing` take.
   *
   * This screen holds NO `ScanSource` of its own, and that is the whole design
   * rather than a simplification. `createWebSerialSource` is SINGLE-SUBSCRIBER
   * (`port.readable` is locked by the first reader) and the shell has held the
   * port open since boot, so any source a screen starts beside it reads nothing
   * whatsoever — silently, because the screen sees no error, only a scanner
   * that never speaks. Both of this screen's readers were built that way once,
   * and both were dead on the transport this product recommends: the gate's
   * badge tier (PIN still worked, so nobody was locked out to report it) and
   * the test scan (an installer left on «Ждём сканирование…» in front of a
   * working scanner).
   *
   * The test scan still certifies THE TRANSPORT THE INSTALLER PICKED — the
   * property Task 11's review established — but by OWNERSHIP: picking one tells
   * the shell to swap the fan-out's source (`onTransportChange`), so from the
   * grant onwards reading the fan-out IS reading what was picked. A competing
   * subscription is no longer needed to say so, and cannot fight the shell for
   * the port.
   *
   * MUST BE REFERENTIALLY STABLE across renders: both effects below list it in
   * their dependencies, and a fan-out rebuilt per render would resubscribe on
   * every state change. Returns its own unsubscribe.
   */
  subscribe: (listener: ScanListener) => () => void;
  /**
   * Announces the settled transport, and for "serial" the port the installer
   * just granted — which is what makes the shell swap what it is reading.
   *
   * The port has to travel this way because of when it can be obtained:
   * `navigator.serial.requestPort()` needs transient user activation, so the
   * radio below is the only place in the entire flow allowed to ask for it —
   * the app shell mounts on boot without a gesture. The shell builds its
   * app-level `createWebSerialSource` from what arrives here, and the test scan
   * below reads the result through `subscribe`.
   */
  onTransportChange?: (transport: Transport, port?: SerialPort) => void;
  /**
   * THE TRANSPORT THE SHELL IS ACTUALLY RUNNING, when it can say.
   *
   * The stored mode alone is not that, and the gap is not academic: the shell
   * honours a stored "serial" only while the browser still holds the port grant
   * (`recoverGrantedPort` in `KioskShell.tsx`), and falls back to the keyboard
   * wedge when it does not — a reset profile, a different machine, a scanner
   * that moved. Initialising the radio from the store in that state checks
   * «Web Serial» over a kiosk running the wedge, and the test scan below then
   * certifies the wedge under that label: the installer leaves with a green
   * light and a saved configuration that misdescribes the device.
   *
   * So when this is given it WINS over the store, and the store is not read at
   * all — the shell has already applied it and checked the grant behind it.
   * Left out, the screen falls back to the stored mode, which is the old
   * behaviour and the best a caller that cannot say has to offer.
   */
  activeTransport?: Transport;
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
  subscribe,
  onTransportChange,
  activeTransport,
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
  const [transport, setTransport] = useState<Transport>(activeTransport ?? "keyboard");
  const [portRefused, setPortRefused] = useState(false);
  const [result, setResult] = useState<KioskScan | null>(null);

  const serialSupported = isWebSerialSupported();

  /**
   * FOLLOW the shell, don't merely start from it. The boot-time recovery of a
   * granted port is async (`recoverGrantedPort`), so on an unpaired device this
   * screen can already be standing when the answer lands — and a radio seeded
   * once at mount would then describe the transport the shell had before it
   * settled. A local pick sets the same value on its way out through
   * `onTransportChange`, so this never fights the installer.
   */
  useEffect(() => {
    if (activeTransport === undefined) return;
    setTransport(activeTransport);
  }, [activeTransport]);

  useEffect(() => {
    // Nothing to recover when the shell has already said what it is running:
    // the store keeps the MODE a previous session chose, and says nothing about
    // whether the port grant behind it survived — which is exactly the
    // difference that made a stored "serial" a lie on this screen.
    if (activeTransport !== undefined) return;
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
  }, [serialSupported, activeTransport]);

  /**
   * WHILE THE GATE IS SHUT a scan is a sign-in attempt and nothing else.
   *
   * `unlocked` in the dependencies performs the handover: the moment the gate
   * opens this unsubscribes and the test scan below takes over, so exactly one
   * of the two ever holds a place in the fan-out and a scan cannot be answered
   * by both meanings at once.
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
  // in» but «tell me what you made of this».
  //
  // The same fan-out answers it, and that is exactly what makes the verdict
  // honest: `choose` below hands the picked transport to the shell, the shell
  // swaps what the fan-out is reading, and so the transport being certified
  // from that moment on is the one the installer picked. Nothing here has to
  // hold a second, competing reader to arrange it — and on Web Serial nothing
  // could, since the shell already owns the port's only one.
  useEffect(() => {
    if (!unlocked) return;
    return subscribe((raw) => setResult(classifyKioskScan(raw)));
  }, [subscribe, unlocked]);

  /**
   * Selection settled: apply it, hand it over, remember it.
   *
   * The hand-over is what actually MOVES the device — the shell swaps the
   * fan-out's source on it — so it goes out in the same turn as the grant,
   * before the store round trip. From here on the test scan above reads the
   * transport this call announced, which is the only reason it can certify it.
   */
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
   *
   * The grant is not kept here. It is handed to the shell and belongs to the
   * shell: one owner opens the port, one reader reads it, and this screen sees
   * what comes back out of the fan-out like every other screen does.
   */
  async function chooseSerial(): Promise<void> {
    try {
      const port = await requestSerialPort();
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

  /**
   * Back to the first stage, as the station does: the operator does not know
   * which half we rejected, so re-entering both is the honest ask.
   *
   * ONE function for every rejection, and that is the point rather than tidying:
   * the message it raises must be byte-identical whatever caused it — a wrong
   * PIN, an unknown personnel number, or a check that could not run at all —
   * or the difference between them becomes an oracle for enumerating personnel
   * numbers from the outside of an unattended kiosk.
   */
  function rejectEntry(): void {
    setFailed(true);
    setLogin("");
    setPin("");
    setStage("login");
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
      rejectEntry();
    } catch (err) {
      // A crypto or store failure — `verifyPhc` reaches for `crypto.subtle`,
      // which an insecure context does not have. Treated as a rejection, the
      // way `Idle` treats a badge check that threw: nobody is admitted either
      // way, and the alternative is a submit that visibly does nothing at all
      // and an operator pressing it until they give up. Logged, because the
      // screen deliberately cannot say on-screen which of the causes it was.
      console.error("kiosk: the PIN could not be checked", err);
      rejectEntry();
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <main className="kiosk-screen kiosk-credential-gate" aria-labelledby="kiosk-gate-title">
        <section className="kiosk-credential-gate__details" aria-labelledby="kiosk-gate-title">
          <h1 id="kiosk-gate-title" className="kiosk-credential-gate__title">
            {t("scannerSetup.gateTitle")}
          </h1>
          <p className="kiosk-credential-gate__prompt">{t("scannerSetup.gatePrompt")}</p>
          {/* The single live region of this branch — the settings branch has its
              own, and the two never coexist. The PIN is shown as dots: a kiosk
              screen is a public one. */}
          <div role="status" className="kiosk-credential-gate__display">
            {stage === "login" ? login : "•".repeat(pin.length)}
          </div>
          {failed ? <Alert tone="error">{t("scannerSetup.gateError")}</Alert> : null}
          {/* The way out when signing in is impossible at all — an empty roster,
              a snapshot that never arrived, credentials nobody remembers. Without
              this line such a kiosk is bricked with no visible exit; with it, the
              cabinet can unbind the device and issue a new code, and the unpaired
              tier above opens setup again. */}
          <p className="kiosk-credential-gate__recovery">{t("scannerSetup.gateRecovery")}</p>
        </section>
        <section className="kiosk-credential-gate__entry" aria-labelledby="kiosk-gate-entry-label">
          <p id="kiosk-gate-entry-label" className="kiosk-credential-gate__entry-label">
            {stage === "login" ? t("scannerSetup.gateLogin") : t("scannerSetup.gatePin")}
          </p>
          <div className="kiosk-pin-pad">
            <PinPad
              value={stage === "login" ? login : pin}
              onChange={stage === "login" ? setLogin : setPin}
              maxLength={ENTRY_MAX}
            />
          </div>
          <div className="kiosk-credential-gate__actions">
            <Button
              className="kiosk-control kiosk-control--floor"
              variant="secondary"
              onClick={onClose}
            >
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
              className="kiosk-control kiosk-control--floor"
              variant="secondary"
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
                className="kiosk-control kiosk-control--floor"
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
                className="kiosk-control kiosk-control--floor"
                loading={busy}
                disabled={pin.length === 0}
                onClick={() => void submitPin()}
              >
                {t("scannerSetup.gateSubmit")}
              </Button>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="kiosk-screen kiosk-setup" aria-labelledby="kiosk-setup-title">
      <header className="kiosk-setup__header">
        <h1 id="kiosk-setup-title" className="kiosk-setup__title">
          {t("scannerSetup.title")}
        </h1>
      </header>
      <div className="kiosk-setup__workspace">
        {/* `fieldset`/`legend` rather than a div and a heading: the radios are one
            answer to one question, and that is exactly what the group role says. */}
        <fieldset className="kiosk-setup__panel">
          <legend className="kiosk-setup__transport-title">
            {t("scannerSetup.transportTitle")}
          </legend>
          <div className="kiosk-setup__option">
            <label className="kiosk-radio-option">
              <input
                className="kiosk-control kiosk-radio-option__input"
                type="radio"
                name="kiosk-scan-transport"
                value="keyboard"
                checked={transport === "keyboard"}
                aria-describedby={KEYBOARD_HINT_ID}
                onChange={() => choose("keyboard")}
              />
              <span>{t("scannerSetup.transportKeyboard")}</span>
            </label>
            <p id={KEYBOARD_HINT_ID} className="kiosk-setup__hint">
              {t("scannerSetup.transportKeyboardHint")}
            </p>
          </div>
          {/* Offered only where it can actually run. A tablet has no
              `navigator.serial`, and showing it a port picker it cannot open
              would be an installer's dead end, not a choice. */}
          {serialSupported ? (
            <div className="kiosk-setup__option">
              <label className="kiosk-radio-option">
                <input
                  className="kiosk-control kiosk-radio-option__input"
                  type="radio"
                  name="kiosk-scan-transport"
                  value="serial"
                  checked={transport === "serial"}
                  aria-describedby={SERIAL_HINT_ID}
                  onChange={() => choose("serial")}
                />
                <span>{t("scannerSetup.transportSerial")}</span>
              </label>
              <p id={SERIAL_HINT_ID} className="kiosk-setup__hint">
                {t("scannerSetup.transportSerialHint")}
              </p>
              {/* The picker was dismissed, so the pick did not happen. Naming
                  that is the whole point: the radio has visibly snapped back to
                  the keyboard, and an unexplained snap-back reads as a broken
                  screen rather than as «choose a port». */}
              {portRefused ? <Alert tone="warn">{t("scannerSetup.serialNotGranted")}</Alert> : null}
            </div>
          ) : (
            <p className="kiosk-setup__hint">{t("scannerSetup.transportSerialUnavailable")}</p>
          )}
        </fieldset>
        <section className="kiosk-setup__panel" aria-labelledby="kiosk-setup-test-title">
          <h2 id="kiosk-setup-test-title" className="kiosk-setup__panel-title">
            {t("scannerSetup.testTitle")}
          </h2>
          <p className="kiosk-setup__prompt">{t("scannerSetup.testPrompt")}</p>
          {/* Only the recognised KIND is echoed, never the payload: a badge is a
              credential, and printing it at arm's length on an unattended screen
              would hand it to whoever is standing there. */}
          <div role="status" className="kiosk-setup__result">
            {result ? t(resultKey(result.kind, serialSupported)) : t("scannerSetup.testWaiting")}
          </div>
        </section>
      </div>
      <footer className="kiosk-setup__footer">
        <Button className="kiosk-control kiosk-control--floor kiosk-setup__done" onClick={onClose}>
          {t("scannerSetup.done")}
        </Button>
      </footer>
    </main>
  );
}
