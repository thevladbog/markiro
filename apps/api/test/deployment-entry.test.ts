import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import * as policy from "../src/deployment/entry-policy";

const fixture = () =>
  parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));

describe("edition entry boundaries", () => {
  it.each([undefined, "RU"])("keeps the RU entry compatible with %s", (edition) => {
    expect(() => policy.assertRuEntryEdition(edition)).not.toThrow();
  });
  it.each(["US", "us", "", null, "EU"])("refuses %s at the RU entry", (edition) => {
    expect(() => policy.assertRuEntryEdition(edition)).toThrow();
  });
  it("accepts the isolated synthetic US example", () => {
    const env = policy.loadUsDevelopmentEnv(fixture());
    expect(env.PORT).toBe(3100);
    expect(env.SMTP_PORT).toBe(11025);
    expect(env.S3_BUCKET).toBe("markiro-us-development");
  });
  it.each([
    ["MARKIRO_DEPLOYMENT_EDITION", undefined],
    ["MARKIRO_DEPLOYMENT_EDITION", "RU"],
    ["MARKIRO_DEPLOYMENT_EDITION", "us"],
    ["NODE_ENV", "production"],
    ["NODE_ENV", undefined],
    ["VITE_DEPLOYMENT_EDITION", "RU"],
    ["VITE_DEPLOYMENT_EDITION", undefined],
    ["DATABASE_URL", "postgres://user:pass@localhost:5432/markiro"],
    ["DATABASE_URL", "postgres://user:pass@db.example.com:55432/markiro_us_dev"],
    ["DATABASE_URL", "postgres://user:pass@127.0.0.1:55432/markiro_us_dev?host=db.example.com"],
    ["DATABASE_URL", undefined],
    ["SMTP_HOST", "smtp.example.com"],
    ["SMTP_PORT", "1025"],
    ["SMTP_HOST", undefined],
    ["SMTP_SECURE", "true"],
    ["S3_ENDPOINT", "http://127.0.0.1:9000"],
    ["S3_ENDPOINT", "https://storage.example.com"],
    ["S3_ENDPOINT", undefined],
    ["S3_BUCKET", "markiro-private"],
    ["ADMIN_ORIGIN", "http://localhost:5173"],
    ["BETTER_AUTH_URL", "https://admin.markiro.app"],
    ["PORT", "3000"],
    ["PORT", undefined],
  ] as const)("refuses unsafe or absent %s (%s)", (key, value) => {
    const raw: NodeJS.ProcessEnv = { ...fixture(), [key]: value };
    expect(() => policy.loadUsDevelopmentEnv(raw)).toThrow();
  });
  it("does not reveal a rejected connection string in its diagnostic", () => {
    try {
      policy.loadUsDevelopmentEnv({
        ...fixture(),
        DATABASE_URL: "postgres://private-user:private-secret@db.example.com/db",
      });
      expect.fail("unsafe configuration was accepted");
    } catch (error) {
      expect(String(error)).not.toContain("private-secret");
      expect(String(error)).not.toContain("private-user");
      expect(String(error)).toContain("DATABASE_URL");
    }
  });
});
