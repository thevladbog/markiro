import { useCallback, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button, FullScreenDialog, Select } from "@markiro/ui";

import { downloadFile } from "../../office/templates/download.js";
import type { ScanChannel } from "../scan-source.js";
import {
  expectedStructure,
  GS_MARK,
  judgeScan,
  makeSelfTestCode,
  pushHistory,
  visible,
  type SelfTestEntry,
  type SelfTestKind,
  type Verdict,
} from "./scanner-selftest.js";
import { symbolPdf, symbolPng, symbolSvg } from "./scanner-selftest-symbol.js";

/** The self-test's state, kept by the setup screen so a change of tab keeps the code and the results. */
export interface ScannerSelfTestState {
  kind: SelfTestKind;
  code: string;
  /** The verdict of the last scan of THIS code; `null` until one comes. */
  current: SelfTestEntry | null;
  history: readonly SelfTestEntry[];
  setKind: (kind: SelfTestKind) => void;
  renew: () => void;
  /** The setup's scan listener hands every scan here. */
  onScan: (raw: string, channel: ScanChannel) => void;
}

function clockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function useScannerSelfTest(now: () => Date = () => new Date()): ScannerSelfTestState {
  const [kind, setKindState] = useState<SelfTestKind>("dm");
  const [code, setCode] = useState(() => makeSelfTestCode("dm"));
  const [current, setCurrent] = useState<SelfTestEntry | null>(null);
  const [history, setHistory] = useState<SelfTestEntry[]>([]);
  // The scan listener lives as long as the setup screen: it reads the code on screen from refs.
  const shown = useRef({ kind, code });
  shown.current = { kind, code };
  const clock = useRef(now);
  clock.current = now;
  const renewFor = useCallback((next: SelfTestKind) => {
    const fresh = makeSelfTestCode(next);
    shown.current = { kind: next, code: fresh };
    setKindState(next);
    setCode(fresh);
    setCurrent(null);
  }, []);
  const onScan = useCallback((raw: string, channel: ScanChannel) => {
    const { kind: now, code: expected } = shown.current;
    const entry: SelfTestEntry = {
      at: clockTime(clock.current()),
      kind: now,
      verdict: judgeScan(raw, expected, channel),
    };
    setCurrent(entry);
    setHistory((past) => pushHistory(past, entry));
  }, []);
  return {
    kind,
    code,
    current,
    history,
    setKind: renewFor,
    renew: () => renewFor(shown.current.kind),
    onScan,
  };
}

export interface SelfTestPrinter {
  id: string;
  name: string;
}

export type SelfTestPrintResult = "sent" | "failed" | "render_failed";

export interface ScannerSelfTestProps {
  state: ScannerSelfTestState;
  /** The printers a test code can go to; none hides nothing, it explains. */
  printers: readonly SelfTestPrinter[];
  print: (printerId: string, kind: SelfTestKind, code: string) => Promise<SelfTestPrintResult>;
  /** How a file is saved; the webview's download by default. */
  save?: (blob: Blob, name: string) => void;
}

const STATUS_GLYPH = { ok: "✓", warning: "!", problem: "✕" } as const;

function SymbolView({ kind, code, big }: { kind: SelfTestKind; code: string; big?: boolean }) {
  const { t } = useTranslation();
  const svg = symbolSvg(kind, code);
  if (svg === null) return null;
  return (
    <div
      role="img"
      aria-label={t("floor.setup.selfTest.symbolLabel")}
      className={`self-test__symbol self-test__symbol--${kind}${big ? " self-test__symbol--big" : ""}`}
      data-testid={big ? "self-test-symbol-big" : "self-test-symbol"}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** A code in words, the separator as a visible mark. */
function Spelled({ code }: { code: string }) {
  return (
    <code className="self-test__code" data-testid="self-test-code">
      {Array.from(visible(code)).map((symbol, index) =>
        symbol === GS_MARK ? (
          <mark key={index} className="self-test__gs">
            {symbol}
          </mark>
        ) : (
          symbol
        ),
      )}
    </code>
  );
}

function channelLabel(t: TFunction, channel: ScanChannel): string {
  return t(
    channel === "keyboard"
      ? "floor.setup.selfTest.facts.channelKeyboard"
      : channel === "com"
        ? "floor.setup.selfTest.facts.channelCom"
        : "floor.setup.selfTest.facts.channelUnknown",
  );
}

export function reasonText(t: TFunction, verdict: Verdict): string {
  const text = t(`floor.setup.selfTest.reason.${verdict.reason}`, {
    found: verdict.found,
    position: verdict.position,
    expected: verdict.expectedLength,
    count: verdict.count,
    expectedChar: verdict.expectedChar,
    foundChar: verdict.foundChar,
  });
  return verdict.russianLayout && verdict.reason !== "layout"
    ? `${text} ${t("floor.setup.selfTest.layoutHint")}`
    : text;
}

function VerdictView({ verdict }: { verdict: Verdict }) {
  const { t } = useTranslation();
  const typeKey = {
    km: "typeKm",
    sscc: "typeSscc",
    gtin: "typeGtin",
    unknown: "typeUnknown",
    plain: "typeUnknown",
  }[verdict.type];
  return (
    <div
      className="self-test__verdict"
      data-tone={verdict.status}
      data-testid="self-test-verdict"
      role="status"
    >
      <p className="self-test__status">
        <span aria-hidden="true">{STATUS_GLYPH[verdict.status]}</span>{" "}
        {t(`floor.setup.selfTest.status.${verdict.status}`)}
      </p>
      <p className="self-test__reason" data-testid="self-test-reason">
        {reasonText(t, verdict)}
      </p>
      <dl className="self-test__facts">
        <dt>{t("floor.setup.selfTest.facts.channel")}</dt>
        <dd>{channelLabel(t, verdict.channel)}</dd>
        <dt>{t("floor.setup.selfTest.facts.length")}</dt>
        <dd>
          {t("floor.setup.selfTest.facts.lengthValue", {
            length: verdict.length,
            expected: verdict.expectedLength,
          })}
        </dd>
        {verdict.expectedGroupSeparators > 0 && (
          <>
            <dt>{t("floor.setup.selfTest.facts.groups")}</dt>
            <dd>
              {t("floor.setup.selfTest.facts.groupsValue", {
                found: verdict.groupSeparators,
                expected: verdict.expectedGroupSeparators,
              })}
            </dd>
          </>
        )}
        <dt>{t("floor.setup.selfTest.facts.type")}</dt>
        <dd>{t(`floor.setup.selfTest.facts.${typeKey}`)}</dd>
        {verdict.structure.length > 0 && (
          <>
            <dt>{t("floor.setup.selfTest.facts.structure")}</dt>
            <dd data-testid="self-test-structure">
              {verdict.structure
                .map((item) =>
                  item.checkDigitValid === undefined
                    ? t("floor.setup.selfTest.facts.structureItem", {
                        ai: item.ai,
                        length: item.length,
                      })
                    : t(
                        item.checkDigitValid
                          ? "floor.setup.selfTest.facts.structureGtinOk"
                          : "floor.setup.selfTest.facts.structureGtinBad",
                      ),
                )
                .join("; ")}
            </dd>
          </>
        )}
        <dt>{t("floor.setup.selfTest.facts.scan")}</dt>
        <dd>
          <code className="self-test__code" data-testid="self-test-masked">
            {verdict.masked}
          </code>
        </dd>
      </dl>
    </div>
  );
}

/**
 * «Проверить сканер» (owner feedback, beta 3): the station shows a test code, the operator scans it,
 * and the verdict says whether it arrived as it was made, and if not, what is wrong and what to set
 * on the scanner. The code is fake (a GTIN of the range no manufacturer owns, «ТЕСТ» on every form)
 * and exists only on this screen: the floor's scan pipeline is not listening here and would refuse
 * its GTIN anyway.
 */
export function ScannerSelfTest({
  state,
  printers,
  print,
  save = downloadFile,
}: ScannerSelfTestProps) {
  const { t } = useTranslation();
  const { kind, code, current, history } = state;
  const [open, setOpen] = useState(false);
  const [printerId, setPrinterId] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const chosen = printers.find((printer) => printer.id === printerId) ?? printers[0] ?? null;

  const saveAs = async (format: "png" | "pdf") => {
    setNote(null);
    const blob = format === "png" ? await symbolPng(kind, code) : symbolPdf(kind, code);
    if (blob === null) {
      setNote(t("floor.setup.selfTest.saveFailed"));
      return;
    }
    save(blob, `markiro-test-${kind === "dm" ? "datamatrix" : "code128"}.${format}`);
    setNote(t("floor.setup.selfTest.saved"));
  };

  const printNow = async () => {
    if (chosen === null) return;
    setNote(null);
    const result = await print(chosen.id, kind, code);
    setNote(
      t(
        result === "sent"
          ? "floor.setup.selfTest.printSent"
          : result === "failed"
            ? "floor.setup.selfTest.printFailed"
            : "floor.setup.selfTest.printRenderFailed",
      ),
    );
  };

  return (
    <section
      className="setup-card self-test"
      aria-labelledby="self-test-title"
      data-testid="scanner-self-test"
    >
      <h2 id="self-test-title" className="setup-card__title">
        {t("floor.setup.selfTest.title")}
      </h2>
      <p className="setup-card__hint">{t("floor.setup.selfTest.hint")}</p>
      <div className="self-test__body">
        <div className="self-test__code-side">
          <div
            className="self-test__kinds"
            role="group"
            aria-label={t("floor.setup.selfTest.kindLabel")}
          >
            {(["plain", "dm"] as const).map((value) => (
              <Button
                key={value}
                size="floor"
                variant="secondary"
                aria-pressed={kind === value}
                className="self-test__kind"
                data-checked={kind === value ? "true" : undefined}
                onClick={() => {
                  if (kind !== value) state.setKind(value);
                }}
              >
                {t(
                  value === "dm" ? "floor.setup.selfTest.kindDm" : "floor.setup.selfTest.kindPlain",
                )}
              </Button>
            ))}
          </div>
          <div className="self-test__figure">
            <span className="self-test__badge">{t("floor.setup.selfTest.badge")}</span>
            <SymbolView kind={kind} code={code} />
          </div>
          <p className="self-test__expected">
            {t("floor.setup.selfTest.expected")} <Spelled code={code} />
          </p>
          {kind === "dm" && (
            <p className="self-test__expected" data-testid="self-test-expected-structure">
              {t("floor.setup.selfTest.expectedStructure")}{" "}
              {expectedStructure(code)
                .map((item) => `AI ${item.ai} ${item.value}`)
                .join(` ${GS_MARK} `)}
            </p>
          )}
          <p className="setup-card__hint">{t("floor.setup.selfTest.notProduct")}</p>
          <div className="self-test__actions">
            <Button size="floor" variant="secondary" onClick={() => setOpen(true)}>
              {t("floor.setup.selfTest.show")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => void saveAs("png")}>
              {t("floor.setup.selfTest.savePng")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => void saveAs("pdf")}>
              {t("floor.setup.selfTest.savePdf")}
            </Button>
            {printers.length > 1 && (
              <Select
                custom
                size="floor"
                label={t("floor.setup.selfTest.printer")}
                value={chosen?.id ?? ""}
                options={printers.map((printer) => ({ value: printer.id, label: printer.name }))}
                onValueChange={setPrinterId}
              />
            )}
            <Button
              size="floor"
              variant="secondary"
              disabled={chosen === null}
              onClick={() => void printNow()}
            >
              {printers.length === 1 && chosen !== null
                ? t("floor.setup.selfTest.printOn", { name: chosen.name })
                : t("floor.setup.selfTest.print")}
            </Button>
            <Button size="floor" variant="secondary" onClick={state.renew}>
              {t("floor.setup.selfTest.newCode")}
            </Button>
          </div>
          {chosen === null && (
            <p className="setup-card__hint">{t("floor.setup.selfTest.noPrinter")}</p>
          )}
          <p className="setup-card__hint" aria-live="polite" data-testid="self-test-note">
            {note}
          </p>
        </div>
        <div className="self-test__result-side">
          {current === null ? (
            <p className="setup-card__waiting" data-testid="self-test-waiting">
              {t("floor.setup.selfTest.waiting")}
            </p>
          ) : (
            <VerdictView verdict={current.verdict} />
          )}
          <h3 className="self-test__history-title">{t("floor.setup.selfTest.history.title")}</h3>
          {history.length === 0 ? (
            <p className="setup-card__hint">{t("floor.setup.selfTest.history.empty")}</p>
          ) : (
            <ol className="self-test__history" data-testid="self-test-history">
              {history.map((entry, index) => (
                <li key={`${entry.at}-${index}`} data-tone={entry.verdict.status}>
                  {t("floor.setup.selfTest.history.row", {
                    at: entry.at,
                    status: t(`floor.setup.selfTest.status.${entry.verdict.status}`),
                    channel: channelLabel(t, entry.verdict.channel),
                    masked: entry.verdict.masked,
                  })}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      <FullScreenDialog
        open={open}
        title={t("floor.setup.selfTest.shownTitle")}
        backLabel={t("floor.setup.selfTest.closeShown")}
        backPlacement="footer"
        initialFocus="dialog"
        className="self-test__window"
        onClose={() => setOpen(false)}
      >
        <div className="self-test__shown">
          <span className="self-test__badge">{t("floor.setup.selfTest.badge")}</span>
          <SymbolView kind={kind} code={code} big />
          {current !== null && (
            <p className="self-test__shown-status" data-tone={current.verdict.status} role="status">
              {t(`floor.setup.selfTest.status.${current.verdict.status}`)}:{" "}
              {reasonText(t, current.verdict)}
            </p>
          )}
        </div>
      </FullScreenDialog>
    </section>
  );
}
