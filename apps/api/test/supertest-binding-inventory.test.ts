import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every e2e file must bind its HTTP server ONCE, on `127.0.0.1`, before
 * supertest talks to it.
 *
 * Handing supertest an unbound app (`request(app.getHttpServer())`, or a bare
 * express instance) makes it bind a fresh ephemeral port per REQUEST, and
 * `listen(0)` with no host takes the `::` wildcard. Node sets SO_REUSEADDR on
 * listening sockets, so that bind silently succeeds on a port an unrelated
 * local process already holds on `127.0.0.1`, and the kernel then routes the
 * request to the stranger's more specific socket. `support/listen-loopback.ts`
 * carries the full write-up, including how it was caught.
 *
 * The reason this needs a guard rather than a comment: the damage is SILENT.
 * `auth-route-policy.test.ts` fires 60 requests it expects to 404, then
 * asserts the 61st is rate-limited. A request that reached a stranger comes
 * back 404 too, so the assertion on it passes -- but our limiter never counted
 * that request, the 61st is only its 60th hit, and the test dies on the one
 * line that could still notice: `expected 429, got 404`. It then passes on
 * re-run, and the suite gets written off as "flaky under parallel workers"
 * (it is not: `fileParallelism` is already `false` in vitest.config.ts, so no
 * two of these files ever run at once).
 *
 * Two accepted forms, both binding once up front:
 * - Nest apps: `listenOnLoopback(app)` in `beforeAll`.
 * - Bare express apps: `server.listen(0, "127.0.0.1", ...)`, then hand
 *   supertest that `server` (see `openapi-docs.test.ts`).
 */
const TEST_DIR = __dirname;

function testFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

describe("supertest binding inventory", () => {
  it("every file that uses supertest binds its server on 127.0.0.1 first", () => {
    const offenders: string[] = [];

    for (const name of testFiles()) {
      const source = readFileSync(join(TEST_DIR, name), "utf8");
      if (!source.includes('from "supertest"')) continue;
      const bindsViaHelper = source.includes("listenOnLoopback");
      const bindsExplicitly = /\.listen\(\s*0\s*,\s*["']127\.0\.0\.1["']/.test(source);
      if (!bindsViaHelper && !bindsExplicitly) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });
});
