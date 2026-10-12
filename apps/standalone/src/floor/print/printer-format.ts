import type { TFunction } from "i18next";

import { printerMode, type PrinterProfile } from "../setup/workstation-settings.js";

/**
 * How a printer's labels are made, for the screens' `{{language}}`: «ZPL»,
 * «TSPL», «Драйвер Windows» for a profile in driver mode (plan ДРВ), or
 * «Лист А4» for a printer of A4 sheets (plan А4).
 */
export function printerFormatText(
  t: TFunction,
  printer: Pick<PrinterProfile, "language" | "mode" | "paper">,
): string {
  if (printer.paper === "a4") return t("floor.setup.printers.formats.a4");
  return printerMode(printer) === "windows_driver"
    ? t("floor.setup.printers.formats.windowsDriver")
    : printer.language.toUpperCase();
}
