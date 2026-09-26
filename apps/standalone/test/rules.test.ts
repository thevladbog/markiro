import { describe, expect, it } from "vitest";

import {
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
    expect(passwordRule.safeParse("x".repeat(129)).success).toBe(false);
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
