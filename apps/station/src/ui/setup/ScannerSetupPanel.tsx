import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "@markiro/ui";
import type { ScannerConnection } from "../../lib/hardware.js";
import { canonicalScannerPort } from "../../lib/hardware-config.js";
import { TestBarcode } from "./TestBarcode.js";
import type { SetupCheckResult } from "./test-code.js";

export interface AdditionalScannerRow {
  id: string;
  port: string;
  storedPort: string;
  baud: string;
}

export interface ScannerSetupPanelProps {
  ports: readonly string[];
  port: string;
  storedPort: string;
  baud: string;
  additionalScanners: readonly AdditionalScannerRow[];
  connections: readonly ScannerConnection[];
  onAddScanner: () => void;
  onRemoveScanner: (id: string) => void;
  onAdditionalScannerChange: (
    id: string,
    patch: Partial<Pick<AdditionalScannerRow, "port" | "baud">>,
  ) => void;
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
  additionalScanners,
  connections,
  onAddScanner,
  onRemoveScanner,
  onAdditionalScannerChange,
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
  const choicesFor = (savedPort: string, selectedPort: string) => [
    { value: "", label: t("setup.noScanner") },
    ...[...new Set([savedPort, selectedPort])]
      .filter((value) => value !== "" && !ports.includes(value))
      .map((value) => ({ value, label: t("setup.portNotDetected", { port: value }) })),
    ...ports.map((value) => ({ value, label: value })),
  ];
  const connectionLabel = (selectedPort: string, selectedBaud: string) => {
    const connection = connections.find(
      (item) =>
        item.port === canonicalScannerPort(selectedPort) && item.baud === Number(selectedBaud),
    );
    return connection
      ? t(connection.status === "connected" ? "shell.connected" : "setup.scannerReconnecting")
      : t("setup.scannerWaiting");
  };

  return (
    <div className="setup-split setup-split--scanners">
      <section
        className="setup-card setup-card--scanner-config"
        aria-label={t("setup.connectionTitle")}
      >
        <h2 className="setup-card__title">{t("setup.connectionTitle")}</h2>
        <Select
          size="floor"
          label={t("setup.port")}
          value={port}
          options={choicesFor(storedPort, port)}
          disabled={disabled || busy}
          onValueChange={onPortChange}
        />
        <Input
          size="floor"
          mono
          label={t("setup.baud")}
          inputMode="numeric"
          value={baud}
          disabled={disabled || busy}
          onChange={(event) => onBaudChange(event.target.value)}
        />
        {port ? (
          <p
            className="setup-card__hint"
            role="status"
            aria-label={t("setup.scannerPortStatus", { port })}
          >
            {connectionLabel(port, baud)}
          </p>
        ) : null}
        {additionalScanners.map((scanner, index) => (
          <fieldset className="setup-scanner-row" key={scanner.id}>
            <legend>{t("setup.scannerNumber", { number: index + 2 })}</legend>
            <Select
              size="floor"
              label={t("setup.scannerPortNumber", { number: index + 2 })}
              value={scanner.port}
              options={choicesFor(scanner.storedPort, scanner.port)}
              disabled={disabled || busy}
              onValueChange={(value) => onAdditionalScannerChange(scanner.id, { port: value })}
            />
            <Input
              size="floor"
              mono
              label={t("setup.scannerBaudNumber", { number: index + 2 })}
              inputMode="numeric"
              value={scanner.baud}
              disabled={disabled || busy}
              onChange={(event) =>
                onAdditionalScannerChange(scanner.id, { baud: event.target.value })
              }
            />
            {scanner.port ? (
              <p
                className="setup-card__hint"
                role="status"
                aria-label={t("setup.scannerPortStatus", { port: scanner.port })}
              >
                {connectionLabel(scanner.port, scanner.baud)}
              </p>
            ) : null}
            <Button
              size="floor"
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => onRemoveScanner(scanner.id)}
            >
              {t("setup.removeScanner", { number: index + 2 })}
            </Button>
          </fieldset>
        ))}
        <Button size="floor" variant="secondary" disabled={busy || disabled} onClick={onAddScanner}>
          {t("setup.addScanner")}
        </Button>
        <p className="setup-card__hint">{t("setup.multipleScannersHint")}</p>
        <Button
          size="floor"
          disabled={
            busy || disabled || !(port || additionalScanners.some((scanner) => scanner.port))
          }
          onClick={onConnect}
        >
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
