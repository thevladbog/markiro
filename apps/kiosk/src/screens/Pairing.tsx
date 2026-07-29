import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input, PinPad, Spinner } from "@markiro/ui";
import { KioskApiError, pairKiosk } from "../api/client.js";
import type { ScanListener } from "../scanner/source.js";
import {
  assertMeasurableGeneratedAt,
  replaceSnapshot,
  UnusableBootstrapError,
} from "../store/cache.js";
import { kioskIdOf, writeConfig } from "../store/config.js";

/** `POST /kiosk/pair` accepts `/^\d{8}$/` — the admin panel issues nothing else. */
const CODE_LENGTH = 8;

/**
 * How long the success confirmation stands before the device goes to work.
 *
 * Long enough to be read at arm's length in floor mode, and short enough that
 * an installer who has already walked away does not leave a kiosk parked on a
 * screen nobody will press. Design 2026-07-24 §5.2 asks for the confirmation
 * («Успех → „Киоск привязан к точке X“ → рабочий режим») but names no duration
 * — unlike §8.2's banner, so this number is a judgement and not a quoted one.
 */
const HANDOFF_MS = 4_000;

export interface PairingProps {
  defaultServerUrl: string;
  /**
   * The device's scanner, as the shell's fan-out over whatever transport it is
   * running — the same subscription `Idle`, `Cart` and `ScannerSetup` take, and
   * never a `ScanSource` this screen starts for itself.
   *
   * Design brief 07 §5 puts scanner setup BEFORE pairing precisely so the
   * pairing barcode can be scanned, which means the installer who follows the
   * prescribed order arrives here on Web Serial. `createWebSerialSource` is
   * single-subscriber — `port.readable` is locked by the first reader, and the
   * shell has held that reader since boot — so a source started here reads
   * nothing at all, and the one flow the transport was configured for is the
   * one flow it cannot serve.
   *
   * MUST BE REFERENTIALLY STABLE: the effect below lists it in its
   * dependencies. Returns its own unsubscribe.
   */
  subscribe: (listener: ScanListener) => () => void;
  onPaired: () => void;
  onConfigureScanner: () => void;
}

/** Which message the failure earns. The split is the whole point: a mistyped
 * code, a dead network and a server bundle we cannot store need different
 * instructions from the worker — retype, retry, or fetch a new code.
 *
 * There is deliberately NO separate "too many attempts" member, even though
 * the design brief lists that state: `assertUnderPairRateLimit`
 * (`apps/api/src/modules/kiosk/pairing.service.ts:401`) answers a tripped
 * rate-limit budget with a bare `UnauthorizedException`, byte-identical to the
 * 401 a wrong code earns, precisely so an attacker cannot tell a bad guess
 * from a lockout — and cannot use the difference as an oracle. The
 * screen therefore CANNOT know which one happened, and asking the server to
 * tell it would hand that oracle away — so `code` carries copy that names both
 * and gives the one action that resolves either. Do not "fix" the missing
 * state by adding a distinguishing response.
 */
type PairingError = "code" | "connection" | "bundle" | "spent" | "scan";

const MESSAGE_KEY: Record<PairingError, string> = {
  code: "pairing.invalidCode",
  connection: "pairing.connectionFailed",
  bundle: "pairing.badBundle",
  spent: "pairing.codeSpent",
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
  subscribe,
  onPaired,
  onConfigureScanner,
}: PairingProps): React.JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [serverOpen, setServerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError | null>(null);
  // Purely presentational: the listener below runs whether this is true or
  // false. It exists so the «Сканировать код» button has something honest to
  // do — press it and the screen visibly commits to waiting for the scan,
  // which at arm's length in floor mode is the difference between an
  // affordance and a decoration.
  const [awaitingScan, setAwaitingScan] = useState(false);
  /**
   * WHICH KIOSK THIS DEVICE JUST BECAME — set once both writes are durable, and
   * the whole of the success state.
   *
   * `null` means "still pairing". Anything else means the device is bound and
   * this screen is showing the installer what it was bound TO, which is the one
   * check that catches the commissioning mistake nothing else on the device
   * can: a tablet redeemed against the wrong kiosk row. Both fields were
   * already being written to `KioskConfig` and read by nothing at all.
   */
  const [bound, setBound] = useState<{ kioskName: string; place: string | null } | null>(null);

  // Listening starts at MOUNT rather than on a button press: the admin panel's
  // pairing modal renders the code as a barcode and tells the worker to scan
  // it, and at an unattended kiosk the instinct is simply to scan — a listener
  // that has to be armed first drops exactly that scan.
  //
  // It PAUSES while the server-address field is open, and only then: the
  // keyboard wedge is a window-level `keydown` handler, so what is typed into
  // that field would otherwise arrive here as a scan. LEAVING THE FAN-OUT is
  // what pauses it — the shell's transport keeps running, as it must, since a
  // screen has no business stopping the device's scanner; it simply stops
  // being delivered here. `serverOpen` is the whole reason this effect has a
  // dependency other than `subscribe`; both are stable across renders, so the
  // subscription is dropped once, when it must be.
  useEffect(() => {
    if (serverOpen) return;
    // And it stops for good once the device is bound: the code field is gone
    // from the screen, so a scan delivered here could only fill in something
    // nobody can see or submit.
    if (bound) return;
    return subscribe((raw) => {
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
      // What the waiting state was waiting for has arrived, so the state ends.
      // A rejected scan deliberately leaves it standing: still listening, and
      // the worker is still meant to scan.
      setAwaitingScan(false);
    });
  }, [subscribe, serverOpen, bound]);

  // Held in a ref so the countdown below can depend on `bound` alone while
  // still calling the CURRENT callback — the shell composes `onPaired` inline
  // in JSX, so a dependency on it would restart the four seconds on every
  // re-render. Exactly the shape `Done` uses for its own auto-reset.
  const latest = useRef(onPaired);
  useEffect(() => {
    latest.current = onPaired;
  });

  /**
   * The handover, and it happens EXACTLY ONCE.
   *
   * A ref rather than state because the two halves of a double tap on an 88px
   * button arrive in the same tick, before React has re-rendered. `onPaired`
   * re-reads the whole device state in the shell and routes away from this
   * screen; running it twice for one pairing would reload the store behind the
   * idle screen that replaced this one.
   */
  const handedOver = useRef(false);
  const handOver = useCallback(() => {
    if (handedOver.current) return;
    handedOver.current = true;
    latest.current();
  }, []);

  /**
   * ...and it happens on its own if nobody presses the button. An installer who
   * has read the confirmation walks away from the tablet, and a kiosk parked on
   * a success screen is a kiosk that never opens for business.
   *
   * Cleared on unmount, always — the shell unmounts this screen the moment the
   * handover lands, and a timer surviving that would call back into a device
   * that has already moved on.
   */
  useEffect(() => {
    if (!bound) return;
    const timer = setTimeout(handOver, HANDOFF_MS);
    return () => clearTimeout(timer);
  }, [bound, handOver]);

  async function submit(): Promise<void> {
    if (busy || code.length !== CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    setAwaitingScan(false); // the code is in; nothing is being waited for now
    /**
     * Whether the code has been REDEEMED — the one fact that decides which
     * failures are retryable, and it is not something the error can be asked
     * about. `attemptRedeem` sets `usedAt` and rotates the device token the
     * moment the server answers 200, so from this line onwards the entered code
     * is spent and every retry with it can only ever come back 401. A failure
     * after this point is therefore a spent-code failure however store-shaped
     * or network-shaped it looks.
     */
    let redeemed = false;
    try {
      const result = await pairKiosk(serverUrl, code);
      redeemed = true;
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
        // THE ONE MOMENT THIS DEVICE'S KIOSK IDENTITY IS ESTABLISHED, so it is
        // the one place it can be recorded. The day count needs it to tell its
        // own gate's orders from the ones the server reports in
        // `takenTodayElsewhere`, and re-pairing is exactly the event that used
        // to make the two overlap. Checked rather than trusted — the response
        // is a cast over `res.json()`, and a server too old to name the kiosk
        // must leave the device unidentified rather than bound to `undefined`.
        kioskId: kioskIdOf(result.device),
        kioskName: result.device.kioskName,
        place: result.device.place,
        // Continues the counter instead of restarting at 0, so a re-paired
        // device cannot collide with the idempotency keys of its own past orders.
        nextDeviceSeq: result.nextDeviceSeq,
      });
      // AFTER both writes, and instead of handing over immediately: the device
      // is bound, and §5.2 wants the installer told WHICH kiosk it is bound to
      // before the working mode replaces this screen. Read off the response
      // rather than back out of the store — it is the same pair of values, one
      // read closer to the server that decided them.
      setBound({ kioskName: result.device.kioskName, place: result.device.place });
    } catch (err) {
      if (err instanceof UnusableBootstrapError) {
        // Not a network blink, and it must not be dressed as one: the code was
        // SPENT redeeming this response, so retrying with it can only 401. The
        // only exit is a new code, which is what the message asks for — and why
        // this branch offers no Retry button.
        setError("bundle");
      } else if (redeemed) {
        // The response was good and the code is gone: what failed is one of the
        // two local writes (an IndexedDB quota or transaction error). The device
        // is still unpaired and still recoverable — the write order above sees
        // to that — but NOT with this code, so calling it a connection blink and
        // offering Retry would walk the installer through a guaranteed 401
        // instead of sending them for a new code.
        setError("spent");
      } else if (err instanceof KioskApiError && err.status === 401) {
        setError("code");
        setCode(""); // wrong code: the entry has to be redone anyway
      } else {
        // The request never landed: transport or server, with the code still
        // unspent. It is KEPT and the retry can reuse it.
        setError("connection");
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * The confirmation, and it REPLACES the form rather than sitting above it.
   *
   * A keypad left standing under a device that is already bound invites a
   * second pairing attempt with a code that is now spent, and there is nothing
   * left on this screen for a scan to fill in.
   *
   * `role="status"` and not `role="alert"`: this is a success, announced once,
   * and the error `Alert` above is the screen's only assertive region. The
   * point is named in the headline exactly as §5.2 words it, and the KIOSK is
   * named on its own line — an installer at a gate is checking two facts, and
   * folding them into one sentence is how the second one gets skipped.
   */
  if (bound) {
    return (
      <main
        role="status"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          alignContent: "center",
          gap: 20,
          padding: 40,
          textAlign: "center",
        }}
      >
        {/* Decoration: the tick `Done` uses, in the same square. Hidden from
            assistive tech — everything it signals is said in words below. */}
        <svg
          width="104"
          height="104"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ok-solid)"
          strokeWidth="2"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="2" y="2" width="20" height="20" />
          <path d="M7 12.5l3.5 3.5L17 8.5" />
        </svg>
        <h1 style={{ fontSize: "2.25rem", margin: 0 }}>
          {/* `place` is nullable — the server maps it from `kiosks.location`,
              which an administrator need never fill in. «привязан к точке „“»
              would read as a broken screen at the exact moment somebody is
              checking the binding, so the empty case gets its own sentence. */}
          {bound.place === null
            ? t("pairing.boundNoPlace")
            : t("pairing.bound", { place: bound.place })}
        </h1>
        <p style={{ fontSize: "1.75rem", margin: 0 }}>
          {t("pairing.boundName", { name: bound.kioskName })}
        </p>
        <p style={{ fontSize: "1rem", margin: 0, color: "var(--fg-3)" }}>
          {t("pairing.boundHint")}
        </p>
        <Button style={{ minHeight: 88, minWidth: 320, fontSize: "1.5rem" }} onClick={handOver}>
          {t("pairing.boundContinue")}
        </Button>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 20 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("pairing.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>{t("pairing.prompt")}</p>
      {/* `role="status"`: what has been entered so far is announced as it
          changes, which is what a worker filling it by scanner needs. It was an
          `aria-label="code"` — a test hook no screen reader reads out. */}
      <div role="status" style={{ fontSize: "3rem", letterSpacing: "0.5rem", minHeight: "3rem" }}>
        {code}
      </div>
      {/* Binding in progress. Redeeming the code also pulls the whole dataset
          down in the same response, and on a gate link that is long enough for
          a worker to decide the device is dead — so the wait is named, not left
          to a greyed-out button. `aria-live` rather than `role="status"`: the
          code display above already owns that role, and two of them would make
          "the status" ambiguous to a screen reader and to the tests. The
          spinner is `aria-hidden` for the same reason — it is decoration beside
          text that already says what is happening. */}
      {busy ? (
        <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Spinner size={32} aria-hidden="true" />
          <span style={{ fontSize: "1.25rem" }}>{t("pairing.binding")}</span>
        </div>
      ) : null}
      {error ? (
        <Alert
          tone="error"
          action={
            // Retry is offered ONLY where retrying can work, which is the one
            // case where the code was never redeemed. A wrong code has to be
            // retyped, and a code already spent — on an unusable bundle, or on
            // a response the store then refused to keep — cannot be redeemed
            // twice, so a button there would loop the worker through 401s.
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
      <PinPad
        value={code}
        // Typing is a decision to use the pad instead, so the screen stops
        // claiming it is waiting for a scan. The listener stays armed either
        // way — only the announcement ends.
        onChange={(next) => {
          setCode(next);
          setAwaitingScan(false);
        }}
        maxLength={CODE_LENGTH}
      />
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
      {/* The keypad's twin, as the brief has it. It does NOT arm the listener —
          that happens at mount, so a worker who simply scans still pairs
          (`awaitingScan` is presentation only). What it does is announce the
          capability at a size that is legible across a room, and put the screen
          into the waiting state so the worker knows the scan will be taken.
          Hidden exactly when scanning cannot work, which is now one case and
          not two: the server field is holding the keyboard the wedge listens
          on, so this screen has left the fan-out. There is no second case —
          the shell always runs a transport (the wedge is available everywhere,
          and a serial source exists only where a port was granted), so a
          «scanning is impossible» state cannot be reached. */}
      {!serverOpen ? (
        <div style={{ display: "grid", justifyItems: "center", gap: 12 }}>
          <Button
            variant="secondary"
            style={{ minHeight: 88, minWidth: 320, fontSize: "1.5rem" }}
            aria-pressed={awaitingScan}
            disabled={busy}
            onClick={() => setAwaitingScan(true)}
          >
            {t("pairing.scan")}
          </Button>
          {awaitingScan ? (
            <div
              aria-live="polite"
              style={{ display: "grid", justifyItems: "center", gap: 8, textAlign: "center" }}
            >
              <Spinner size={40} aria-hidden="true" />
              <p style={{ fontSize: "1.75rem" }}>{t("pairing.scanWaiting")}</p>
              <p style={{ fontSize: "1rem", color: "var(--fg-3)" }}>
                {t("pairing.scanWaitingHint")}
              </p>
            </div>
          ) : (
            // The line the previous round put here on its own. It stays, folded
            // under the button, because it carries the one thing the button
            // cannot say: pressing it is optional.
            <p style={{ fontSize: "1rem", color: "var(--fg-3)" }}>{t("pairing.scanHint")}</p>
          )}
        </div>
      ) : null}
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
          onClick={() => {
            setServerOpen((open) => !open);
            // The wedge is paused while this field has the keyboard, so a
            // waiting state left standing across the toggle would be a lie.
            setAwaitingScan(false);
          }}
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
