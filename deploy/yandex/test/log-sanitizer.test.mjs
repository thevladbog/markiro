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
      { unit: "markiro-deploy.service", message: "[INFO] can't deploy" },
      {
        unit: "markiro-deploy.service",
        message: "runner's retrying 'database': unavailable",
      },
      { unit: "markiro-deploy.service", message: 'retrying "database": unavailable' },
      { unit: "markiro-deploy.service", message: 'prefix "unmatched diagnostic' },
      {
        unit: "markiro-deploy.service",
        message: 'api-1 | {"status":"degraded"} after retry',
      },
    ],
    { maxBytes: 512, maxLineBytes: 160 },
  );

  assert.match(output, /\[INFO\] deployment failed/);
  assert.match(output, /\[INFO\] can't deploy/);
  assert.match(output, /runner's retrying 'database': unavailable/);
  assert.match(output, /retrying "database": unavailable/);
  assert.match(output, /prefix "unmatched diagnostic/);
  assert.match(output, /api-1 \| \{"status":"degraded"\} after retry/);
  assert.doesNotMatch(output, /\[REDACTED\]/);
});

for (const [name, message, secret] of [
  [
    "lowercase JSON Unicode escape",
    String.raw`prefix {"to\u006ben":"lowercase-escape-secret"} suffix`,
    "lowercase-escape-secret",
  ],
  [
    "uppercase JSON Unicode escape",
    String.raw`prefix {"to\u006Ben":"uppercase-escape-secret"} suffix`,
    "uppercase-escape-secret",
  ],
  [
    "multiple JSON Unicode escapes",
    String.raw`prefix {"cl\u0069ent_\u0073ecret":"multiple-escape-secret"} suffix`,
    "multiple-escape-secret",
  ],
  [
    "invalid JSON escape",
    String.raw`prefix {"to\u00G0ken":"invalid-escape-secret"} suffix`,
    "invalid-escape-secret",
  ],
  [
    "unpaired JSON surrogate escape",
    String.raw`prefix {"to\uD800ken":"surrogate-escape-secret"} suffix`,
    "surrogate-escape-secret",
  ],
])
  test(`journal sanitizer fails closed for ${name} in a quoted key`, () => {
    const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }], {
      maxBytes: 256,
      maxLineBytes: 192,
    });

    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /\[REDACTED\]/);
  });

test("journal sanitizer decodes escaped sensitive keys before a retained-byte truncation boundary", () => {
  const secret = "escaped-boundary-secret";
  const output = sanitizeJournal(
    [
      {
        unit: "markiro-deploy.service",
        message: String.raw`${"я".repeat(4)} {"to\u006ben":"${secret}","tail":"${"x".repeat(100)}`,
      },
    ],
    { maxBytes: 96, maxLineBytes: 80 },
  );

  assert.ok(Buffer.byteLength(output) <= 96);
  assert.doesNotMatch(output, new RegExp(`${secret}|�`));
  assert.match(output, /\[REDACTED\]/);
});

test("journal sanitizer preserves a safe prefixed JSON fragment with an escaped benign key", () => {
  const output = sanitizeJournal(
    [
      {
        unit: "markiro-deploy.service",
        message: String.raw`api-1 | {"st\u0061tus":"degraded"} after retry`,
      },
      {
        unit: "markiro-deploy.service",
        message: String.raw`api-1 | {"status\uD83D\uDE80":"recovering"} after retry`,
      },
      {
        unit: "markiro-deploy.service",
        message: String.raw`api-1 | {'st\u0061tus':'safe-single'} after retry`,
      },
    ],
    { maxBytes: 512, maxLineBytes: 192 },
  );

  assert.match(output, /st\\u0061tus/);
  assert.match(output, /degraded/);
  assert.match(output, /status\\uD83D\\uDE80/);
  assert.match(output, /recovering/);
  assert.match(output, /safe-single/);
  assert.doesNotMatch(output, /\[REDACTED\]/);
});

for (const [name, message, secret] of [
  [
    "standalone JSON key with an unpaired surrogate",
    String.raw`{"to\uD800ken":"standalone-surrogate-secret"}`,
    "standalone-surrogate-secret",
  ],
  [
    "nested JSON key with an unpaired surrogate",
    String.raw`{"safe":{"to\uDFFFken":"nested-surrogate-secret"}}`,
    "nested-surrogate-secret",
  ],
  [
    "nested JSON value with an unpaired surrogate",
    String.raw`{"safe":{"message":"value\uD800scalar"},"status":"degraded"}`,
    "value",
  ],
])
  test(`journal sanitizer fails closed for ${name}`, () => {
    const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /\[REDACTED\]/);
  });

test("journal sanitizer preserves standalone JSON with valid paired-surrogate keys and values", () => {
  const message = String.raw`{"status\uD83D\uDE80":"healthy\uD83D\uDE80"}`;
  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

  assert.match(output, /status🚀/u);
  assert.match(output, /healthy🚀/u);
  assert.doesNotMatch(output, /\[REDACTED\]/);
});

test("journal sanitizer decodes escaped single-quoted sensitive keys", () => {
  const message = String.raw`prefix {'to\u006ben':'single-quoted-secret'} suffix`;
  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

  assert.doesNotMatch(output, /single-quoted-secret/);
  assert.match(output, /\[REDACTED\]/);
});

for (const quote of ['"', "'"])
  test(`journal sanitizer detects a sensitive ${quote}quoted key beyond the old atom bound`, () => {
    const encodedKey = `${String.raw`\u0061`.repeat(124)}token`;
    const message = `prefix {${quote}${encodedKey}${quote}:${quote}long-key-secret${quote}} suffix`;
    const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

    assert.doesNotMatch(output, /long-key-secret/);
    assert.match(output, /\[REDACTED\]/);
  });

test("journal sanitizer preserves a long escaped benign quoted key", () => {
  const encodedKey = String.raw`\u0061`.repeat(140);
  const message = `prefix {"${encodedKey}":"long-safe-diagnostic"} suffix`;
  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

  assert.match(output, /long-safe-diagnostic/);
  assert.doesNotMatch(output, /\[REDACTED\]/);
});

test("journal sanitizer recovers a sensitive key after an unmatched quote in an exact 777-byte line", () => {
  const secret = "retained-malformed-secret";
  const message = `prefix "broken ${"x".repeat(700)} {"token":"${secret}"}`;
  const originalLine = `markiro-deploy.service ${message}\n`;

  assert.equal(Buffer.byteLength(originalLine), 777);

  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

  assert.equal(output, "markiro-deploy.service [REDACTED]\n");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.equal(output.includes(message), false);
});

for (const [name, message, secret] of [
  [
    "short single quote prefix",
    "prefix 'broken {'token':'single-malformed-secret'}",
    "single-malformed-secret",
  ],
  ["attached single-quoted key", "prefix'token':'attached-secret'", "attached-secret"],
  [
    "multiple false quote starts",
    String.raw`prefix "first "second "third {"to\u006ben":"multiple-false-start-secret"}`,
    "multiple-false-start-secret",
  ],
  ["orphan closing quote", 'prefix token": "orphan-quote-secret"', "orphan-quote-secret"],
])
  test(`journal sanitizer recovers from ${name}`, () => {
    const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);

    assert.equal(output, "markiro-deploy.service [REDACTED]\n");
    assert.doesNotMatch(output, new RegExp(secret));
    assert.equal(output.includes(message), false);
  });

test("journal sanitizer recovers an escaped sensitive key before UTF-8 truncation", () => {
  const secret = "escaped-recovery-secret";
  const message = String.raw`${"я".repeat(4)} prefix \"ignored "broken {"to\u006ben":"${secret}","tail":"${"x".repeat(100)}`;
  const maxLineBytes = 96;
  const retainedMessageBytes =
    maxLineBytes - Buffer.byteLength("markiro-deploy.service ") - Buffer.byteLength("\n");
  const secretEnd = message.indexOf(secret) + secret.length;
  assert.equal(Buffer.byteLength(message.slice(0, secretEnd)), retainedMessageBytes);

  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }], {
    maxBytes: 128,
    maxLineBytes,
  });

  assert.ok(Buffer.byteLength(output) <= maxLineBytes);
  assert.equal(output, "markiro-deploy.service [REDACTED]\n");
  assert.doesNotMatch(output, new RegExp(`${secret}|�`));
  assert.equal(output.includes(message), false);
});

test("journal sanitizer remains bounded while recovering through many false quote starts", () => {
  const secret = "false-start-performance-secret";
  const message = `${'"broken '.repeat(7_999)}{"token":"${secret}"}`;
  assert.ok(message.length < 64 * 1024);

  const started = performance.now();
  const output = sanitizeJournal([{ unit: "markiro-deploy.service", message }]);
  const elapsedMs = performance.now() - started;

  assert.ok(elapsedMs < 2_000, `sanitization exceeded its bounded budget: ${elapsedMs}ms`);
  assert.equal(output, "markiro-deploy.service [REDACTED]\n");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.equal(output.includes(message), false);
});

test("journal sanitizer remains bounded for large adversarial quoted input", () => {
  const withinBound = `${'"safe":'.repeat(8_000)}tail`;
  const overBound = `prefix ${"\\".repeat(2 * 1024 * 1024)} suffix`;
  const started = performance.now();
  const output = sanitizeJournal([
    { unit: "markiro-deploy.service", message: withinBound },
    { unit: "markiro-deploy.service", message: overBound },
  ]);
  const elapsedMs = performance.now() - started;

  assert.ok(elapsedMs < 2_000, `sanitization exceeded its bounded budget: ${elapsedMs}ms`);
  assert.ok(Buffer.byteLength(output) <= 64 * 1024);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /�/);
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
