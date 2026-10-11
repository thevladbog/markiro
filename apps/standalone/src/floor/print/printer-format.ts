import type { TFunction } from "i18next";

import { printerMode, type PrinterProfile } from "../setup/workstation-settings.js";

/**
 * How a printer's labels are made, for the screens' `{{language}}`: «ZPL»,
 * «TSPL», or «Драйвер Windows» for a profile in driver mode (plan ДРВ).
 */
export function printerFormatText(
  t: TFunction,
  printer: Pick<PrinterProfile, "language" | "mode">,
): string {
  return printerMode(printer) === "windows_driver"
    ? t("floor.setup.printers.formats.windowsDriver")
    : printer.language.toUpperCase();
}
