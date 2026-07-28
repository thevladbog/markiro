import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { classifyScan, kmKey, validateShiftScan, type ScanVerdict } from "@markiro/domain";
import { findFirstSeen, loadCodeKeys, recordScan } from "../lib/journal.js";
import type { SqlExecutor } from "../lib/mirror.js";
import { createScanQueue, type ScanOutcome } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import { playSignalTone, type SoundSettings } from "../lib/signal-sound.js";
import { SignalOverlay, type SignalTone } from "../ui/SignalOverlay.js";

export interface WorkScreenProps {
  exec: SqlExecutor;
  shiftId: string;
  terminalId: string | null;
  expectedGtin14: string;
  productName: string;
  counterpartyName?: string | null;
  source: ScanSource;
  sound: SoundSettings;
  /** Signals a scan was just written, so a queued outbox row does not have
   * to wait for the sync engine's 15s heartbeat before draining. */
  onScanRecorded?: () => void;
}

/** How long each verdict's full-screen flash stays up (design brief 04). */
const FLASH_MS: Record<SignalTone, number> = { ok: 350, error: 1200, duplicate: 900 };

function toneOf(verdict: ScanVerdict): SignalTone {
  if (verdict.status === "ok") return "ok";
  if (verdict.status === "duplicate") return "duplicate";
  return "error";
}

export function WorkScreen({
  exec,
  shiftId,
  terminalId,
  expectedGtin14,
  productName,
  counterpartyName,
  source,
  sound,
  onScanRecorded,
}: WorkScreenProps) {
  const { t, i18n } = useTranslation();
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [signal, setSignal] = useState<{ tone: SignalTone; title: string; detail?: string } | null>(
    null,
  );

  // The domain's isDuplicate(key) is synchronous, so the device's accepted keys
  // are held in memory and updated on every insert rather than queried per scan.
  const keys = useRef<Set<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The duplicate index must be in memory before the first scan is judged.
  // The scan source starts listening immediately (so nothing is missed) and
  // the queue serialises, so awaiting the load here simply makes the first
  // scan wait rather than validating against an empty set — which would
  // wrongly accept an already-known code. Even then, codes_mirror's PRIMARY
  // KEY is the backstop: recordScan reports that as `alreadyPresent` and the
  // verdict is corrected below, rather than the write failing outright.
  const keysReady = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resilient by construction: `keysReady` is awaited before every scan is
    // judged, so if this promise ever REJECTED, every later scan would await
    // a rejected promise and vanish silently forever. A failed load instead
    // falls back to an empty index — codes_mirror's PRIMARY KEY is still the
    // real backstop against duplicates (see journal.ts's recordScan), and now
    // correctly yields a `duplicate` verdict instead of a lost scan.
    keysReady.current = loadCodeKeys(exec)
      .then((loaded) => {
        if (!cancelled) keys.current = loaded;
      })
      .catch((err) => {
        console.error("station: failed to load accepted code keys", err);
        if (!cancelled) keys.current = new Set();
      });
    return () => {
      cancelled = true;
    };
  }, [exec]);

  // `t`, `i18n.language`, `sound` and `onScanRecorded` all change over the
  // life of one mounted WorkScreen (a language switch, a mute/volume change
  // in setup, a fresh callback identity from App on every render), but the
  // queue below must NOT be recreated when they do: `source.start(...)`
  // (further down) is bound to one queue instance, and a fresh queue has its
  // own buffer and `draining` flag — if the `useMemo` depended on these
  // values, a change would leave the old queue's buffer (still fed by the
  // bound source) draining concurrently with a brand new queue, breaking the
  // "exactly one scan in flight" guarantee the whole pipeline rests on. So
  // `process`/`onOutcome`/`onError` read the current values through this ref
  // instead of closing over the props/hooks directly.
  const live = useRef({ t, language: i18n.language, sound, onScanRecorded });
  useEffect(() => {
    live.current = { t, language: i18n.language, sound, onScanRecorded };
  });

  const queue = useMemo(
    () =>
      createScanQueue({
        async process(raw): Promise<ScanOutcome> {
          await keysReady.current;
          const verdict = validateShiftScan(raw, {
            expectedGtin14,
            isDuplicate: (key) => keys.current.has(key),
          });
          const scannedAt = new Date().toISOString();
          const event = { shiftId, terminalId, raw, verdict: verdict.status, scannedAt };

          if (verdict.status === "ok") {
            const scan = classifyScan(raw);
            // `ok` is only produced for a parsed KM, so this branch always holds.
            const km = scan.kind === "km" ? scan.km : null;
            const codeHash = km ? kmKey(km) : null;
            const result = await recordScan(
              exec,
              event,
              km && codeHash
                ? { codeHash, shiftId, gtin14: km.gtin14, serial: km.serial, scannedAt }
                : null,
            );
            if (result.alreadyPresent && codeHash) {
              // The in-memory duplicate index missed this one; codes_mirror's
              // PRIMARY KEY is the real backstop (see journal.ts's recordScan
              // doc comment), so the verdict is corrected here instead of
              // reporting a false accept.
              keys.current.add(codeHash);
              const firstSeen = await findFirstSeen(exec, codeHash);
              return { raw, verdict: { status: "duplicate", key: codeHash }, firstSeen };
            }
            if (codeHash) keys.current.add(codeHash);
            return { raw, verdict, firstSeen: null };
          }

          await recordScan(exec, event, null);
          const firstSeen =
            verdict.status === "duplicate" ? await findFirstSeen(exec, verdict.key) : null;
          return { raw, verdict, firstSeen };
        },
        onOutcome(outcome) {
          const {
            t: liveT,
            language,
            sound: liveSound,
            onScanRecorded: liveOnScanRecorded,
          } = live.current;
          const tone = toneOf(outcome.verdict);
          if (outcome.verdict.status === "ok") setAccepted((n) => n + 1);
          else setRejected((n) => n + 1);
          // `process()` above already wrote this outcome's outbox row (every
          // branch calls `recordScan`, whatever the verdict) by the time
          // `onOutcome` runs, so the sync engine has real work to nudge for.
          liveOnScanRecorded?.();

          const title =
            outcome.verdict.status === "duplicate"
              ? liveT("signal.duplicate")
              : outcome.verdict.status === "wrong_gtin"
                ? liveT("signal.wrongGtin")
                : outcome.verdict.status === "invalid"
                  ? liveT("signal.wrongCode")
                  : "";
          const detail =
            outcome.firstSeen === null
              ? undefined
              : liveT("signal.firstSeen", {
                  time: new Intl.DateTimeFormat(language.startsWith("ru") ? "ru-RU" : "en-US", {
                    timeStyle: "medium",
                  }).format(new Date(outcome.firstSeen)),
                });

          playSignalTone(tone, liveSound);
          setSignal({ tone, title, ...(detail === undefined ? {} : { detail }) });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS[tone]);
        },
        onError(raw, err) {
          // A throw from process() (e.g. the journal write) must never leave
          // the operator with silence: they scanned something and need SOME
          // signal, distinct from an ordinary rejection, so they know to
          // rescan rather than assume the code was accepted.
          console.error("station: scan write failed", raw, err);
          setRejected((n) => n + 1);
          const { t: liveT, sound: liveSound } = live.current;
          playSignalTone("error", liveSound);
          setSignal({ tone: "error", title: liveT("signal.systemError") });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS.error);
        },
      }),
    [exec, shiftId, terminalId, expectedGtin14],
  );

  useEffect(() => source.start((raw) => queue.enqueue(raw)), [source, queue]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <main
      style={{ minHeight: "100%", padding: 32, display: "flex", flexDirection: "column", gap: 24 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: "2rem", fontWeight: 700 }}>{productName}</span>
        {counterpartyName ? (
          <span style={{ fontSize: "1.25rem", opacity: 0.85 }}>
            {t("shifts.forCounterparty")} {counterpartyName}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "1.25rem", opacity: 0.8 }}>{t("work.accepted")}</span>
          <span style={{ fontSize: "6rem", fontWeight: 800, lineHeight: 1 }}>{accepted}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "1.25rem", opacity: 0.8 }}>{t("work.rejected")}</span>
          <span style={{ fontSize: "6rem", fontWeight: 800, lineHeight: 1 }}>{rejected}</span>
        </div>
      </div>

      <span style={{ fontSize: "1.25rem", opacity: 0.7 }}>{t("work.waiting")}</span>

      {signal ? (
        <SignalOverlay
          tone={signal.tone}
          title={signal.title}
          {...(signal.detail === undefined ? {} : { detail: signal.detail })}
        />
      ) : null}
    </main>
  );
}
