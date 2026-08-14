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
    counters: {
      accepted: t("work.accepted"),
      rejected: t("work.rejected"),
      synchronized: t("work.synchronized"),
      pending: (count: number) => t("work.pendingSync", { count }),
    },
    recent: {
      title: t("work.recentOperations"),
      empty: t("work.noRecentOperations"),
      invalidTime: t("work.timeUnknown"),
    },
    footer: {
      exceptions: t("work.exceptions"),
      exit: t("work.pauseFinish"),
    },
    summary: t("work.summary"),
    locale: language.startsWith("ru") ? "ru-RU" : "en-US",
  };
}
