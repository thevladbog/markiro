import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { officeLicenseSchema, type OfficeLicense } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  featureRows,
  licenseNotices,
  licenseTerms,
  noticeFreeRenewal,
  noticeNeedsTime,
  noticeText,
  planText,
  quotaRows,
  shortLicenseId,
  stateText,
  stateTone,
  type LicenseText,
} from "../src/office/info/license/license-view.js";
import {
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_ENDING,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const MSK = "Europe/Moscow";
const ALL: OfficeLicense[] = [
  TRIAL,
  TRIAL_ENDING,
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  RESTRICTED,
  TRIAL_EXPIRED,
  WRONG_HOST,
  INN_MISMATCH,
];
/** The owner's line of a subscription file: its next file costs nothing. */
const RENEWAL_TERMS = "Лицензия продлевается согласно условиям заключённой подписки.";

function said(text: LicenseText): string {
  // `exactOptionalPropertyTypes`: i18next's `t` takes no `undefined` options.
  return i18n.t(text.key, text.values ?? {});
}

describe("the license as the office reads it", () => {
  it("reads the host's fixture and every test license with the wire's own schema", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL("../proto/fixtures/office-license.json", testModuleUrl), "utf8"),
    );
    expect(officeLicenseSchema.safeParse(fixture).success).toBe(true);
    for (const license of ALL) expect(officeLicenseSchema.parse(license)).toEqual(license);
  });

  it.each([
    [TRIAL, "Пробный период", "info"],
    [ACTIVE_LICENSE, "Действует", "ok"],
    [DEMO, "Демо-лицензия", "ok"],
    [EXPIRING, "Заканчивается", "warn"],
    [GRACE, "Льготный срок", "error"],
    [RESTRICTED, "Ограничена: новые смены не открываются", "error"],
    [TRIAL_EXPIRED, "Пробный период закончился: новые смены не открываются", "error"],
    [WRONG_HOST, "Выдана другому хосту", "warn"],
    [INN_MISMATCH, "ИНН организации не совпадает с лицензией", "error"],
  ] as const)("names the state in words with its tone (%#)", (license, word, tone) => {
    expect(said(stateText(license))).toBe(word);
    expect(stateTone(license.state)).toBe(tone);
  });

  it("names a state a newer host adds without failing, in the warning tone", () => {
    const future = licenseOf({ state: "some_future_state" });
    expect(said(stateText(future))).toBe("Неизвестное состояние лицензии (some_future_state)");
    expect(stateTone(future.state)).toBe("warn");
    expect(licenseNotices(future)).toEqual([]);
  });

  it("names the plan, a newer host's one as it is", () => {
    expect(said(planText("subscription"))).toBe("Подписка");
    expect(said(planText("demo"))).toBe("Демо-лицензия");
    expect(said(planText("trial"))).toBe("Пробный период");
    expect(said(planText("enterprise"))).toBe("enterprise");
  });

  it("writes the terms in the organization's zone, the last day inclusive", () => {
    const terms = (license: OfficeLicense) => licenseTerms(license, MSK).map(said);
    expect(terms(ACTIVE_LICENSE)).toEqual(["Действует по 31.10.2027 включительно.", RENEWAL_TERMS]);
    expect(terms(DEMO)).toEqual([
      "Демо-лицензия до 03.11.2026 включительно. По окончании демо новые смены не откроются.",
    ]);
    expect(terms(EXPIRING)).toEqual([
      "Действует по 31.10.2027 включительно.",
      "Осталось 20 дн.",
      RENEWAL_TERMS,
    ]);
    // The trial ends at the moment the wizard began, 14 days on: a time, not a last day.
    expect(terms(TRIAL)).toEqual(["Пробный период до 24.10 12:00.", "Осталось 12 дн."]);
    expect(terms(GRACE)).toEqual([
      "Срок лицензии истёк 31.10. Новые смены открываются до 14.11.2027 включительно.",
      "Осталось 9 дн.",
      RENEWAL_TERMS,
    ]);
    expect(terms(RESTRICTED)).toEqual(["Новые смены не открываются с 15.11.2027.", RENEWAL_TERMS]);
    expect(terms(TRIAL_EXPIRED)).toEqual(["Новые смены не открываются с 24.10.2026."]);
    expect(terms(WRONG_HOST)).toEqual([
      "Всё работает до 19.11.2026 включительно; затем новые смены не будут открываться.",
    ]);
    expect(terms(INN_MISMATCH)).toEqual(["Новые смены не открываются с 18.10.2026."]);
    expect(
      terms({
        ...RESTRICTED,
        opensNewShifts: true,
        emergency: { available: false, until: "2027-11-23T06:00:00Z" },
      }),
    ).toEqual([
      // While the extension runs, «не открываются» would contradict it (controller's fix).
      "Аварийное продление: новые смены открываются до 23.11 09:00.",
      RENEWAL_TERMS,
    ]);
  });

  it("names the state by the running emergency extension, never «не открываются» beside it", () => {
    const extended = (license: OfficeLicense) =>
      licenseOf({
        ...license,
        opensNewShifts: true,
        emergency: { available: false, until: "2027-11-23T06:00:00Z" },
      });
    expect(said(stateText(extended(RESTRICTED)))).toBe(
      "Ограничена: новые смены открываются по аварийному продлению",
    );
    expect(said(stateText(extended(TRIAL_EXPIRED)))).toBe(
      "Пробный период закончился: новые смены открываются по аварийному продлению",
    );
    expect(said(stateText(extended(INN_MISMATCH)))).toBe(
      "ИНН организации не совпадает с лицензией",
    );
    for (const license of [RESTRICTED, TRIAL_EXPIRED, INN_MISMATCH]) {
      const lines = licenseTerms(extended(license), MSK).map(said);
      expect(lines.some((line) => line.includes("не открываются"))).toBe(false);
      expect(lines).toContain("Аварийное продление: новые смены открываются до 23.11 09:00.");
    }
    // The extension over: the host says no new shift opens again, and so does the page.
    const over = licenseOf({
      ...RESTRICTED,
      opensNewShifts: false,
      emergency: { available: false, until: "2027-11-23T06:00:00Z" },
    });
    expect(said(stateText(over))).toBe("Ограничена: новые смены не открываются");
    expect(licenseTerms(over, MSK).map(said)).toEqual([
      "Новые смены не открываются с 15.11.2027.",
      "Аварийное продление закончилось 23.11 09:00.",
      RENEWAL_TERMS,
    ]);
  });

  it("explains renewal under the subscription terms, never for a demo or the trial", () => {
    const renewal = (license: OfficeLicense) =>
      licenseTerms(license, MSK).filter((term) => term.key.endsWith(".freeRenewal"));
    expect(renewal(ACTIVE_LICENSE)).toEqual([{ key: "office.about.license.terms.freeRenewal" }]);
    for (const license of [DEMO, licenseOf({ ...DEMO, state: "expiring" }), TRIAL, TRIAL_ENDING]) {
      expect(renewal(license)).toEqual([]);
    }
    expect(renewal(TRIAL_EXPIRED)).toEqual([]);
    // Another host's file or a changed INN: a new file is not about the term (as the band).
    expect(renewal(WRONG_HOST)).toEqual([]);
    expect(renewal(INN_MISMATCH)).toEqual([]);
    for (const license of [EXPIRING, GRACE, RESTRICTED]) {
      expect(renewal(license)).toEqual([{ key: "office.about.license.terms.freeRenewal" }]);
    }
    // A newer cloud's plan is not a subscription: the renewal notice is the subscription's alone.
    expect(
      renewal(licenseOf({ license: { ...ACTIVE_LICENSE.license!, plan: "enterprise" } })),
    ).toEqual([]);
  });

  it("lists the seats of the stations, the office users and the lines, unlimited as null", () => {
    expect(quotaRows(ACTIVE_LICENSE)).toEqual([
      { key: "stations", limit: 5, used: 3, over: false },
      { key: "cabinetUsers", limit: 3, used: 2, over: false },
      { key: "lines", limit: 2, used: 1, over: false },
    ]);
    expect(quotaRows(TRIAL).map((row) => row.limit)).toEqual([null, null, null]);
  });

  it("lists every feature of the license in the cloud's order", () => {
    expect(featureRows(ACTIVE_LICENSE)).toEqual([
      { key: "labelEditor", on: true },
      { key: "publicApi", on: false },
      { key: "pallets", on: true },
      { key: "chzIntegration", on: true },
      { key: "inventory", on: false },
      { key: "commerceMl", on: false },
      { key: "handheld", on: true },
      { key: "customLogo", on: true },
    ]);
  });

  it.each([
    [TRIAL, [["trial", "info", true]]],
    [TRIAL_ENDING, [["trialEnding", "warn", true]]],
    [ACTIVE_LICENSE, []],
    [DEMO, []],
    [EXPIRING, [["expiring", "warn", true]]],
    [licenseOf({ ...DEMO, state: "expiring" }), [["expiringDemo", "warn", true]]],
    [GRACE, [["grace", "error", false]]],
    [RESTRICTED, [["restricted", "error", false]]],
    [TRIAL_EXPIRED, [["trialExpired", "error", false]]],
    [WRONG_HOST, [["wrongHost", "warn", false]]],
    [INN_MISMATCH, [["innMismatch", "error", false]]],
    [
      licenseOf({ flags: { clockBehindDays: 2, clockAhead: false } }),
      [["clockBehind", "warn", true]],
    ],
    [
      licenseOf({ ...GRACE, flags: { clockBehindDays: null, clockAhead: true } }),
      [
        ["grace", "error", false],
        ["clockAhead", "warn", true],
      ],
    ],
  ] as const)("warns the office of what the state calls for (%#)", (license, expected) => {
    expect(
      licenseNotices(license).map((notice) => [notice.kind, notice.tone, notice.dismissible]),
    ).toEqual(expected);
  });

  it("writes each warning with its dates and days, and reads the zone only for the dates", () => {
    const text = (license: OfficeLicense) =>
      licenseNotices(license).map((notice) => said(noticeText(notice, license, MSK)));
    expect(text(TRIAL)).toEqual([
      "Пробный период: осталось 12 дн. Загрузите файл лицензии в разделе «Информация».",
    ]);
    // A trial whose days the host does not count: no «осталось 0 дн.».
    expect(text(licenseOf({ ...TRIAL, daysLeft: null }))).toEqual([
      "Пробный период. Загрузите файл лицензии в разделе «Информация».",
    ]);
    expect(text(TRIAL_ENDING)).toEqual([
      "Пробный период заканчивается 24.10 12:00. После этого новые смены не будут открываться без файла лицензии.",
    ]);
    expect(text(EXPIRING)).toEqual([
      "Лицензия заканчивается 31.10.2027. Чтобы продлить, свяжитесь с Маркиро.",
    ]);
    expect(text(GRACE)).toEqual([
      "Срок лицензии истёк 31.10. До 14.11 всё работает; затем новые смены не будут открываться.",
    ]);
    expect(text(RESTRICTED)).toEqual([
      "Новые смены не открываются: лицензия площадки истекла. Начатые смены можно продолжать и закрывать, данные и выгрузки доступны.",
    ]);
    expect(text(licenseOf({ flags: { clockBehindDays: 2, clockAhead: false } }))).toEqual([
      "Часы ПК хоста отстают от последнего известного времени на 2 дн. Проверьте дату и время Windows.",
    ]);
    expect(licenseNotices(TRIAL).map(noticeNeedsTime)).toEqual([false]);
    expect(licenseNotices(GRACE).map(noticeNeedsTime)).toEqual([true]);
    expect(licenseNotices(RESTRICTED).map(noticeNeedsTime)).toEqual([false]);
  });

  it("warns of the running emergency extension, never «не открываются» beside it", () => {
    const extended = (license: OfficeLicense) =>
      licenseOf({
        ...license,
        opensNewShifts: true,
        emergency: { available: false, until: "2027-11-23T06:00:00Z" },
      });
    const warned = (license: OfficeLicense) =>
      licenseNotices(license).map((notice) => ({
        kind: notice.kind,
        tone: notice.tone,
        dismissible: notice.dismissible,
        dated: noticeNeedsTime(notice),
        text: said(noticeText(notice, license, MSK)),
      }));
    expect(warned(extended(RESTRICTED))).toEqual([
      {
        kind: "restrictedEmergency",
        tone: "error",
        dismissible: false,
        dated: true,
        text: "Новые смены открываются по аварийному продлению до 23.11 09:00: лицензия площадки истекла. Загрузите новый файл лицензии до конца продления.",
      },
    ]);
    expect(warned(extended(TRIAL_EXPIRED))).toEqual([
      {
        kind: "trialExpiredEmergency",
        tone: "error",
        dismissible: false,
        dated: true,
        text: "Новые смены открываются по аварийному продлению до 23.11 09:00: пробный период закончился. Загрузите файл лицензии до конца продления.",
      },
    ]);
    expect(warned(extended(INN_MISMATCH))).toEqual([
      {
        kind: "innMismatchEmergency",
        tone: "error",
        dismissible: false,
        dated: true,
        text: "Новые смены открываются по аварийному продлению до 23.11 09:00: ИНН организации больше не совпадает с ИНН лицензии. Верните ИНН в «Профиле организации» или загрузите файл лицензии для нового ИНН.",
      },
    ]);
    // The extension over: the host refuses new shifts again, and so does the band.
    const over = licenseOf({
      ...RESTRICTED,
      opensNewShifts: false,
      emergency: { available: false, until: "2027-11-23T06:00:00Z" },
    });
    expect(warned(over).map((notice) => notice.kind)).toEqual(["restricted"]);
    // The extension's end in another zone: the date follows the zone given.
    const notice = licenseNotices(extended(RESTRICTED))[0]!;
    expect(said(noticeText(notice, extended(RESTRICTED), "UTC"))).toContain("до 23.11 06:00:");
  });

  it("adds renewal terms to the subscription's end warnings, to no other", () => {
    const addenda = (license: OfficeLicense) =>
      licenseNotices(license).map((notice) => {
        const addendum = noticeFreeRenewal(notice, license);
        return addendum === null ? null : said(addendum);
      });
    expect(addenda(EXPIRING)).toEqual([RENEWAL_TERMS]);
    expect(addenda(licenseOf({ ...DEMO, state: "expiring" }))).toEqual([null]);
    expect(addenda(TRIAL_ENDING)).toEqual([null]);
    // The term has run out: then renewal still follows the subscription terms.
    expect(addenda(GRACE)).toEqual([RENEWAL_TERMS]);
    expect(addenda(RESTRICTED)).toEqual([RENEWAL_TERMS]);
    expect(addenda(licenseOf({ ...RESTRICTED, license: DEMO.license }))).toEqual([null]);
    expect(addenda(TRIAL_EXPIRED)).toEqual([null]);
    expect(addenda(INN_MISMATCH)).toEqual([null]);
    // A subscription restricted, its extension running: the subscription renewal terms still follow.
    const extension = { opensNewShifts: true, emergency: { available: false, until: GRACE.since } };
    expect(addenda(licenseOf({ ...RESTRICTED, ...extension }))).toEqual([RENEWAL_TERMS]);
    expect(addenda(licenseOf({ ...TRIAL_EXPIRED, ...extension }))).toEqual([null]);
    expect(addenda(licenseOf({ ...INN_MISMATCH, ...extension }))).toEqual([null]);
    expect(
      addenda(
        licenseOf({
          ...EXPIRING,
          license: { ...ACTIVE_LICENSE.license!, plan: "enterprise" },
        }),
      ),
    ).toEqual([null]);
  });

  it("has words for every key it produces", () => {
    for (const license of ALL) {
      expect(i18n.exists(stateText(license).key)).toBe(true);
      for (const term of licenseTerms(license, MSK)) {
        expect(i18n.exists(term.key), term.key).toBe(true);
      }
      for (const notice of licenseNotices(license)) {
        expect(i18n.exists(noticeText(notice, license, MSK).key)).toBe(true);
      }
    }
    for (const kind of [
      "trialNoDays",
      "clockBehind",
      "clockAhead",
      "trialExpired",
      "wrongHost",
      "innMismatch",
      "restrictedEmergency",
      "trialExpiredEmergency",
      "innMismatchEmergency",
      "freeRenewal",
    ]) {
      expect(i18n.exists(`office.banner.license.${kind}`), kind).toBe(true);
    }
    expect(i18n.exists("office.about.license.terms.freeRenewal")).toBe(true);
  });

  it("shortens a license id to its first eight characters", () => {
    expect(shortLicenseId("5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f")).toBe("5b1d7c2e");
    expect(shortLicenseId("not-an-id")).toBe("—");
  });
});
