import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { beforeAll, expect, it } from "vitest";

import { auditBuiltSite } from "../src/lib/audit";

const execFileAsync = promisify(execFile);
const appRoot = new URL("../", import.meta.url);

beforeAll(async () => {
  await execFileAsync("node_modules/.bin/astro", ["build"], {
    cwd: appRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
});

it("passes the deterministic audit against the real Astro output", async () => {
  const findings = await auditBuiltSite(new URL("dist/", appRoot).pathname);
  expect(findings).toEqual([]);
});
