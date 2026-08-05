import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, type AlertTone } from "@markiro/ui";
import { classifyKioskScan } from "../domain-guard/classify.js";
import type { ScanListener } from "../scanner/source.js";

/**
 * How long the header must be held to reach scanner setup.
 *
 * Two seconds is chosen against the wrong input, not the right one: a customer
 * steadying themselves on the screen, a glove brushing the title, a child
 * poking it. None of those survive two seconds, and an operator who has been
 * told about the gesture does not find two seconds long.
 */
export const SETTINGS_HOLD_MS = 2_000;

/**
 * When the hold is acknowledged on screen. Late enough that an accidental
 * touch never sees it, early enough that an operator holding on purpose is not
 * left wondering whether the kiosk noticed — a gesture with no feedback at all
 * is one nobody believes in and everybody gives up on halfway.
 */
const SETTINGS_HINT_MS = 600;

/**
 * Why the last scan did not sign anyone in.
 *
 * `not-a-badge` is deliberately its own state rather than silence. Every
 * non-badge verdict of `classifyKioskScan` lands here — a marking code, a
 * marking code whose GS separator the wedge swallowed, a bare product barcode —
 * because at THIS screen they all have the same fix: scan the badge first. What
 * silence would look like to the worker is a scanner that is not reading, and
 * they would keep waving the bottle at it. Task 8 settled the same rule for the
 * cart's `not-a-code`.
 */
type IdleNotice = "unknown-badge" | "not-a-badge";

/** `error` for a badge we rejected, `warn` for a scan we simply cannot use yet:
 * one is «this did not work», the other is «not that one, this one». */
const NOTICE: Record<IdleNotice, { key: string; tone: AlertTone }> = {
  "unknown-badge": { key: "idle.badgeUnknown", tone: "error" },
  "not-a-badge": { key: "idle.notABadge", tone: "warn" },
};

export interface IdleProps {
  /**
   * Subscribes `listener` to the device's scans, and MAY return a teardown —
   * which this screen calls on unmount. The return is optional so a caller with
   * nothing to unwind can simply return nothing, but any real source has
   * something to unwind: `ScanSource.start` hands back the function that stops
   * it, and dropping that leaks a live subscription on every screen change.
   *
   * Called EXACTLY ONCE, at mount, and never again — see the effect below.
   */
  onScan: (listener: ScanListener) => void | (() => void);
  /**
   * Turns a raw badge payload into the employee it belongs to, or null when no
   * cached verifier matches (`credentials/badge.ts`). Injected rather than
   * imported so this screen owns no PBKDF2 and no snapshot.
   */
  resolveBadge: (raw: string) => Promise<string | null>;
  /** Exactly one call per session opened here, with the employee admitted. */
  onEmployee: (employeeId: string) => void;
  /**
   * The way into scanner setup on a RUNNING kiosk, raised by a deliberate long
   * press on the header (design brief 07 §5). Optional so a caller with nowhere
   * to go simply leaves the gesture inert.
   *
   * This screen only asks; it grants nothing. Everything behind it is still
   * gated on operator credentials by `ScannerSetup` — the press is an entry
   * path, not an authorisation.
   */
  onOpenSettings?: () => void;
}

/**
 * The unattended screen a kiosk shows between sessions: an invitation, and a
 * badge scan that starts one.
 *
 * EVERY scan goes through `classifyKioskScan` first and only `kind: "badge"`
 * reaches `resolveBadge`. That ordering is not a nicety — a marking code is a
 * structured payload that the permissive badge branch would otherwise hash as
 * a credential, burning a PBKDF2 derivation to sign the worker in as nobody
 * while the bottle they scanned is silently lost.
 *
 * The scanned payload is NEVER rendered. A badge is a credential and this
 * screen stands unattended in a public room; echoing it would hand it to
 * whoever is looking. `ScannerSetup`'s test scan follows the same rule.
 */
export function Idle({
  onScan,
  resolveBadge,
  onEmployee,
  onOpenSettings,
}: IdleProps): React.JSX.Element {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<IdleNotice | null>(null);
  /** Whether a press is currently being held long enough to be worth saying so. */
  const [holding, setHolding] = useState(false);

  // The callbacks, held in a ref so the listener below can read the current
  // ones without listing them as dependencies. The `useRef` initializer already
  // carries the mount values, so the effect only maintains later ones.
  const latest = useRef({ resolveBadge, onEmployee, onOpenSettings });
  useEffect(() => {
    latest.current = { resolveBadge, onEmployee, onOpenSettings };
  });

  /**
   * Two refs, not state, and each guards a different half of the same rule —
   * one badge scan admits one person.
   *
   * `resolving` closes the window a slow badge check leaves open: the check is
   * a PBKDF2 derivation, easily long enough for a second scan (a double tap, or
   * the next person in the queue) to land inside it. `admitted` closes the
   * window after it: once someone is in, nothing scanned afterwards may open a
   * second session over the first.
   *
   * Refs because both are read and written SYNCHRONOUSLY, before the first
   * `await`. A state flag is not visible to a second scan arriving in the same
   * tick — React has not re-rendered yet — so the guard would not exist exactly
   * when it is needed.
   */
  const resolving = useRef(false);
  const admitted = useRef(false);

  /**
   * Whether this instance is still on screen. A badge check is a PBKDF2
   * derivation and outlives the screen easily: the shell can swap the kiosk to
   * `blocked` (a stale cache, a lost pairing) while one is still running, and
   * the resolve then lands with `onEmployee` still callable. React 19 no longer
   * even warns about the `setNotice` that follows, so the whole thing is silent
   * — the shell would hold an `employeeId` behind the screen that replaced this
   * one, and drop the worker's successor into a cart belonging to someone who
   * has already walked away.
   */
  const live = useRef(true);

  /**
   * Held from the first render so the subscription can be mount-only.
   *
   * Subscribing once is load-bearing, not an optimisation. A parent that passes
   * an inline `onScan` (the shell composing it in JSX, and every test here)
   * gives a new function identity on every render, so a dependency on it would
   * tear the source down and resubscribe after each state change — and a source
   * that replays or delivers synchronously would then re-deliver the very scan
   * whose notice caused the render, looping. `ScannerSetup` and `Pairing` solve
   * the same problem the other way, by demanding a referentially stable
   * `subscribe`; here the screen simply refuses to care.
   */
  const subscribe = useRef(onScan);

  useEffect(() => {
    live.current = true;
    const stop = subscribe.current((raw) => {
      // Checked before the scan is even classified. Once someone is in, this
      // screen has nothing left to say: answering a stray bottle with «scan
      // your badge first» would contradict the badge that just worked, on a
      // screen the worker is in the middle of leaving.
      if (admitted.current) return;
      const scan = classifyKioskScan(raw);
      if (scan.kind !== "badge") {
        setNotice("not-a-badge");
        return;
      }
      if (resolving.current) return;
      resolving.current = true;
      void (async () => {
        try {
          const employeeId = await latest.current.resolveBadge(scan.raw);
          // The screen may have gone while the derivation ran; nothing this
          // instance learned afterwards belongs to whatever replaced it.
          if (!live.current) return;
          if (employeeId === null) {
            setNotice("unknown-badge");
            return;
          }
          admitted.current = true;
          setNotice(null);
          latest.current.onEmployee(employeeId);
        } catch (err) {
          // A store or crypto failure, and the worker must not be left staring
          // at an unchanged screen forever. They get the same message a
          // rejected badge earns: nobody is admitted either way, and the kiosk
          // cannot honestly tell them which of the two happened.
          console.error("kiosk: the badge could not be checked", err);
          if (live.current) setNotice("unknown-badge");
        } finally {
          // On EVERY exit, admitting or not. A guard left standing after a
          // failed check is a kiosk that refuses every badge after the first
          // one it could not read, until someone reboots it.
          resolving.current = false;
        }
      })();
    });
    return () => {
      live.current = false;
      if (stop) stop();
    };
  }, []);

  /**
   * The settings gesture, as two timers on one press.
   *
   * NOT A BUTTON, and not focusable. Two reasons, and the second is the sharp
   * one: this screen faces the public, and the kiosk's scanner is a keyboard
   * wedge — it "types" a badge and finishes with Enter. Any focusable control
   * standing on the idle screen is therefore one stray focus away from being
   * activated by the next person who scans their badge.
   *
   * A press is cancelled by anything that is not a completed hold — a release,
   * a finger sliding off the title, the browser taking the pointer away for a
   * scroll or a context menu. Only the timer surviving all of that opens the
   * gate.
   */
  const holdHint = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOpen = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endHold = useCallback(() => {
    if (holdHint.current !== null) {
      clearTimeout(holdHint.current);
      holdHint.current = null;
    }
    if (holdOpen.current !== null) {
      clearTimeout(holdOpen.current);
      holdOpen.current = null;
    }
    setHolding(false);
  }, []);

  const beginHold = useCallback(() => {
    // No caller for the gesture: leave the header inert rather than run a
    // timer whose only outcome is showing a hint about a screen nobody opens.
    if (!latest.current.onOpenSettings) return;
    endHold();
    holdHint.current = setTimeout(() => setHolding(true), SETTINGS_HINT_MS);
    holdOpen.current = setTimeout(() => {
      endHold();
      latest.current.onOpenSettings?.();
    }, SETTINGS_HOLD_MS);
  }, [endHold]);

  // A press in progress when this screen goes (a transport swap, a badge that
  // resolved, the cache ageing out) must not fire into whatever replaced it.
  useEffect(() => endHold, [endHold]);

  return (
    <main className="kiosk-screen kiosk-screen--centered kiosk-idle">
      {/* Decoration: the wordless "this kiosk reads codes" cue the prototype
          opens with. Hidden from assistive tech — everything it signals is
          said in words below. */}
      <svg width="88" height="88" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect x="4" y="4" width="56" height="56" fill="var(--surface-inverse)" />
        <g fill="var(--surface-page)">
          <rect x="14" y="14" width="8" height="8" />
          <rect x="14" y="26" width="8" height="8" />
          <rect x="14" y="38" width="8" height="8" />
          <rect x="26" y="22" width="8" height="8" />
          <rect x="38" y="14" width="8" height="8" />
          <rect x="38" y="26" width="8" height="8" />
          <rect x="38" y="38" width="8" height="8" />
          <rect x="26" y="42" width="8" height="8" fill="var(--ok-fg)" />
        </g>
      </svg>
      {/* The header, and the kiosk's only way back into scanner setup. The
          handlers sit on the whole block rather than the title alone so a
          gloved thumb has a target it can actually hold; `userSelect` stops the
          press turning into a text selection on the way. */}
      <header
        onPointerDown={beginHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        style={{
          display: "grid",
          gap: 10,
          justifyItems: "center",
          userSelect: "none",
          WebkitUserSelect: "none",
          touchAction: "manipulation",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "2.5rem", lineHeight: 1.2 }}>{t("idle.title")}</h1>
        <p style={{ margin: 0, fontSize: "1.25rem", color: "var(--fg-2)" }}>{t("idle.subtitle")}</p>
        {/* Only while a press is actually being held, and quiet: it tells the
            operator the kiosk noticed, and says nothing a customer could act
            on — the gate behind it still wants a badge or a PIN. */}
        {holding ? (
          <p style={{ margin: 0, fontSize: "1rem", color: "var(--fg-3)" }}>
            {t("idle.settingsHold")}
          </p>
        ) : null}
      </header>
      {/* A panel, not a button. The prototype's tap target exists only to fake
          a scan for the demo; on the real device the scanner is the only way
          in, and a control that does nothing under a gloved hand teaches the
          worker that this screen is unresponsive. */}
      <div
        style={{
          width: 420,
          maxWidth: "100%",
          boxSizing: "border-box",
          padding: "36px 32px",
          borderRadius: 16,
          border: "2px dashed var(--line-strong)",
          background: "var(--surface-card)",
          display: "grid",
          justifyItems: "center",
          gap: 16,
        }}
      >
        <svg
          width="72"
          height="72"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-2)"
          strokeWidth="1.5"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" />
          <path
            d="M5.5 5.5h2v2h-2zM16.5 5.5h2v2h-2zM5.5 16.5h2v2h-2zM14 14h2.5v2.5H14zM18.5 14H21v2.5h-2.5zM14 18.5h2.5V21H14zM18.5 18.5H21V21h-2.5z"
            fill="var(--fg-2)"
            stroke="none"
          />
        </svg>
        {/* Two keys, one sentence: the design breaks the line after «QR-код»,
            and a dictionary entry carrying markup would push that break past
            every future translator. */}
        <p style={{ margin: 0, fontSize: "1.625rem", fontWeight: 600, lineHeight: 1.25 }}>
          {t("idle.scan")}
          <br />
          {t("idle.scanTarget")}
        </p>
      </div>
      {/* `Alert` brings its own `role="alert"`, so this screen adds no live
          region of its own — exactly as `Pairing` does with its failures. */}
      {notice ? (
        <Alert tone={NOTICE[notice].tone} style={{ maxWidth: 560, textAlign: "left" }}>
          {t(NOTICE[notice].key)}
        </Alert>
      ) : null}
      <p style={{ margin: 0, maxWidth: 560, fontSize: "1rem", color: "var(--fg-3)" }}>
        {t("idle.hint")}
      </p>
    </main>
  );
}
