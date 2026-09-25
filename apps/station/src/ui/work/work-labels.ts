import type { TFunction } from "i18next";

export function buildWorkLabels(t: TFunction, language: string, boxNumber: number | null) {
  return {
    status: {
      waiting: t("work.waiting"),
      ok: t("signal.ok"),
      duplicate: t("signal.duplicate"),
      invalid: t("signal.wrongCode"),
      wrong_gtin: t("signal.wrongGtin"),
      unknown: t("work.rejected"),
      gtin: t("work.gtin"),
      serial: t("work.serial"),
      crypto: t("work.crypto"),
    },
    box: {
      title: t("work.openBox"),
      number: t("work.boxNumber", { number: boxNumber }),
      absent: t("work.noOpenBox"),
      count: t("work.boxItems"),
      capacityUnknown: t("work.capacityUnknown"),
      grouped: t("work.boxGrouped"),
      close: t("box.close"),
      undo: t("box.undoLastScan"),
      clear: t("box.clear"),
    },
    band: {
      gtin: t("work.gtin"),
      counterpartyPrefix: t("shifts.forCounterparty"),
      totalAll: t("work.shiftTotalAll"),
      totalTerminal: t("work.shiftTotalTerminal"),
      planPercent: (percent: string) => t("work.planPercent", { percent }),
      terminalShare: (value: string) => t("work.terminalShare", { value }),
      othersAsOf: (time: string) => t("work.othersAsOf", { time }),
    },
    recent: {
      title: t("work.journal"),
      empty: t("work.noRecentOperations"),
      invalidTime: t("work.timeUnknown"),
      errors: t("work.errors"),
      duplicates: t("work.duplicates"),
    },
    footer: {
      exceptions: t("work.exceptions"),
      pause: t("work.pause"),
      close: t("work.closeShift"),
    },
    summary: t("work.summary"),
    locale: language.startsWith("ru") ? "ru-RU" : "en-US",
  };
}
