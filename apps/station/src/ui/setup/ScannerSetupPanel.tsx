import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "@markiro/ui";
import { TestBarcode } from "./TestBarcode.js";
import type { SetupCheckResult } from "./test-code.js";

export interface ScannerSetupPanelProps {
  ports: readonly string[];
  port: string;
  storedPort: string;
  baud: string;
  disabled: boolean;
  busy: boolean;
  /** The code currently on screen for the operator to scan off the monitor. */
  testCode: string;
  /** The last scan's verdict against `testCode`, or null while nothing was scanned. */
  check: SetupCheckResult | null;
  onPortChange: (port: string) => void;
  onBaudChange: (baud: string) => void;
  onConnect: () => void;
  onNewCode: () => void;
}

export function ScannerSetupPanel({
  ports,
  port,
  storedPort,
  baud,
  disabled,
  busy,
  testCode,
  check,
  onPortChange,
  onBaudChange,
  onConnect,
  onNewCode,
}: ScannerSetupPanelProps) {
  const { t } = useTranslation();
  const choices = [
    { value: "", label: t("setup.noScanner") },
    ...(storedPort !== "" && !ports.includes(storedPort)
      ? [{ value: storedPort, label: t("setup.portNotDetected", { port: storedPort }) }]
      : []),
    ...ports.map((value) => ({ value, label: value })),
  ];

  return (
    <div className="setup-split">
      <section className="setup-card" aria-label={t("setup.connectionTitle")}>
        <h2 className="setup-card__title">{t("setup.connectionTitle")}</h2>
        <Select
          size="floor"
          label={t("setup.port")}
          value={port}
          options={choices}
          disabled={disabled}
          onValueChange={onPortChange}
        />
        <Input
          size="floor"
          mono
          label={t("setup.baud")}
          inputMode="numeric"
          value={baud}
          disabled={disabled}
          onChange={(event) => onBaudChange(event.target.value)}
        />
        <Button size="floor" disabled={busy || disabled || port.length === 0} onClick={onConnect}>
          {t("setup.openScanner")}
        </Button>
      </section>

      <section
        className="setup-card setup-card--check"
        aria-label={t("setup.scannerCheckTitle")}
        data-testid="scanner-check"
      >
        <h2 className="setup-card__title">{t("setup.scannerCheckTitle")}</h2>
        <p className="setup-card__hint">{t("setup.scannerCheckHint")}</p>
        <TestBarcode code={testCode} label={t("setup.scannerCheckTitle")} />
        <code className="setup-card__code" data-testid="scanner-test-code">
          {testCode}
        </code>
        {check ? (
          <div
            className="setup-verdict"
            data-tone={check.ok ? "ok" : "error"}
            data-testid="scanner-check-result"
            role="status"
          >
            <span aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
            {check.ok
              ? t("setup.scannerCheckOk")
              : t("setup.scannerCheckMismatch", { received: check.received })}
          </div>
        ) : (
          <p className="setup-card__waiting">{t("setup.scannerCheckWaiting")}</p>
        )}
        <Button size="floor" variant="secondary" disabled={busy} onClick={onNewCode}>
          {t("setup.newCode")}
        </Button>
      </section>
    </div>
  );
}
