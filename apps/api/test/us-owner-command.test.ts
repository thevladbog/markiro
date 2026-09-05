import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import * as command from "../src/deployment/us-owner-command";

const raw = () => parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
const confirmed = ["--confirm-local-synthetic-owner"];

describe("local owner command boundary", () => {
  it("accepts only explicit confirmation with the isolated development environment", () => {
    expect(command.ownerCommandEnvironment(confirmed, raw()).DATABASE_URL).toContain(
      "127.0.0.1:55432/markiro_us_dev",
    );
  });
  it.each(
    [[], ["--yes"], [...confirmed, "--reset"], [...confirmed, "--password=secret"]].map((args) => [
      args,
    ]),
  )("rejects unconfirmed or widened arguments %j", (args) => {
    expect(() => command.ownerCommandEnvironment(args, raw())).toThrow(
      "us_owner_confirmation_required",
    );
  });
  it.each([
    { NODE_ENV: "production" },
    { MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { DATABASE_URL: "postgres://markiro_us:synthetic@127.0.0.1:5432/markiro_us_dev" },
    { DATABASE_URL: "postgres://other:synthetic@127.0.0.1:55432/markiro_us_dev" },
    { DATABASE_URL: "postgres://markiro_us:synthetic@remote.example:55432/markiro_us_dev" },
  ])("rejects an unsafe target before connection %j", (overrides) => {
    expect(() => command.ownerCommandEnvironment(confirmed, { ...raw(), ...overrides })).toThrow(
      "us_owner_environment_invalid",
    );
  });
  it("reads a password from bounded stdin, stripping only one terminal line ending", async () => {
    async function* input() {
      yield Buffer.from("Synthetic-owner-");
      yield Buffer.from("password-42!\r\n");
    }
    expect(await command.readOwnerPassword(input())).toBe("Synthetic-owner-password-42!");
  });
  it("rejects oversized stdin rather than accumulating it", async () => {
    async function* input() {
      yield Buffer.alloc(513, 120);
      throw new Error("must not read more");
    }
    await expect(command.readOwnerPassword(input())).rejects.toThrow(
      "us_development_password_invalid",
    );
  });
});
