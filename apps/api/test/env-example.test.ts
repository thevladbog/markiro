import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";

/**
 * `.env.example` is executable input, not documentation. Two consumers take it
 * verbatim and boot the API from it:
 *
 *   - the quick start in README.md / README.ru.md (`cp .env.example .env`),
 *   - `.claude/launch.json`'s `api-shots` config, which sources the example
 *     itself (`set -a; . ./.env.example; ...`) and exports `NODE_ENV=test`.
 *
 * Both reach `loadEnv`, which throws before `NestFactory.create` ever runs, so
 * a bad value here is a crash on a fresh clone rather than a degraded start.
 * `PLATFORM_AUTH_SECRET` once shipped empty against a required
 * `z.string().min(32)`: following the documented quick start died on a
 * ZodError, and nothing structural stopped the next required variable from
 * repeating it. Hence this file.
 *
 * Deliberately NOT covered: `.env.production.example`. Every value there is
 * blank on purpose, supplied from the secret manager at deploy time, and
 * `deploy/yandex/test/runtime-env.test.mjs` already pins it to exactly that
 * all-blank shape via `environmentKeysFromExample`. Asserting it bootable
 * would contradict that contract, not reinforce it.
 */
const EXAMPLE_PATH = join(__dirname, "../../../.env.example");

/**
 * Strict on purpose: every non-blank, non-comment line must be a bare
 * `KEY=VALUE`. A parser that skipped what it could not read would let a
 * required variable vanish from the example and still leave this suite green,
 * which is the exact failure mode the file exists to prevent. Values are taken
 * raw and unquoted, matching what `.` (POSIX source) hands the shell today; a
 * quoted value would need a deliberate decision about semantics, so it should
 * fail here and be looked at rather than be guessed at.
 */
function parseExampleEnv(text: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue;
    const separator = line.indexOf("=");
    const key = separator === -1 ? "" : line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`.env.example:${index + 1} is not a KEY=VALUE line: ${line}`);
    }
    parsed[key] = line.slice(separator + 1);
  }
  return parsed;
}

/**
 * Parsed once, and passed to `loadEnv` ALONE -- never spread over
 * `process.env`. CI exports `PLATFORM_AUTH_SECRET`, `BETTER_AUTH_SECRET` and
 * the rest for the whole suite (.github/workflows/ci.yml), so merging would
 * let the ambient environment satisfy the schema and keep this test green over
 * an example file that cannot actually boot.
 */
const EXAMPLE_ENV = parseExampleEnv(readFileSync(EXAMPLE_PATH, "utf8"));

describe(".env.example", () => {
  it("boots the API exactly as `cp .env.example .env` leaves it", () => {
    expect(() => loadEnv(EXAMPLE_ENV)).not.toThrow();
  });

  it("boots under the NODE_ENV=test that `.claude/launch.json` exports", () => {
    expect(() => loadEnv({ ...EXAMPLE_ENV, NODE_ENV: "test" })).not.toThrow();
  });

  // Both are already enforced inside `loadEnv`'s `superRefine`, so these add no
  // coverage -- they name the two separations a shipped example is most likely
  // to collapse by copying one placeholder into both slots, and turn that from
  // an anonymous ZodError into a readable failure.
  it("keeps the platform surface distinct from the customer one", () => {
    const env = loadEnv(EXAMPLE_ENV);
    expect(env.PLATFORM_AUTH_SECRET).not.toBe(env.BETTER_AUTH_SECRET);
    expect(env.SAAS_ADMIN_ORIGIN).not.toBe(env.ADMIN_ORIGIN);
  });
});
