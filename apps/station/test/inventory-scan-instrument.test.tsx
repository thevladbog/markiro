// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RecordInventoryScanResult } from "../src/lib/inventory-journal.js";

import i18n from "../src/i18n/index.js";
import {
  InventoryScanInstrument,
  type InventoryScanInstrumentLabels,
} from "../src/ui/inventory/InventoryScanInstrument.js";

const repositoryRoot = existsSync(resolve(process.cwd(), "apps/station/src/station.css"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const stationCss = readFileSync(resolve(repositoryRoot, "apps/station/src/station.css"), "utf8");

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

describe("alert badge geometry (finding 6, final review)", () => {
  const protectedResult: RecordInventoryScanResult = {
    verdict: "protected",
    scanKind: "item",
    serialSuffix: "…0042",
    ssccSuffix: null,
    claimedCount: 0,
    boxChildCount: 0,
    firstWinning: null,
  };

  /**
   * `#root .mk-alert .mk-badge` used to carry `word-spacing: -0.35ch` to
   * compress `IBM Plex Mono`'s full-cell space. `Badge` now defaults to
   * `var(--font-ui)` (sans), so that negative word-spacing would instead eat
   * most of the gap between words in a two-word label like "НЕ УЧТЁН" --
   * this is the exact scan-instrument badge the spec's geometry section
   * calls out. The rule itself, not just the source text, must not carry
   * `word-spacing` any more.
   */
  it("does not carry a word-spacing override on the alert badge rule", () => {
    const rule = /#root \.mk-alert \.mk-badge\s*\{([^}]*)\}/.exec(stationCss)?.[1];
    expect(rule).toBeDefined();
    expect(rule).not.toContain("word-spacing");
  });

  it("renders the two-word protected badge without a compressed word gap", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = stationCss;
    document.head.append(stylesheet);

    render(
      <div id="root">
        <InventoryScanInstrument
          result={protectedResult}
          writeFailed={false}
          currentDeviceId="terminal-a"
          labels={labels}
        />
      </div>,
    );

    const badge = screen.getByText("НЕ УЧТЁН");
    expect(badge.closest(".mk-alert")).not.toBeNull();
    expect(getComputedStyle(badge).wordSpacing).not.toBe("-0.35ch");

    stylesheet.remove();
  });
});
