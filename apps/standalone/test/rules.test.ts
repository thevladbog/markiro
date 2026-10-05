import { isValidGtin } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import i18n from "../src/i18n/index.js";
import {
  badgeCodeRule,
  badgeLabelRule,
  boxCapacityRule,
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  gtinRule,
  innRule,
  isPlainText,
  isTransferable,
  lineNameRule,
  loginRule,
  MAX_BOX_CAPACITY,
  MAX_PALLET_BOX_CAPACITY,
  MAX_PRODUCT_NAME,
  MAX_SHELF_LIFE_DAYS,
  operatorLoginRule,
  operatorRoleRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  palletBoxCapacityRule,
  parsePrefixList,
  passwordRule,
  personNameRule,
  pinRule,
  printNameRule,
  productGroupRule,
  productNameRule,
  shelfLifeDaysRule,
  toCount,
  toGroupCode,
  toGtin14,
  toOptionalText,
  toOrgInput,
  type OrgFields,
} from "../src/lib/rules.js";
import { DEFAULT_TIME_ZONE, TIME_ZONE_OPTIONS } from "../src/lib/time-zones.js";

const ORG: OrgFields = {
  orgName: " ООО «Атолл» ",
  inn: "",
  gln: "4600682000013",
  gs1Prefixes: "4600682, 4600682;4607091",
  timeZone: "Europe/Moscow",
};

function orgMessage(overrides: Partial<OrgFields>): string | undefined {
  return orgFieldsSchema.safeParse({ ...ORG, ...overrides }).error?.issues[0]?.message;
}

describe("organization rules", () => {
  it("accepts a valid organization and builds the host's input from it", () => {
    expect(orgFieldsSchema.safeParse(ORG).success).toBe(true);
    expect(toOrgInput(ORG)).toEqual({
      name: "ООО «Атолл»",
      inn: null,
      gln: "4600682000013",
      gs1Prefixes: ["4600682", "4607091"],
      timeZone: "Europe/Moscow",
    });
  });

  it.each([
    [{ orgName: "  " }, "rules.orgName"],
    [{ inn: "12345678901" }, "rules.inn"],
    [{ gln: "460068200001" }, "rules.gln"],
    [{ gln: "4600682000010" }, "rules.glnCheckDigit"],
    [{ gs1Prefixes: "460" }, "rules.gs1Prefixes"],
    [
      { gs1Prefixes: "1001 1002 1003 1004 1005 1006 1007 1008 1009 1010 1011" },
      "rules.gs1Prefixes",
    ],
    [{ timeZone: "" }, "rules.timeZone"],
  ] satisfies [Partial<OrgFields>, string][])("rejects %j with %s", (overrides, message) => {
    expect(orgMessage(overrides)).toBe(message);
  });

  it("maps the host's organization fields to form fields", () => {
    expect(ORG_HOST_FIELDS.name).toBe("orgName");
    expect(ORG_HOST_FIELDS.gs1Prefixes).toBe("gs1Prefixes");
    expect(ORG_HOST_FIELDS.unknown).toBeUndefined();
  });

  it("splits a prefix list on commas, semicolons and spaces", () => {
    expect(parsePrefixList(" 4600682,4607091 ;4600682 ")).toEqual(["4600682", "4607091"]);
  });
});

describe("office user rules", () => {
  it("checks logins, names and passwords like the host", () => {
    expect(loginRule.safeParse(" tech.2 ").data).toBe("tech.2");
    expect(loginRule.safeParse("ab").error?.issues[0]?.message).toBe("rules.login");
    expect(loginRule.safeParse("иван").error?.issues[0]?.message).toBe("rules.login");
    expect(personNameRule.safeParse(" Павел ").data).toBe("Павел");
    expect(personNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.name");
    expect(personNameRule.safeParse("я".repeat(101)).success).toBe(false);
    expect(passwordRule.safeParse("seven77").error?.issues[0]?.message).toBe("rules.password");
    // Eight Cyrillic letters are 16 bytes but 8 characters, as the host counts.
    expect(passwordRule.safeParse("пароль12").success).toBe(true);
    // Four emoji are 8 UTF-16 code units but 4 characters: too short, as the host counts.
    expect(passwordRule.safeParse("😀".repeat(4)).success).toBe(false);
    expect(passwordRule.safeParse("😀".repeat(8)).success).toBe(true);
    // 100 emoji are 200 code units but 100 characters: still a valid name.
    expect(personNameRule.safeParse("😀".repeat(100)).success).toBe(true);
    expect(passwordRule.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("says the length first when a password is too short and holds an unpaired surrogate too", () => {
    // The forms show the first issue: the length, then the damaged character.
    expect(passwordRule.safeParse("ab\ud800").error?.issues.map((issue) => issue.message)).toEqual([
      "rules.password",
      "rules.passwordCharacter",
    ]);
  });

  it("refuses an unpaired surrogate in a password with its own message, which cannot reach the host", () => {
    expect(passwordRule.safeParse("пароль12\ud800").error?.issues[0]?.message).toBe(
      "rules.passwordCharacter",
    );
    expect(passwordRule.safeParse("\udc00пароль12").error?.issues[0]?.message).toBe(
      "rules.passwordCharacter",
    );
    // A pair is one character and crosses the IPC as it is.
    expect(passwordRule.safeParse("пароль😀12").success).toBe(true);
    expect(isTransferable("пароль\ud800")).toBe(false);
    expect(isTransferable("пароль😀")).toBe(true);
  });
});

describe("free text", () => {
  it("takes 1 to max characters, counted as the host counts them", () => {
    expect(isPlainText("Линия 1", 100)).toBe(true);
    expect(isPlainText("", 100)).toBe(false);
    expect(isPlainText("я".repeat(100), 100)).toBe(true);
    expect(isPlainText("я".repeat(101), 100)).toBe(false);
    // 100 emoji are 200 UTF-16 code units but 100 characters.
    expect(isPlainText("😀".repeat(100), 100)).toBe(true);
  });

  it("refuses a control character anywhere, as `char::is_control` does", () => {
    for (const control of [
      "\u0000",
      "\t",
      "\n",
      "\u001f",
      "\u007f",
      "\u0080",
      "\u0085",
      "\u009f",
    ]) {
      expect(isPlainText(`Линия${control}1`, 100)).toBe(false);
    }
    // Not control characters: a no-break space, a soft hyphen, a zero-width joiner.
    for (const text of ["Линия\u00a01", "Линия\u00ad1", "Линия\u200d1"]) {
      expect(isPlainText(text, 100)).toBe(true);
    }
  });

  it("refuses an unpaired surrogate anywhere, and keeps a valid pair", () => {
    // A Rust string cannot hold one: JSON.stringify would write an escape,
    // serde_json would refuse it, and the form would report a lost connection.
    for (const text of [
      "\ud800Линия",
      "Линия\udc00",
      "Ли\ud800ния",
      "Линия\udbffA",
      "\udc00\ud800",
      "\ud800",
    ]) {
      expect(isPlainText(text, 100)).toBe(false);
    }
    // A pair is one code point: an emoji at either end or inside, and a joined family.
    for (const text of ["😀Линия", "Линия😀", "Ли😀ния", "👨\u200d👩\u200d👧"]) {
      expect(isPlainText(text, 100)).toBe(true);
    }
  });

  it("refuses an unpaired surrogate in every free-text field, as a control character", () => {
    for (const rule of [
      personNameRule,
      deviceNameRule,
      lineNameRule,
      companyNameRule,
      productNameRule,
      printNameRule,
    ]) {
      for (const text of ["Павел\ud800", "\udc00Станция", "Ли\ud800ния"]) {
        expect(rule.safeParse(text).error?.issues[0]?.message).toBe("rules.controlCharacter");
      }
    }
    expect(orgMessage({ orgName: "ООО «Ат\ud800олл»" })).toBe("rules.controlCharacter");
    expect(deviceNameRule.safeParse("Станция 😀").success).toBe(true);
  });

  it("names a control character in its own words and keeps each field's length message", () => {
    // A tab pasted from a spreadsheet is invisible: a length message would not explain it.
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(companyNameRule.safeParse("ООО\u0085«Юг»").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(personNameRule.safeParse("я".repeat(101)).error?.issues[0]?.message).toBe("rules.name");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    // Both wrong: the length comes first.
    expect(lineNameRule.safeParse("л".repeat(101) + "\t2").error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("trims a tab at the edge of a value, but refuses one inside", () => {
    expect(lineNameRule.safeParse("\tЛиния 2\t").data).toBe("Линия 2");
    expect(lineNameRule.safeParse("Линия\t2").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    // A NUL is trimmed by neither JavaScript nor Rust, at the edge or inside.
    expect(lineNameRule.safeParse("Линия 2\u0000").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(lineNameRule.safeParse("Ли\u0000ния").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("trims before it counts, and a NUL at the edge is not trimmed away", () => {
    expect(lineNameRule.safeParse("  Линия 2  ").data).toBe("Линия 2");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("\u0000Линия").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(lineNameRule.safeParse("л".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("holds every free-text field the office and the wizard send", () => {
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(deviceNameRule.safeParse(" Станция 2 ").data).toBe("Станция 2");
    expect(deviceNameRule.safeParse("Станция\u00002").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    expect(orgMessage({ orgName: "ООО\t«Атолл»" })).toBe("rules.controlCharacter");
  });

  it("takes a company name of exactly 200 characters and refuses 201: counterparties depend on it", () => {
    expect(companyNameRule.safeParse("я".repeat(200)).success).toBe(true);
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    // 200 emoji are 400 UTF-16 code units but 200 characters, as the host counts them.
    expect(companyNameRule.safeParse("😀".repeat(200)).success).toBe(true);
    expect(orgMessage({ orgName: "я".repeat(200) })).toBeUndefined();
    expect(orgMessage({ orgName: "я".repeat(201) })).toBe("rules.orgName");
  });

  it("takes a device name of exactly 100 characters and refuses 101, as validate::device_name does", () => {
    expect(deviceNameRule.safeParse("с".repeat(100)).success).toBe(true);
    expect(deviceNameRule.safeParse("с".repeat(101)).error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse("😀".repeat(100)).success).toBe(true);
    expect(deviceNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.name");
  });

  it("checks company fields with the organization's rules", () => {
    expect(innRule.safeParse(" 7812345678 ").data).toBe("7812345678");
    expect(innRule.safeParse("").success).toBe(true);
    expect(innRule.safeParse("781234567").error?.issues[0]?.message).toBe("rules.inn");
    expect(glnRule.safeParse("4601234000017").success).toBe(true);
    expect(glnRule.safeParse("4601234000010").error?.issues[0]?.message).toBe(
      "rules.glnCheckDigit",
    );
    expect(gs1PrefixesRule.safeParse("4601234, 4609876").success).toBe(true);
    expect(gs1PrefixesRule.safeParse("123").error?.issues[0]?.message).toBe("rules.gs1Prefixes");
  });
});

describe("operator rules", () => {
  it("takes a personnel number of 3 to 12 ASCII digits, trimmed, leading zeros kept", () => {
    expect(operatorLoginRule.safeParse(" 0042 ").data).toBe("0042");
    expect(operatorLoginRule.safeParse("123").success).toBe(true);
    expect(operatorLoginRule.safeParse("123456789012").success).toBe(true);
    // Arabic-Indic and full-width digits are digits to Unicode, not to the host.
    for (const login of ["", "12", "1234567890123", "12a4", "0042 1", "١٢٣٤", "１２３"]) {
      expect(operatorLoginRule.safeParse(login).error?.issues[0]?.message).toBe(
        "rules.operatorLogin",
      );
    }
  });

  it("takes a PIN of 4 to 6 ASCII digits, trimmed", () => {
    expect(pinRule.safeParse(" 4821 ").data).toBe("4821");
    expect(pinRule.safeParse("123456").success).toBe(true);
    for (const pin of ["", "123", "1234567", "12a4", "12 34", "١٢٣٤"]) {
      expect(pinRule.safeParse(pin).error?.issues[0]?.message).toBe("rules.pin");
    }
  });

  it("takes an optional role of up to 120 characters and a label of up to 100, blank as none", () => {
    expect(operatorRoleRule.safeParse("   ").data).toBe("");
    expect(toOptionalText("   ")).toBeNull();
    expect(toOptionalText(" Упаковщик ")).toBe("Упаковщик");
    expect(operatorRoleRule.safeParse("я".repeat(120)).success).toBe(true);
    expect(operatorRoleRule.safeParse("я".repeat(121)).error?.issues[0]?.message).toBe(
      "rules.role",
    );
    expect(operatorRoleRule.safeParse("Упа\tковщик").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
    expect(badgeLabelRule.safeParse("").success).toBe(true);
    expect(badgeLabelRule.safeParse("п".repeat(100)).success).toBe(true);
    expect(badgeLabelRule.safeParse("п".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.badgeLabel",
    );
    expect(badgeLabelRule.safeParse("Пропуск\u0000").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("refuses an unpaired surrogate in a role and a label, as a control character", () => {
    // Both cross the IPC as JSON, which a lone surrogate would break before the host.
    for (const rule of [operatorRoleRule, badgeLabelRule]) {
      for (const text of ["Упаковщик\ud800", "\udc00Упаковщик", "Упа\ud800ковщик", "\ud800"]) {
        expect(rule.safeParse(text).error?.issues[0]?.message).toBe("rules.controlCharacter");
      }
      // A pair is one character and stays.
      expect(rule.safeParse("Упаковщик 😀").success).toBe(true);
    }
  });

  it("counts a role and a label in characters, not UTF-16 units: an emoji is one", () => {
    // 120 emoji are 240 UTF-16 code units but 120 characters, as the host counts them.
    expect(operatorRoleRule.safeParse("😀".repeat(120)).success).toBe(true);
    expect(operatorRoleRule.safeParse("😀".repeat(121)).error?.issues[0]?.message).toBe(
      "rules.role",
    );
    expect(badgeLabelRule.safeParse("😀".repeat(100)).success).toBe(true);
    expect(badgeLabelRule.safeParse("😀".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.badgeLabel",
    );
  });

  it("says the length first when a role or a label is too long and holds a control character too", () => {
    // The forms show the first issue. The tab is inside, where `trim` leaves it.
    const messages = (rule: typeof operatorRoleRule, max: number) =>
      rule.safeParse(`${"я".repeat(max)}\tя`).error?.issues.map((issue) => issue.message);
    expect(messages(operatorRoleRule, 120)).toEqual(["rules.role", "rules.controlCharacter"]);
    expect(messages(badgeLabelRule, 100)).toEqual(["rules.badgeLabel", "rules.controlCharacter"]);
  });

  it("takes a badge code of 1 to 256 printable ASCII characters, trimmed", () => {
    expect(badgeCodeRule.safeParse(" MRK-000742 ").data).toBe("MRK-000742");
    expect(badgeCodeRule.safeParse("x".repeat(256)).success).toBe(true);
    expect(badgeCodeRule.safeParse("0001 2345").success).toBe(true);
    for (const code of ["", "   ", "x".repeat(257), "MRK\t742", "Café", "MRK\ud800"]) {
      expect(badgeCodeRule.safeParse(code).error?.issues[0]?.message).toBe("rules.badgeCode");
    }
  });

  it("ends printable ASCII at the tilde: ~ is a code character, DEL is not", () => {
    expect(badgeCodeRule.safeParse("MRK~742").data).toBe("MRK~742");
    expect(badgeCodeRule.safeParse("~").data).toBe("~");
    // DEL is the character right after the tilde, and a control character.
    expect(badgeCodeRule.safeParse("MRK\u007f742").error?.issues[0]?.message).toBe(
      "rules.badgeCode",
    );
    expect(badgeCodeRule.safeParse("\u007f").error?.issues[0]?.message).toBe("rules.badgeCode");
  });

  it("refuses a badge code typed under the Russian layout with a hint to switch it", () => {
    // «MRK-000742» as a keyboard-wedge scanner types it with the Russian layout on.
    expect(badgeCodeRule.safeParse("ЬКЛ-000742").error?.issues[0]?.message).toBe(
      "rules.badgeCodeLayout",
    );
  });
});

/** The first message `rule` gives for `text`; `undefined` when it accepts the text. */
function message(rule: z.ZodString, text: string): string | undefined {
  return rule.safeParse(text).error?.issues[0]?.message;
}

describe("product rules", () => {
  it("pins the host's caps: 100 000 units a box, 10 000 boxes a pallet, 3650 days, 200 characters", () => {
    expect(MAX_BOX_CAPACITY).toBe(100_000);
    expect(MAX_PALLET_BOX_CAPACITY).toBe(10_000);
    expect(MAX_SHELF_LIFE_DAYS).toBe(3_650);
    expect(MAX_PRODUCT_NAME).toBe(200);
  });

  it("takes a GTIN of 8, 12, 13 or 14 ASCII digits with a valid check digit, trimmed", () => {
    for (const gtin of ["96385074", "036000291452", "4600682000013", "04600682000013"]) {
      expect(message(gtinRule, gtin), gtin).toBeUndefined();
    }
    expect(gtinRule.safeParse(" 4600682000013 ").data).toBe("4600682000013");
  });

  it("says a wrong length or a character that is no ASCII digit in one message", () => {
    // 9, 10 and 11 digits are no GTIN length; 7 and 15 lie outside them.
    for (const gtin of [
      "",
      "4600682",
      "460068200",
      "4600682000",
      "46006820000",
      "460068200001304",
      "460068200001A",
      "4600682 000013",
      "+4600682000013",
      "４６００６８２００００１３",
      "٤٦٠٠٦٨٢٠٠٠٠١٣",
    ]) {
      expect(message(gtinRule, gtin), gtin).toBe("rules.gtin");
      // One message: a text that is no GTIN has no check digit to be wrong.
      expect(gtinRule.safeParse(gtin).error?.issues, gtin).toHaveLength(1);
    }
  });

  it("says a wrong check digit in its own message", () => {
    for (const gtin of ["4600682000010", "04600682000010", "96385075", "036000291453"]) {
      expect(message(gtinRule, gtin), gtin).toBe("rules.gtinCheckDigit");
    }
  });

  it("accepts exactly what the domain's normalizeToGtin14 accepts", () => {
    for (const gtin of [
      "96385074",
      "96385070",
      "036000291452",
      "4600682000013",
      "4600682000020",
      "04600682000020",
      "00000096385074",
      "1234567",
      "4600682000013 ",
    ]) {
      expect(gtinRule.safeParse(gtin).success, gtin).toBe(isValidGtin(gtin.trim()));
    }
  });

  it("saves a GTIN as its 14 digits, zero-padded", () => {
    expect(toGtin14("4600682000013")).toBe("04600682000013");
    expect(toGtin14(" 96385074 ")).toBe("00000096385074");
    expect(toGtin14("036000291452")).toBe("00036000291452");
    expect(toGtin14("04600682000013")).toBe("04600682000013");
  });

  it("takes a name of 1 to 200 characters and a print name of up to 200, blank as none", () => {
    expect(message(productNameRule, "я".repeat(200))).toBeUndefined();
    expect(message(productNameRule, "😀".repeat(200))).toBeUndefined();
    expect(message(productNameRule, "я".repeat(201))).toBe("rules.productName");
    expect(message(productNameRule, "  ")).toBe("rules.productName");
    expect(message(productNameRule, "Молоко\t3,2%")).toBe("rules.controlCharacter");
    expect(printNameRule.safeParse("   ").data).toBe("");
    expect(toOptionalText("   ")).toBeNull();
    expect(message(printNameRule, "я".repeat(200))).toBeUndefined();
    expect(message(printNameRule, "я".repeat(201))).toBe("rules.printName");
    expect(message(printNameRule, "Молоко\u0000")).toBe("rules.controlCharacter");
  });

  it.each([
    ["boxCapacityRule", boxCapacityRule, MAX_BOX_CAPACITY, "rules.boxCapacity"],
    [
      "palletBoxCapacityRule",
      palletBoxCapacityRule,
      MAX_PALLET_BOX_CAPACITY,
      "rules.palletBoxCapacity",
    ],
    ["shelfLifeDaysRule", shelfLifeDaysRule, MAX_SHELF_LIFE_DAYS, "rules.shelfLifeDays"],
  ] as const)("%s takes a whole number from 1 to its cap, or nothing", (_name, rule, max, key) => {
    for (const text of ["", "   ", "1", " 12 ", String(max)]) {
      expect(message(rule, text), text).toBeUndefined();
    }
    // `Number` would take most of these; the host's integer takes none.
    for (const text of [
      "0",
      String(max + 1),
      "012",
      "+12",
      "-1",
      "1e3",
      "0x10",
      "12.0",
      "1,5",
      "1 2",
      "１２",
      "١٢",
      "9".repeat(400),
    ]) {
      expect(message(rule, text), text).toBe(key);
    }
  });

  it("turns an accepted count into the number the host takes, and blank into none", () => {
    expect(toCount("")).toBeNull();
    expect(toCount("  ")).toBeNull();
    expect(toCount(" 12 ")).toBe(12);
    expect(toCount("100000")).toBe(100_000);
  });

  it("takes no product group, or a group's code from the select", () => {
    for (const value of ["", "8", "59"]) {
      expect(message(productGroupRule, value), value).toBeUndefined();
    }
    for (const value of ["0", "08", "8a", " 8", "-1"]) {
      expect(message(productGroupRule, value), value).toBe("rules.productGroup");
    }
    // The select offers only valid codes, so no screen renders this text: a
    // typo in the key of `ru.json` would throw nowhere else.
    expect(i18n.t("rules.productGroup")).toBe("Выберите группу из списка");
    expect(toGroupCode("")).toBeNull();
    expect(toGroupCode("15")).toBe(15);
  });
});

describe("time zones", () => {
  it("offers Moscow first and every zone once", () => {
    expect(TIME_ZONE_OPTIONS[0]).toEqual({
      value: DEFAULT_TIME_ZONE,
      label: "Europe/Moscow",
      keywords: ["Europe/Moscow"],
    });
    const values = TIME_ZONE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("America/New_York");
    expect(TIME_ZONE_OPTIONS.find((option) => option.value === "America/New_York")?.label).toBe(
      "America/New York",
    );
  });
});
