import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as logSanitizer from "../log-sanitizer.mjs";

const { sanitizeJournal } = logSanitizer;

test("journal sanitizer allowlists units, redacts credential shapes, and enforces byte and line bounds", () => {
  const output = sanitizeJournal(
    [
      { unit: "markiro-readiness-observer.service", message: "smtp_degraded" },
      { unit: "markiro-deploy.service", message: "token=secret-value deployment failed" },
      {
        unit: "markiro-deploy.service",
        message: '{"token":"json-token","nested":{"client_secret":"json-secret"},"safe":"healthy"}',
      },
      {
        unit: "markiro-deploy.service",
        message: 'Cookie: session=cookie-secret Set-Cookie="refresh=cookie-two"',
      },
      {
        unit: "markiro-deploy.service",
        message: "Authorization: Basic basic-secret",
      },
      {
        unit: "markiro-deploy.service",
        message: "Bearer bearer-secret",
      },
      {
        unit: "markiro-deploy.service",
        message:
          'url=https://alice:url-password@example.test/path?access_token=query-secret password="quoted secret"',
      },
      {
        unit: "markiro-deploy.service",
        message:
          '{"callback":"https://bob:nested-password@example.test/path?token=nested-query","safe":"still-safe"}',
      },
      { unit: "untrusted.service", message: "must not ship" },
      { unit: "docker.service", message: "x".repeat(2000) },
    ],
    { maxBytes: 2048, maxLineBytes: 256 },
  );
  assert.match(output, /smtp_degraded/);
  assert.match(output, /token=\[REDACTED\]/);
  assert.doesNotMatch(
    output,
    /secret-value|json-token|json-secret|cookie-secret|cookie-two|basic-secret|bearer-secret|url-password|query-secret|quoted secret|nested-password|nested-query|must not ship/,
  );
  assert.match(output, /"safe":"healthy"/);
  assert.match(output, /"safe":"still-safe"/);
  assert.ok(Buffer.byteLength(output) <= 2048);
  assert.ok(output.split("\n").every((line) => Buffer.byteLength(line) <= 256));
});

for (const [name, message, secret] of [
  ["malformed JSON", '{"token":"malformed-secret" trailing', "malformed-secret"],
  [
    "prefixed and suffixed JSON",
    'dependency failed: {"password":"prefixed-secret"} after retry',
    "prefixed-secret",
  ],
  [
    "quoted sensitive key and value",
    'payload "client_secret" : "quoted-value-secret" trailing',
    "quoted-value-secret",
  ],
])
  test(`journal sanitizer fails closed for ${name} inside the retained byte budget`, () => {
    const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }], {
      maxBytes: 256,
      maxLineBytes: 192,
    });

    assert.ok(Buffer.byteLength(output) <= 256);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /\[REDACTED\]/);
  });

test("journal sanitizer redacts malformed structured credentials before a UTF-8 boundary truncation", () => {
  const secret = "boundary-secret";
  const output = sanitizeJournal(
    [
      {
        unit: "markiro-deploy.service",
        message: `${"я".repeat(4)} {"token":"${secret}","tail":"${"x".repeat(100)}`,
      },
    ],
    { maxBytes: 96, maxLineBytes: 72 },
  );

  assert.ok(Buffer.byteLength(output) <= 96);
  assert.doesNotMatch(output, new RegExp(`${secret}|�`));
  assert.match(output, /\[REDACTED\]/);
});

test("journal sanitizer preserves benign structured-looking diagnostics", () => {
  const output = sanitizeJournal(
    [
      { unit: "markiro-deploy.service", message: "[INFO] deployment failed" },
      { unit: "markiro-deploy.service", message: 'retrying "database": unavailable' },
      {
        unit: "markiro-deploy.service",
        message: 'api-1 | {"status":"degraded"} after retry',
      },
    ],
    { maxBytes: 512, maxLineBytes: 160 },
  );

  assert.match(output, /\[INFO\] deployment failed/);
  assert.match(output, /retrying "database": unavailable/);
  assert.match(output, /api-1 \| \{"status":"degraded"\} after retry/);
  assert.doesNotMatch(output, /\[REDACTED\]/);
});

test("durable spool stays size and age bounded across rename rotation and restart", async () => {
  assert.equal(typeof logSanitizer.writeBoundedSpool, "function");
  const root = await mkdtemp(path.join(tmpdir(), "markiro-log-spool-"));
  const spool = path.join(root, "observability.log");
  const options = { maxBytes: 24, maxAgeMs: 1_000, markerPath: `${spool}.started-at` };

  try {
    await logSanitizer.writeBoundedSpool(spool, "first-line\n", { ...options, now: 1_000 });
    const initial = await stat(spool);

    await logSanitizer.writeBoundedSpool(spool, "second-line-is-long\n", {
      ...options,
      now: 1_001,
    });
    const rotated = await stat(`${spool}.1`);
    assert.equal(
      rotated.ino,
      initial.ino,
      "rotation must preserve the old inode for agent tailing",
    );
    assert.equal(await readFile(`${spool}.1`, "utf8"), "first-line\n");
    assert.equal(await readFile(spool, "utf8"), "second-line-is-long\n");

    await logSanitizer.writeBoundedSpool(spool, "age\n", { ...options, now: 2_002 });
    assert.equal(await readFile(`${spool}.1`, "utf8"), "second-line-is-long\n");
    assert.equal(await readFile(spool, "utf8"), "age\n");

    // A fresh call simulates a restarted sanitizer reading the durable age marker.
    await logSanitizer.writeBoundedSpool(spool, "restart\n", { ...options, now: 2_003 });
    assert.equal(await readFile(spool, "utf8"), "age\nrestart\n");
    assert.ok((await stat(spool)).size <= options.maxBytes);
    assert.ok((await stat(`${spool}.1`)).size <= options.maxBytes);
    await assert.rejects(stat(`${spool}.2`), { code: "ENOENT" });

    await assert.rejects(
      logSanitizer.writeBoundedSpool(spool, "x".repeat(options.maxBytes + 1), {
        ...options,
        now: 2_004,
      }),
      /spool payload exceeds bound/,
    );
    assert.equal(await readFile(spool, "utf8"), "age\nrestart\n");

    await logSanitizer.writeBoundedSpool(spool, "", { ...options, now: 3_002 });
    assert.equal(await readFile(`${spool}.1`, "utf8"), "age\nrestart\n");
    await logSanitizer.writeBoundedSpool(spool, "", { ...options, now: 4_002 });
    await assert.rejects(stat(`${spool}.1`), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
