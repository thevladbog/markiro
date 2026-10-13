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

// A PEM private key with a body (any kind: PKCS#8, EC, RSA, encrypted,
// OpenSSH), however it is carried: real line breaks, escaped `\n` in a JSON
// string or an env value, indented in a YAML block, with the
// `Proc-Type:`/`DEK-Info:` lines of a traditional encrypted key. The words
// alone and a test's short fake are no key.
const PEM_BLOCK =
  /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----([\s\S]{0,20000}?)-----END \1PRIVATE KEY-----/gu;

function pemHoldsKey(text) {
  for (const match of text.matchAll(PEM_BLOCK)) {
    const body = (match[2] ?? "")
      .replace(/\\\\?[rn]/gu, "\n")
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^["'`]+|["'`,+\s]+$/gu, ""))
      .filter((line) => line !== "" && !/^[A-Za-z-]+:/u.test(line))
      .join("");
    if (/^[A-Za-z0-9+/=]{64,}$/u.test(body)) return true;
  }
  return false;
}

// A private JWK's `d`, the key quoted, single-quoted, JSON-escaped or bare
// (a JavaScript object literal).
const JWK_PRIVATE_KEY = /(?:\\?["'])?\bd(?:\\?["'])?\s*:\s*\\?["'][A-Za-z0-9_-]{32,}\\?["']/u;

// The constant DER openings of a private key in bare base64, without the PEM
// armour. Built from pieces so this file does not hold them whole.
const DER_PRIVATE_KEY = new RegExp(
  [
    // PKCS#8, EC P-256.
    ["MIGHAgEAMBMGByqGSM49", "AgEGCCqGSM49AwEHBG0wawIBAQQg"].join(""),
    // SEC1 EC P-256, then the 32-byte scalar.
    `${["MHcCAQ", "EEI"].join("")}[A-Za-z0-9+/]{40,}`,
    // PKCS#8, RSA.
    `MII[A-Za-z0-9+/]{3}${["IBADANBgkqhkiG9w0", "BAQEFAAS"].join("")}`,
  ].join("|"),
  "u",
);

function holdsPrivateKey(text) {
  return pemHoldsKey(text) || JWK_PRIVATE_KEY.test(text) || DER_PRIVATE_KEY.test(text);
}

/** The text of a tracked file, or null for a binary one (UTF-16 with a BOM is text). */
function textOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  if (bytes.subarray(0, 8000).includes(0)) return null;
  return bytes.toString("utf8");
}

test("a PEM, JWK or bare DER private key is recognized in every carrier, the words and a short fake are not", () => {
  const der = ["MIGHAgEAMBMGByqGSM49", "AgEGCCqGSM49AwEHBG0wawIBAQQg"].join("");
  // A PEM body without a known DER opening: the armour alone must be caught.
  const body = "Zm9vYmFyYmF6".repeat(11);
  const lines = [body.slice(0, 64), body.slice(64)];
  for (const kind of ["", "EC ", "RSA ", "ENCRYPTED ", "OPENSSH "]) {
    assert.ok(
      holdsPrivateKey(
        `-----BEGIN ${kind}PRIVATE KEY-----\n${body}\n-----END ${kind}PRIVATE KEY-----\n`,
      ),
      kind,
    );
  }
  const begin = "-----BEGIN PRIVATE KEY-----";
  const end = "-----END PRIVATE KEY-----";
  const carriers = {
    crlf: `${begin}\r\n${body}\r\n${end}`,
    "escaped line breaks in an env value": `KEY="${begin}\\n${lines.join("\\n")}\\n${end}\\n"`,
    "double-escaped line breaks": `"${begin}\\\\n${body}\\\\n${end}"`,
    "a YAML block": `key: |\n  ${begin}\n  ${lines.join("\n  ")}\n  ${end}\n`,
    "a traditional encrypted key": [
      "-----BEGIN EC PRIVATE KEY-----",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-256-CBC,0123456789ABCDEF0123456789ABCDEF",
      "",
      ...lines,
      "-----END EC PRIVATE KEY-----",
    ].join("\n"),
    "concatenated string lines": `"${begin}\\n" +\n  "${lines[0]}\\n" +\n  "${lines[1]}\\n" +\n  "${end}"`,
    "a JWK": JSON.stringify({ kty: "EC", crv: "P-256", d: "A".repeat(43) }),
    "a JWK on its own line": `{\n  "d": "${"B".repeat(43)}"\n}`,
    "a JavaScript object literal": `const key = { kty: "EC", d: "${"C".repeat(43)}" };`,
    "single quotes": `{ 'd': '${"D".repeat(43)}' }`,
    "escaped JSON": JSON.stringify(JSON.stringify({ d: "E".repeat(43) })),
    "bare PKCS#8 DER": `PRIVATE=${der}${body}`,
    "bare SEC1 DER": `${["MHcCAQ", "EEI"].join("")}${"F".repeat(44)}`,
    "bare RSA DER": `MIIEvg${["IBADANBgkqhkiG9w0", "BAQEFAAS"].join("")}CBKgwggSkAgEAAoIBAQ`,
  };
  for (const [name, text] of Object.entries(carriers)) assert.ok(holdsPrivateKey(text), name);
  assert.equal(holdsPrivateKey("The file holds the host's PRIVATE KEY"), false);
  assert.equal(
    holdsPrivateKey('"-----BEGIN OPENSSH PRIVATE KEY-----",\n  "b3BlbnNzaC1rZXktdjEAAAAA",'),
    false,
  );
  assert.equal(holdsPrivateKey(`${begin}\\n${"A".repeat(40)}\\n${end}`), false);
  assert.equal(
    holdsPrivateKey(
      JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) }),
    ),
    false,
  );
  assert.equal(holdsPrivateKey(`const id = "${"G".repeat(43)}";`), false);
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(JSON.stringify({ d: "H".repeat(43) }), "utf16le"),
  ]);
  assert.ok(holdsPrivateKey(textOf(utf16) ?? ""));
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
    const text = textOf(bytes);
    if (text !== null && holdsPrivateKey(text)) holders.push(path);
  }
  assert.deepEqual(holders.sort(), [...TEST_KEY_FILES].sort());
});
