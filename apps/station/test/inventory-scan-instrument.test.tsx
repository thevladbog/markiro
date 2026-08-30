// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RecordInventoryScanResult } from "../src/lib/inventory-journal.js";

import i18n from "../src/i18n/index.js";
import {
  InventoryScanInstrument,
  type InventoryScanInstrumentLabels,
} from "../src/ui/inventory/InventoryScanInstrument.js";

afterEach(() => {
  cleanup();
  void i18n.changeLanguage("ru");
});

const labels: InventoryScanInstrumentLabels = {
  prompt: "Сканируйте бутылку или короб",
  hint: "Короб отметит проверенным всё известное содержимое",
  expected: "Код принят",
  protected: "Код не учтён: уже в отгрузке",
  ineligible: "Код не участвует в инвентаризации",
  unknown: "Код отсутствует в исходном снимке",
  duplicateHere: "Код уже проверен на этом терминале",
  duplicateOther: "Код уже проверен на другом терминале",
  terminalHere: "Этот терминал",
  terminalOther: "Другой терминал",
  invalid: "Код не распознан",
  writeFailed: "Не удалось записать скан",
  boxAccepted: (count) => `Короб принят: ${count} кодов`,
  boxBadge: "КОРОБ",
  duplicateBadge: "ДУБЛЬ",
  protectedBadge: "НЕ УЧТЁН",
  discrepancyBadge: "РАСХОЖДЕНИЕ",
  ineligibleBadge: "НЕ УЧАСТВУЕТ",
};

const SCANNED_AT = "2026-08-19T13:00:00.000Z";

const duplicateOtherTerminal: RecordInventoryScanResult = {
  verdict: "duplicate",
  scanKind: "item",
  serialSuffix: "…0019",
  ssccSuffix: null,
  claimedCount: 0,
  boxChildCount: 0,
  firstWinning: {
    codeHash: "test-safe-code-hash",
    eventId: "test-winning-event",
    deviceId: "terminal-b",
    scannedAt: SCANNED_AT,
  },
};

// Computed the same way InventoryScanInstrument.tsx derives its locale, so
// the assertions hold regardless of the CI machine's own timezone -- only
// the *locale-driven* clock format (24-hour vs. 12-hour with AM/PM) is under
// test here, not a specific wall-clock hour.
const ruTime = new Intl.DateTimeFormat("ru-RU", { timeStyle: "medium" }).format(
  new Date(SCANNED_AT),
);
const enTime = new Intl.DateTimeFormat("en-US", { timeStyle: "medium" }).format(
  new Date(SCANNED_AT),
);

describe("InventoryScanInstrument duplicate-verdict timestamp", () => {
  it("formats the other-terminal duplicate timestamp in 24-hour RU format under the ru locale", async () => {
    await i18n.changeLanguage("ru");

    render(
      <InventoryScanInstrument
        result={duplicateOtherTerminal}
        writeFailed={false}
        currentDeviceId="terminal-a"
        labels={labels}
      />,
    );

    const alert = await screen.findByText("Код уже проверен на другом терминале");
    const detail = alert.closest(".mk-alert")?.textContent ?? "";
    expect(detail).toContain("Другой терминал");
    expect(detail).not.toContain("terminal-b");
    expect(detail).toContain(ruTime);
    expect(detail).not.toMatch(/AM|PM/i);
  });

  it("formats the same timestamp in 12-hour EN format under the en locale (regression guard)", async () => {
    await i18n.changeLanguage("en");

    render(
      <InventoryScanInstrument
        result={duplicateOtherTerminal}
        writeFailed={false}
        currentDeviceId="terminal-a"
        labels={labels}
      />,
    );

    const alert = await screen.findByText("Код уже проверен на другом терминале");
    const detail = alert.closest(".mk-alert")?.textContent ?? "";
    expect(detail).toContain("Другой терминал");
    expect(detail).not.toContain("terminal-b");
    expect(detail).toContain(enTime);
    expect(detail).toMatch(/AM|PM/i);
  });
});
