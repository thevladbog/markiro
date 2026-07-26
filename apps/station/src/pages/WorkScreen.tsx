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
  // accept an already-known code, fail the INSERT, roll the journal write
  // back, and leave the operator with no signal at all.
  const keysReady = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    keysReady.current = loadCodeKeys(exec).then((loaded) => {
      if (!cancelled) keys.current = loaded;
    });
    return () => {
      cancelled = true;
    };
  }, [exec]);

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
            await recordScan(
              exec,
              event,
              km
                ? {
                    codeHash: kmKey(km),
                    shiftId,
                    gtin14: km.gtin14,
                    serial: km.serial,
                    scannedAt,
                  }
                : null,
            );
            if (km) keys.current.add(kmKey(km));
            return { raw, verdict, firstSeen: null };
          }

          await recordScan(exec, event, null);
          const firstSeen =
            verdict.status === "duplicate" ? await findFirstSeen(exec, verdict.key) : null;
          return { raw, verdict, firstSeen };
        },
        onOutcome(outcome) {
          const tone = toneOf(outcome.verdict);
          if (outcome.verdict.status === "ok") setAccepted((n) => n + 1);
          else setRejected((n) => n + 1);

          const title =
            outcome.verdict.status === "duplicate"
              ? t("signal.duplicate")
              : outcome.verdict.status === "wrong_gtin"
                ? t("signal.wrongGtin")
                : outcome.verdict.status === "invalid"
                  ? t("signal.wrongCode")
                  : "";
          const detail =
            outcome.firstSeen === null
              ? undefined
              : t("signal.firstSeen", {
                  time: new Intl.DateTimeFormat(
                    i18n.language.startsWith("ru") ? "ru-RU" : "en-US",
                    {
                      timeStyle: "medium",
                    },
                  ).format(new Date(outcome.firstSeen)),
                });

          playSignalTone(tone, sound);
          setSignal({ tone, title, ...(detail === undefined ? {} : { detail }) });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS[tone]);
        },
      }),
    [exec, shiftId, terminalId, expectedGtin14, sound, t, i18n.language],
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
