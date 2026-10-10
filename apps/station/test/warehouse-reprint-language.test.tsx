import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { PrinterSetupPanel } from "../src/ui/setup/PrinterSetupPanel.js";

it.each(["ru", "en"])("labels the saved tspl language TSPL in %s", async (locale) => {
  await i18n.changeLanguage(locale);
  const noop = () => {};
  const view = render(
    <PrinterSetupPanel
      name="TSC 210"
      printedCode={null}
      check={null}
      transport="tcp"
      host="127.0.0.1"
      tcpPort="9100"
      serialPort=""
      serialBaud="9600"
      usbPrinters={[]}
      usbPrinter=""
      language="tspl"
      printerDpi={203}
      disabled={false}
      busy={false}
      onTransportChange={noop}
      onHostChange={noop}
      onTcpPortChange={noop}
      onSerialPortChange={noop}
      onSerialBaudChange={noop}
      onUsbPrinterChange={noop}
      onUsbRefresh={noop}
      onLanguageChange={noop}
      onTestPrint={noop}
    />,
  );
  try {
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "TSPL" }).checked).toBe(true);
    expect(screen.getByDisplayValue("TSC 210")).toBeDefined();
  } finally {
    view.unmount();
    await i18n.changeLanguage("en");
  }
});
