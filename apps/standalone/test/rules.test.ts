import { describe, expect, it } from "vitest";

import {
  companyNameRule,
  deviceNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  isPlainText,
  lineNameRule,
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  parsePrefixList,
  passwordRule,
  personNameRule,
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

  it("refuses an unpaired surrogate in every free-text field", () => {
    expect(personNameRule.safeParse("Павел\ud800").error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse("\udc00Станция").error?.issues[0]?.message).toBe("rules.name");
    expect(lineNameRule.safeParse("Ли\ud800ния").error?.issues[0]?.message).toBe("rules.lineName");
    expect(companyNameRule.safeParse("ООО\udc00").error?.issues[0]?.message).toBe("rules.orgName");
    expect(orgMessage({ orgName: "ООО «Ат\ud800олл»" })).toBe("rules.orgName");
    expect(deviceNameRule.safeParse("Станция 😀").success).toBe(true);
  });

  it("trims a tab at the edge of a value, but refuses one inside", () => {
    expect(lineNameRule.safeParse("\tЛиния 2\t").data).toBe("Линия 2");
    expect(lineNameRule.safeParse("Линия\t2").error?.issues[0]?.message).toBe("rules.lineName");
    // A NUL is trimmed by neither JavaScript nor Rust, at the edge or inside.
    expect(lineNameRule.safeParse("Линия 2\u0000").error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
    expect(lineNameRule.safeParse("Ли\u0000ния").error?.issues[0]?.message).toBe("rules.lineName");
  });

  it("trims before it counts, and a NUL at the edge is not trimmed away", () => {
    expect(lineNameRule.safeParse("  Линия 2  ").data).toBe("Линия 2");
    expect(lineNameRule.safeParse(" ").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("\u0000Линия").error?.issues[0]?.message).toBe("rules.lineName");
    expect(lineNameRule.safeParse("л".repeat(101)).error?.issues[0]?.message).toBe(
      "rules.lineName",
    );
  });

  it("holds every free-text field the office and the wizard send", () => {
    expect(personNameRule.safeParse("Павел\tОрлов").error?.issues[0]?.message).toBe("rules.name");
    expect(deviceNameRule.safeParse(" Станция 2 ").data).toBe("Станция 2");
    expect(deviceNameRule.safeParse("Станция\u00002").error?.issues[0]?.message).toBe("rules.name");
    expect(companyNameRule.safeParse("я".repeat(201)).error?.issues[0]?.message).toBe(
      "rules.orgName",
    );
    expect(orgMessage({ orgName: "ООО\t«Атолл»" })).toBe("rules.orgName");
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
