import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { UsHostedHttpsAdapter } from "../src/deployment/us-hosted-https-adapter";

it("requires genuine API owners before creating a transport instance", () => {
  expect(() => new UsHostedHttpsAdapter({}, {})).toThrow("us_hosted_https_invalid");
});
it("keeps the local transport untouched and the same bounded header envelope", () => {
  const local = readFileSync(resolve(__dirname, "../src/deployment/us-http-adapter.ts"), "utf8");
  expect(createHash("sha256").update(local).digest("hex")).toBe(
    "33dafaf28fd5f8ba9679e735b945ab72fdc27051853dbbe861e30b486145640f",
  );
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-https-adapter.ts"),
    "utf8",
  );
  expect(source).toContain('from "node:https"');
  expect(source).toContain("maxHeaderSize: 64 * 1024");
  expect(source).not.toMatch(/process\.env|trust proxy|forceCloseConnections|closeAllConnections/);
});
