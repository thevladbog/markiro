import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  licensePreviewSchema,
  MAX_LICENSE_FILE_BYTES,
  type LicensePreview,
  type LicenseTerms,
} from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  comparisonRows,
  loadedMessage,
  loadFailureText,
  overLimits,
  previewWarnings,
  readLicenseFile,
} from "../src/office/info/license/license-load.js";
import type { LicenseText } from "../src/office/info/license/license-view.js";
import { ACTIVE_LICENSE, licenseOf, OTHER_INN } from "./support/license.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const MSK = "Europe/Moscow";
/** ЛЦ-2's preview: the trial before, a subscription after with more stations used than it gives. */
const FIRST_FILE: LicensePreview = licensePreviewSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-license-preview.json", testModuleUrl), "utf8"),
  ),
);

function said(text: LicenseText): string {
  return i18n.t(text.key, text.values ?? {});
}

function fileRefusal(details: Record<string, unknown>): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "refused",
    details: { field: "file", ...details },
  });
}

describe("reading a license file", () => {
  it("takes the text up to the host's bound, trimmed, and refuses a larger file unread", async () => {
    await expect(
      readLicenseFile(new File(["  aGVhZA.cGF5.c2ln \r\n"], "site.mklic")),
    ).resolves.toEqual({ kind: "text", text: "aGVhZA.cGF5.c2ln" });
    await expect(
      readLicenseFile(new File(["a".repeat(MAX_LICENSE_FILE_BYTES)], "site.mklic")),
    ).resolves.toMatchObject({ kind: "text" });
    await expect(
      readLicenseFile(new File(["a".repeat(MAX_LICENSE_FILE_BYTES + 1)], "site.mklic")),
    ).resolves.toEqual({ kind: "too_large" });
  });
});

describe("a refused license file in words (spec §9.7)", () => {
  it.each([
    ["license_malformed", {}, "Это не файл лицензии Маркиро или файл повреждён."],
    [
      "license_unknown_key",
      {},
      "Файл подписан ключом, который эта версия не знает. Обновите программу или запросите файл заново.",
    ],
    [
      "license_signature",
      {},
      "Подпись файла не сходится: файл изменён после выпуска. Запросите файл заново.",
    ],
    [
      "license_wrong_host",
      { fileHostId: "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f" },
      "Файл выдан для другого хоста (9b2e4f60…). Этот хост: 3f1c2d4e… Отправьте запрос на активацию с этого ПК.",
    ],
    [
      "license_older",
      {},
      "У площадки уже есть более новый файл лицензии (№ 3). Этот файл не нужен.",
    ],
    [
      "license_inn_mismatch",
      {},
      "ИНН в файле лицензии не совпадает с ИНН организации в программе (7707083893). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
    ],
    [
      "license_inn_mismatch",
      { fileInn: OTHER_INN },
      "ИНН в файле лицензии (7802000015) не совпадает с ИНН организации в программе (7707083893). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
    ],
    [
      "license_inn_missing",
      {},
      "Укажите ИНН организации в «Профиле организации»: лицензия выдаётся на ИНН.",
    ],
    ["from_a_newer_host", {}, "Это не файл лицензии Маркиро или файл повреждён."],
  ] as const)("says %s", (reason, details, text) => {
    expect(said(loadFailureText(fileRefusal({ reason, ...details }), ACTIVE_LICENSE))).toBe(text);
  });

  it("explains anything else by its code, never as a bad file", () => {
    const limited = new HostError({ kind: "api", code: "rate_limited", status: 429, message: "x" });
    expect(loadFailureText(limited, ACTIVE_LICENSE)).toEqual({ key: "errors.api.rate_limited" });
    const transport = new HostError({ kind: "transport", code: "unreachable", message: "x" });
    expect(loadFailureText(transport, ACTIVE_LICENSE)).toEqual({
      key: "errors.transport.unreachable",
    });
    const otherField = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "x",
      details: { field: "body" },
    });
    expect(loadFailureText(otherField, ACTIVE_LICENSE)).toEqual({
      key: "errors.api.validation_failed",
    });
  });
});

describe("«было → станет»", () => {
  it("lists the plan, the term, the grace, the seats and the features, marked by the host's changes", () => {
    const rows = comparisonRows(FIRST_FILE, MSK);
    expect(rows.map((row) => row.id)).toEqual([
      "plan",
      "validUntil",
      "graceDays",
      "quotas.stations",
      "quotas.cabinetUsers",
      "quotas.lines",
      "features.labelEditor",
      "features.publicApi",
      "features.pallets",
      "features.chzIntegration",
      "features.inventory",
      "features.commerceMl",
      "features.handheld",
    ]);
    expect(rows.filter((row) => row.changed).map((row) => row.id)).toEqual(
      rows.map((row) => row.id).filter((id) => FIRST_FILE.changes.includes(id)),
    );
    const words = Object.fromEntries(
      rows.map((row) => [row.id, [said(row.before), said(row.after)]]),
    );
    expect(words["plan"]).toEqual(["Пробный период", "Подписка"]);
    // The trial ends at a moment, not at midnight: its time is written; a file's last day is not.
    expect(words["validUntil"]).toEqual(["20.10 10:00", "20.10.2027"]);
    expect(words["quotas.stations"]).toEqual(["без ограничения", "3"]);
    expect(words["features.publicApi"]).toEqual(["включено", "выключено"]);
  });

  it("names the seats the file would leave over their limit, as the host counted them", () => {
    expect(overLimits(FIRST_FILE)).toEqual([{ key: "stations", used: 4, limit: 3 }]);
    const fits: LicensePreview = {
      ...FIRST_FILE,
      after: {
        ...FIRST_FILE.after,
        quotas: { ...FIRST_FILE.after.quotas, stations: { limit: 5, used: 4, over: false } },
      },
    };
    expect(overLimits(fits)).toEqual([]);
  });

  it("warns of a file already expired and of one not yet valid", () => {
    const after: LicenseTerms = {
      ...FIRST_FILE.after,
      validFrom: "2027-11-01T00:00:00Z",
      validUntil: "2026-09-30T21:00:00Z",
    };
    const warned: LicensePreview = { ...FIRST_FILE, after, warnings: ["expired", "not_yet_valid"] };
    expect(previewWarnings(warned, MSK).map(said)).toEqual([
      "Срок этого файла уже истёк 30.09.2026: после загрузки новые смены открываться не будут.",
      "Этот файл начнёт действовать 01.11.2027; до тех пор действует прежний.",
    ]);
    expect(previewWarnings(FIRST_FILE, MSK)).toEqual([]);
  });

  it("says what a loaded file gives, that it has already expired, or when it begins", () => {
    const loaded = FIRST_FILE.after;
    const now = licenseOf({ effectiveAt: "2026-10-20T10:00:00Z" });
    expect(said(loadedMessage(now, loaded, MSK).text)).toBe(
      "Лицензия загружена. Действует по 20.10.2027 включительно.",
    );
    expect(loadedMessage(now, loaded, MSK).tone).toBe("ok");
    const later = licenseOf({ effectiveAt: "2027-12-01T09:00:00Z" });
    expect(loadedMessage(later, loaded, MSK)).toEqual({
      tone: "warn",
      text: { key: "office.about.license.load.loadedExpired", values: { date: "20.10.2027" } },
    });
    const early = licenseOf({ effectiveAt: "2026-10-01T09:00:00Z" });
    expect(said(loadedMessage(early, loaded, MSK).text)).toBe(
      "Лицензия загружена и начнёт действовать 20.10.2026.",
    );
  });
});
