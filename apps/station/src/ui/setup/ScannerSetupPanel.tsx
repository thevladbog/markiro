import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "@markiro/ui";

export interface ScannerSetupPanelProps {
  ports: readonly string[];
  port: string;
  storedPort: string;
  baud: string;
  disabled: boolean;
  busy: boolean;
  onPortChange: (port: string) => void;
  onBaudChange: (baud: string) => void;
  onConnect: () => void;
}

export function ScannerSetupPanel({
  ports,
  port,
  storedPort,
  baud,
  disabled,
  busy,
  onPortChange,
  onBaudChange,
  onConnect,
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
    <div className="setup-panel setup-panel--scanner">
      <Select
        size="floor"
        label={t("setup.port")}
        value={port}
        options={choices}
        disabled={disabled}
        onChange={onPortChange}
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
    </div>
  );
}
