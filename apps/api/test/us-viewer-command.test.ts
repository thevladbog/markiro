import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { viewerCommandEnvironment } from "../src/deployment/us-viewer-command";
import { readOwnerPassword } from "../src/deployment/us-owner-command";

const raw = () => parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
const tenantId = "11111111-1111-4111-8111-111111111111";
const originalOwnerId = "22222222-2222-4222-8222-222222222222";
const verify = ["verify", "--tenant-id", tenantId, "--owner-id", originalOwnerId];
const provision = ["provision", ...verify.slice(1), "--confirm-local-synthetic-viewer"];
const marker = "Synthetic-stdin-secret-not-for-output-42!";

describe("reserved synthetic viewer command boundary", () => {
  it.each([
    [verify, "verify"],
    [provision, "provision"],
  ] as const)("accepts the exact %j syntax and isolated environment", (args, mode) => {
    const result = viewerCommandEnvironment(args, raw());
    expect(result).toEqual({ env: expect.any(Object), mode, tenantId, originalOwnerId });
    expect(new URL(result.env.DATABASE_URL).username).toBe("markiro_us");
  });

  it.each(
    [
      [],
      ["initialize", ...provision.slice(1)],
      verify.slice(0, -1),
      provision.slice(0, -1),
      [...verify, "--confirm-local-synthetic-viewer"],
      [...provision, "--confirm-local-synthetic-viewer"],
      ["verify", "--owner-id", originalOwnerId, "--tenant-id", tenantId],
      ["--confirm-local-synthetic-viewer", ...provision.slice(0, -1)],
      [...verify, "--tenant-id", tenantId],
      [...verify, "--owner-id", originalOwnerId],
      ...["--email", "--role", "--password", "--reset", "--force", "--url"].map((flag) => [
        ...provision,
        flag,
        marker,
      ]),
      ...["", "not-a-uuid", `${tenantId} `, tenantId.replaceAll("-", ""), marker].flatMap(
        (value) => [
          ["verify", "--tenant-id", value, "--owner-id", originalOwnerId],
          ["verify", "--tenant-id", tenantId, "--owner-id", value],
        ],
      ),
    ].map((args) => [args]),
  )("refuses malformed or widened arguments #%#", (args) => {
    expect(() => viewerCommandEnvironment(args, raw())).toThrow("us_viewer_arguments_invalid");
    try {
      viewerCommandEnvironment(args, raw());
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "" },
    { MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { VITE_DEPLOYMENT_EDITION: "RU" },
    ...[
      "postgres://markiro_us:synthetic@127.0.0.1:5432/markiro_us_dev",
      "postgres://other:synthetic@127.0.0.1:55432/markiro_us_dev",
      "postgres://markiro_us:synthetic@remote.example:55432/markiro_us_dev",
      "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro",
      "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev?sslmode=require",
    ].map((DATABASE_URL) => ({ DATABASE_URL })),
    { PORT: "3000" },
    { BETTER_AUTH_URL: "https://remote.example" },
  ])("refuses an unsafe environment #%# without echoing it", (overrides) => {
    expect(() => viewerCommandEnvironment(provision, { ...raw(), ...overrides })).toThrow(
      "us_viewer_environment_invalid",
    );
  });

  it.each(["", "\n", "\r\n"])("reuses bounded stdin with one final ending %j", async (ending) => {
    async function* input() {
      yield Buffer.from(marker.slice(0, 10));
      yield Buffer.from(marker.slice(10) + ending);
    }
    expect(await readOwnerPassword(input())).toBe(marker);
  });
  it.each(["x".repeat(12), "x".repeat(128), "é".repeat(128)])(
    "accepts the password character boundary #%#",
    async (password) => {
      async function* input() {
        yield Buffer.from(password);
      }
      expect(await readOwnerPassword(input())).toBe(password);
    },
  );
  it.each([
    "",
    "x".repeat(11),
    "x".repeat(129),
    `${marker}\n\n`,
    `${marker}\r`,
    `${marker}\ninside`,
    `${marker}\rinside`,
    `${marker}\0`,
    "😀".repeat(128) + "\n",
  ])("refuses invalid or over-512-byte stdin #%#", async (password) => {
    async function* input() {
      yield Buffer.from(password);
    }
    await expect(readOwnerPassword(input())).rejects.toThrow("us_development_password_invalid");
  });
  it("stops accumulating after 512 bytes", async () => {
    async function* input() {
      yield Buffer.alloc(513, 120);
      throw new Error("must not continue");
    }
    await expect(readOwnerPassword(input())).rejects.toThrow("us_development_password_invalid");
  });
});
