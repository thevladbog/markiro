// Spec 2026-10-13 §12.1 (plan ЛЦ-1): no tracked file holds a private key but
// the public TEST keys named here. The production license key lives in the
// API's environment (plan ЛЦ-0) and the release key on the owner's machine
// (spec §5.1); `apps/standalone/proto/fixtures/trust-keys.json` holds their
// public halves only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const TEST_KEY_FILES = [
  "packages/domain/fixtures/standalone-license/test-private-keys.json",
  "packages/platform-contracts/tools/offline-grants-test-only-key.json",
];

// A PEM private key with a body (any kind: PKCS#8, EC, RSA, encrypted) or a
// private JWK (its `d`). The words alone and a test's short fake are no key.
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const JWK_PRIVATE_KEY = /"d"\s*:\s*"[A-Za-z0-9_-]{32,}"/u;

function holdsPrivateKey(text) {
  return PEM_PRIVATE_KEY.test(text) || JWK_PRIVATE_KEY.test(text);
}

test("a PEM or JWK private key is recognized, the words and a short fake are not", () => {
  const body = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg".repeat(2);
  for (const kind of ["", "EC ", "RSA ", "ENCRYPTED ", "OPENSSH "]) {
    assert.ok(
      holdsPrivateKey(
        `-----BEGIN ${kind}PRIVATE KEY-----\n${body}\n-----END ${kind}PRIVATE KEY-----\n`,
      ),
      kind,
    );
  }
  assert.ok(holdsPrivateKey(`-----BEGIN PRIVATE KEY-----\r\n${body}\r\n-----END PRIVATE KEY-----`));
  assert.ok(holdsPrivateKey(JSON.stringify({ kty: "EC", crv: "P-256", d: "A".repeat(43) })));
  assert.ok(holdsPrivateKey(`{\n  "d": "${"B".repeat(43)}"\n}`));
  assert.equal(holdsPrivateKey("The file holds the host's PRIVATE KEY"), false);
  assert.equal(
    holdsPrivateKey('"-----BEGIN OPENSSH PRIVATE KEY-----",\n  "b3BlbnNzaC1rZXktdjEAAAAA",'),
    false,
  );
  assert.equal(
    holdsPrivateKey(
      JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) }),
    ),
    false,
  );
});

test("no tracked file holds a private key but the listed test keys", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const holders = [];
  for (const path of files) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    if (holdsPrivateKey(bytes.toString("utf8"))) holders.push(path);
  }
  assert.deepEqual(holders.sort(), [...TEST_KEY_FILES].sort());
});
