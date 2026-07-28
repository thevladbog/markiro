import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, type AlertTone } from "@markiro/ui";
import { classifyKioskScan } from "../domain-guard/classify.js";
import type { ScanListener } from "../scanner/source.js";

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
export function Idle({ onScan, resolveBadge, onEmployee }: IdleProps): React.JSX.Element {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<IdleNotice | null>(null);

  // The callbacks, held in a ref so the listener below can read the current
  // ones without listing them as dependencies. The `useRef` initializer already
  // carries the mount values, so the effect only maintains later ones.
  const latest = useRef({ resolveBadge, onEmployee });
  useEffect(() => {
    latest.current = { resolveBadge, onEmployee };
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
   * Held from the first render so the subscription can be mount-only.
   *
   * Subscribing once is load-bearing, not an optimisation. A parent that passes
   * an inline `onScan` (the shell composing it in JSX, and every test here)
   * gives a new function identity on every render, so a dependency on it would
   * tear the source down and resubscribe after each state change — and a source
   * that replays or delivers synchronously would then re-deliver the very scan
   * whose notice caused the render, looping. `ScannerSetup` solves the same
   * problem the other way, by demanding a referentially stable `scanSource`;
   * here the screen simply refuses to care.
   */
  const subscribe = useRef(onScan);

  useEffect(() => {
    return subscribe.current((raw) => {
      const scan = classifyKioskScan(raw);
      if (scan.kind !== "badge") {
        setNotice("not-a-badge");
        return;
      }
      if (resolving.current || admitted.current) return;
      resolving.current = true;
      void (async () => {
        try {
          const employeeId = await latest.current.resolveBadge(scan.raw);
          if (employeeId === null) {
            setNotice("unknown-badge");
            return;
          }
          // Re-checked AFTER the await as well: `resolving` only serialises the
          // checks, so without this a second badge queued behind the first
          // would still get its own turn once the first has admitted someone.
          if (admitted.current) return;
          admitted.current = true;
          setNotice(null);
          latest.current.onEmployee(employeeId);
        } catch (err) {
          // A store or crypto failure, and the worker must not be left staring
          // at an unchanged screen forever. They get the same message a
          // rejected badge earns: nobody is admitted either way, and the kiosk
          // cannot honestly tell them which of the two happened.
          console.error("kiosk: the badge could not be checked", err);
          setNotice("unknown-badge");
        } finally {
          resolving.current = false;
        }
      })();
    });
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        alignContent: "center",
        justifyItems: "center",
        gap: 28,
        padding: 40,
        boxSizing: "border-box",
        textAlign: "center",
      }}
    >
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
      <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: "2.5rem", lineHeight: 1.2 }}>{t("idle.title")}</h1>
        <p style={{ margin: 0, fontSize: "1.25rem", color: "var(--fg-2)" }}>{t("idle.subtitle")}</p>
      </div>
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
