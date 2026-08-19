import { useTranslation } from "react-i18next";
import { Button, Input } from "@markiro/ui";
import type { PrintTarget, UsbPrinterInfo } from "../../lib/hardware.js";
import type { PrinterLanguage } from "../../lib/hardware-config.js";

type PrinterTransport = PrintTarget["kind"] | "none";

export interface PrinterSetupPanelProps {
  transport: PrinterTransport;
  host: string;
  tcpPort: string;
  serialPort: string;
  serialBaud: string;
  usbPrinters: readonly UsbPrinterInfo[];
  usbPrinter: string;
  language: PrinterLanguage;
  verifyPrintedLabel: boolean;
  disabled: boolean;
  busy: boolean;
  onTransportChange: (transport: PrinterTransport) => void;
  onHostChange: (host: string) => void;
  onTcpPortChange: (port: string) => void;
  onSerialPortChange: (port: string) => void;
  onSerialBaudChange: (baud: string) => void;
  onUsbPrinterChange: (name: string) => void;
  onUsbRefresh: () => void;
  onLanguageChange: (language: PrinterLanguage) => void;
  onVerifyPrintedLabelChange: (verify: boolean) => void;
  onTestPrint: () => void;
}

export function PrinterSetupPanel({
  transport,
  host,
  tcpPort,
  serialPort,
  serialBaud,
  usbPrinters,
  usbPrinter,
  language,
  verifyPrintedLabel,
  disabled,
  busy,
  onTransportChange,
  onHostChange,
  onTcpPortChange,
  onSerialPortChange,
  onSerialBaudChange,
  onUsbPrinterChange,
  onUsbRefresh,
  onLanguageChange,
  onVerifyPrintedLabelChange,
  onTestPrint,
}: PrinterSetupPanelProps) {
  const { t } = useTranslation();
  const transportChoices: { value: PrinterTransport; label: string }[] = [
    { value: "none", label: t("setup.transportNone") },
    { value: "tcp", label: t("setup.transportTcp") },
    { value: "serial", label: t("setup.transportSerial") },
    { value: "usb", label: t("setup.transportUsb") },
  ];

  const usbChoices = [
    ...(usbPrinter !== "" && !usbPrinters.some((p) => p.name === usbPrinter)
      ? [{ value: usbPrinter, label: t("setup.usbMissingSaved", { name: usbPrinter }) }]
      : []),
    ...usbPrinters.map((p) => ({ value: p.name, label: `${p.name} · ${p.port}` })),
  ];

  return (
    <div className="setup-panel setup-panel--printer">
      <fieldset className="setup-choice-group">
        <legend>{t("setup.printerTransport")}</legend>
        <div className="setup-choice-group__options">
          {transportChoices.map((choice) => (
            <label className="setup-touch-choice" key={choice.value}>
              <input
                type="radio"
                name="printer-transport"
                checked={transport === choice.value}
                disabled={disabled}
                onChange={() => onTransportChange(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="setup-panel__fields">
        {transport === "tcp" ? (
          <>
            <Input
              size="floor"
              label={t("setup.host")}
              value={host}
              disabled={disabled}
              onChange={(event) => onHostChange(event.target.value)}
            />
            <Input
              size="floor"
              mono
              inputMode="numeric"
              label={t("setup.printerTcpPort")}
              value={tcpPort}
              disabled={disabled}
              onChange={(event) => onTcpPortChange(event.target.value)}
            />
          </>
        ) : transport === "serial" ? (
          <>
            <Input
              size="floor"
              label={t("setup.printerPort")}
              value={serialPort}
              disabled={disabled}
              onChange={(event) => onSerialPortChange(event.target.value)}
            />
            <Input
              size="floor"
              mono
              inputMode="numeric"
              label={t("setup.printerBaud")}
              value={serialBaud}
              disabled={disabled}
              onChange={(event) => onSerialBaudChange(event.target.value)}
            />
          </>
        ) : transport === "usb" ? (
          <>
            {usbChoices.length > 0 ? (
              <fieldset className="setup-choice-group">
                <legend>{t("setup.usbPrinterList")}</legend>
                <div className="setup-choice-group__options">
                  {usbChoices.map((choice) => (
                    <label className="setup-touch-choice" key={choice.value}>
                      <input
                        type="radio"
                        name="usb-printer"
                        checked={usbPrinter === choice.value}
                        disabled={disabled}
                        onChange={() => onUsbPrinterChange(choice.value)}
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="setup-panel__empty">{t("setup.usbNotFound")}</p>
            )}
            <Button
              size="floor"
              variant="secondary"
              disabled={disabled || busy}
              onClick={onUsbRefresh}
            >
              {t("setup.usbRefresh")}
            </Button>
          </>
        ) : (
          <p className="setup-panel__empty">{t("setup.noPrinterHint")}</p>
        )}
      </div>

      <fieldset className="setup-choice-group">
        <legend>{t("setup.printerLanguage")}</legend>
        <div className="setup-choice-group__options setup-choice-group__options--compact">
          {(["zpl", "tspl"] as const).map((value) => (
            <label className="setup-touch-choice" key={value}>
              <input
                type="radio"
                name="printer-language"
                checked={language === value}
                disabled={disabled}
                onChange={() => onLanguageChange(value)}
              />
              <span>{value === "zpl" ? t("setup.languageZpl") : t("setup.languageTspl")}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="setup-panel__printer-actions">
        <label className="setup-touch-choice setup-touch-choice--checkbox">
          <input
            type="checkbox"
            checked={transport === "none" ? false : verifyPrintedLabel}
            disabled={disabled || transport === "none"}
            onChange={(event) => onVerifyPrintedLabelChange(event.target.checked)}
          />
          <span>{t("setup.verifyPrintedLabel")}</span>
        </label>
        <Button
          size="floor"
          disabled={
            busy ||
            disabled ||
            transport === "none" ||
            (transport === "tcp"
              ? host.length === 0
              : transport === "serial"
                ? serialPort.length === 0
                : usbPrinter.length === 0)
          }
          onClick={onTestPrint}
        >
          {t("setup.testPrint")}
        </Button>
      </div>
    </div>
  );
}
