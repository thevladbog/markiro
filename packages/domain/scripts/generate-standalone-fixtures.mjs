// Writes the TEST-ONLY fixtures of the standalone license and update manifest
// (spec 2026-10-13 §12.1, plan ЛЦ-1): the keys on the first run, then every
// signed file, the activation request and the expected outcomes that
// `test/standalone-license-fixtures.test.ts` and the Rust
// `apps/standalone/proto/tests/trust.rs` both check.
//
// Never run in CI: ECDSA signatures are randomized, so every run rewrites the
// .jws files; the suites verify them and never compare their bytes. The keys
// are kept once made (delete test-private-keys.json to make new ones, then
// rerun). Run from the repository root:
//   node packages/domain/scripts/generate-standalone-fixtures.mjs
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../fixtures/standalone-license/", import.meta.url));
const keysFile = `${directory}test-private-keys.json`;
const ORIGIN = "https://license.test.invalid";
const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LICENSE_TYP = "markiro-standalone-license+jws";
const UPDATE_TYP = "markiro-standalone-update+jws";
const DAY = 86_400_000;

mkdirSync(directory, { recursive: true });
const newPrivateJwk = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const keys = existsSync(keysFile)
  ? JSON.parse(readFileSync(keysFile, "utf8"))
  : {
      warning:
        "TEST ONLY. Private test keys of the standalone license and update fixtures, published on purpose. Never trust them in a release or sign anything real with them.",
      license: { kid: "test-lic-1", privateJwk: newPrivateJwk() },
      update: { kid: "test-upd-1", privateJwk: newPrivateJwk() },
    };
const privateKey = (role) => createPrivateKey({ key: keys[role].privateJwk, format: "jwk" });
const publicJwk = (role) => {
  const { kty, crv, x, y } = createPublicKey(privateKey(role)).export({ format: "jwk" });
  return { kty, crv, x, y };
};
const keyset = {
  license: {
    origin: ORIGIN,
    keys: [{ kid: keys.license.kid, jwk: publicJwk("license") }],
    retiredKids: [],
  },
  update: { keys: [{ kid: keys.update.kid, jwk: publicJwk("update") }], retiredKids: [] },
};

const b64 = (text) => Buffer.from(text).toString("base64url");
function jws(typ, role, payload, kid = keys[role].kid) {
  return jwsText(role, JSON.stringify({ typ, alg: "ES256", kid }), JSON.stringify(payload));
}
/** Signs the exact header and payload texts: what a JSON.stringify of an object never writes. */
function jwsText(role, headerText, payloadText) {
  const input = `${b64(headerText)}.${b64(payloadText)}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey(role),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

const ISSUED = Date.UTC(2026, 9, 20); // 2026-10-20
const subscription = {
  version: 1,
  licenseId: "7a1e5c2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d",
  sequence: 1,
  issuer: ORIGIN,
  // An opaque tenant id the counterparty chose (not a UUID): owner decision 2026-10-13.
  tenantId: "Zq4bL0x9cabinetTenant01",
  siteId: "2c3d4e5f-6071-4829-8b3c-4d5e6f7a8b9c",
  hostId: HOST_ID,
  customer: { name: "ООО «Тестовая площадка»", inn: "7707083893" },
  plan: "subscription",
  planVersionId: "4e5f6071-8293-4a4b-9c5d-6e7f8091a2b3",
  entitlementRevision: "12",
  issuedAt: ISSUED,
  validFrom: ISSUED,
  validUntil: Date.UTC(2027, 9, 20),
  graceDays: 14,
  quotas: { lines: 2, stations: 5, kiosks: 0, cabinetUsers: 3 },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: false,
    commerceMl: false,
    handheld: true,
  },
  replaces: null,
};
const UPGRADED = Date.UTC(2026, 10, 19); // 2026-11-19
const licenses = {
  "license-subscription.jws": subscription,
  "license-demo.jws": {
    ...subscription,
    licenseId: "5b6c7d8e-9f01-4a2b-8c3d-4e5f60718293",
    plan: "demo",
    validUntil: ISSUED + 14 * DAY,
    graceDays: 0,
  },
  "license-upgrade.jws": {
    ...subscription,
    licenseId: "6c7d8e9f-0a1b-4c2d-9e3f-5061728394a5",
    sequence: 2,
    entitlementRevision: "13",
    issuedAt: UPGRADED,
    validFrom: UPGRADED,
    quotas: { ...subscription.quotas, stations: 8 },
    replaces: subscription.licenseId,
  },
  "license-older.jws": { ...subscription, licenseId: "8d9eaf01-2b3c-4d4e-a5f6-0718293a4b5c" },
  "license-other-host.jws": {
    ...subscription,
    licenseId: "9eaf0112-3c4d-4e5f-b607-18293a4b5c6d",
    hostId: "9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0",
  },
  "license-other-inn.jws": {
    ...subscription,
    licenseId: "af011223-4d5e-4f60-8718-293a4b5c6d7e",
    customer: { ...subscription.customer, inn: "7707654321" },
  },
};
const files = Object.fromEntries(
  Object.entries(licenses).map(([name, payload]) => [name, jws(LICENSE_TYP, "license", payload)]),
);
// The subscription's header and signature over a payload with more stations.
const [header, , signature] = files["license-subscription.jws"].split(".");
const raised = { ...subscription, quotas: { ...subscription.quotas, stations: 50 } };
files["license-tampered.jws"] = `${header}.${b64(JSON.stringify(raised))}.${signature}`;
files["license-unknown-kid.jws"] = jws(LICENSE_TYP, "license", subscription, "test-lic-unknown");
files["update-manifest.jws"] = jws(UPDATE_TYP, "update", {
  v: 1,
  product: "markiro-standalone",
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  installer: {
    name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sizeBytes: 61234567,
  },
  protocol: 4,
  minProtocol: 2,
  minUpgradeFrom: "0.2.0",
  notes: ["Лицензия площадки и страница «Информация»", "Обновление из файла"],
});
// Adversarial files both suites must refuse alike (review of plan ЛЦ-1).
const licenseHeader = (extra) =>
  `{"typ":"${LICENSE_TYP}","alg":"ES256","kid":"${keys.license.kid}"${extra}}`;
const subscriptionText = JSON.stringify(subscription);
files["license-header-extra.jws"] = jwsText(
  "license",
  licenseHeader(',"cty":"json"'),
  subscriptionText,
);
files["license-header-proto.jws"] = jwsText(
  "license",
  licenseHeader(',"__proto__":{}'),
  subscriptionText,
);
files["license-header-bom.jws"] = jwsText(
  "license",
  `\ufeff${licenseHeader("")}`,
  subscriptionText,
);
files["license-kid-lone-surrogate.jws"] = jwsText(
  "license",
  `{"typ":"${LICENSE_TYP}","alg":"ES256","kid":"\\ud800"}`,
  subscriptionText,
);
files["license-payload-proto.jws"] = jwsText(
  "license",
  licenseHeader(""),
  `{"__proto__":{},${subscriptionText.slice(1)}`,
);
files["license-payload-lone-surrogate.jws"] = jwsText(
  "license",
  licenseHeader(""),
  subscriptionText.replace('"ООО «Тестовая площадка»"', '"ООО \\ud800"'),
);
files["license-payload-extra.jws"] = jws(LICENSE_TYP, "license", { ...subscription, limits: {} });
files["license-other-issuer.jws"] = jws(LICENSE_TYP, "license", {
  ...subscription,
  issuer: "https://other.invalid",
});
// The last signature character with its unused low bits set: canonical
// base64url only, so the same bytes in another spelling are malformed.
{
  const compact = files["license-subscription.jws"];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet[alphabet.indexOf(compact.slice(-1)) + 1];
  files["license-noncanonical.jws"] = compact.slice(0, -1) + last;
}
// The same signature with s replaced by n - s (high S): ECDSA verifies both;
// both suites pin that they agree.
{
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const [head, body, signature] = files["license-subscription.jws"].split(".");
  const bytes = Buffer.from(signature, "base64url");
  const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
  const high = Buffer.from((N - s).toString(16).padStart(64, "0"), "hex");
  files["license-high-s.jws"] =
    `${head}.${body}.${Buffer.concat([bytes.subarray(0, 32), high]).toString("base64url")}`;
}
// Over the size limits but well formed, under a kid no keyset holds: without
// the size check the answer would be unknown_key, not malformed.
files["license-oversized.jws"] = jws(
  LICENSE_TYP,
  "license",
  { ...subscription, pad: "x".repeat(16 * 1024) },
  "test-lic-unknown",
);
files["update-manifest-oversized.jws"] = jws(
  UPDATE_TYP,
  "update",
  { pad: "x".repeat(64 * 1024) },
  "test-upd-unknown",
);
const activation = {
  format: "markiro-activation-request-v1",
  hostId: HOST_ID,
  hostFingerprint: "9b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c",
  hostVersion: "0.3.0",
  organization: { name: "ООО «Тестовая площадка»", inn: "7707083893" },
  trial: { startedAt: "2026-10-20T09:00:00Z", inn: "7707083893" },
  currentLicense: { licenseId: subscription.licenseId, sequence: 1 },
  usage: { stations: 4, cabinetUsers: 2, lines: 2 },
  createdAt: "2026-10-21T09:00:00Z",
};
const expectations = [
  ...Object.keys(licenses).map((file) => ({ file, as: "license", result: "ok" })),
  { file: "license-tampered.jws", as: "license", result: "bad_signature" },
  { file: "license-unknown-kid.jws", as: "license", result: "unknown_key" },
  { file: "update-manifest.jws", as: "update", result: "ok" },
  { file: "update-manifest.jws", as: "license", result: "malformed" },
  { file: "license-subscription.jws", as: "update", result: "malformed" },
  {
    file: "license-subscription.jws",
    as: "license",
    retiredKids: [keys.license.kid],
    result: "unknown_key",
  },
  { file: "license-header-extra.jws", as: "license", result: "malformed" },
  { file: "license-header-proto.jws", as: "license", result: "malformed" },
  { file: "license-header-bom.jws", as: "license", result: "malformed" },
  { file: "license-kid-lone-surrogate.jws", as: "license", result: "malformed" },
  { file: "license-payload-proto.jws", as: "license", result: "malformed" },
  { file: "license-payload-lone-surrogate.jws", as: "license", result: "malformed" },
  { file: "license-payload-extra.jws", as: "license", result: "malformed" },
  { file: "license-other-issuer.jws", as: "license", result: "malformed" },
  { file: "license-noncanonical.jws", as: "license", result: "malformed" },
  { file: "license-high-s.jws", as: "license", result: "ok" },
  { file: "license-oversized.jws", as: "license", result: "malformed" },
  { file: "update-manifest-oversized.jws", as: "update", result: "malformed" },
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
writeFileSync(keysFile, json(keys));
writeFileSync(`${directory}test-keyset.json`, json(keyset));
writeFileSync(`${directory}activation-request.json`, json(activation));
writeFileSync(`${directory}expectations.json`, json(expectations));
for (const [name, compact] of Object.entries(files))
  writeFileSync(`${directory}${name}`, `${compact}\n`);
console.log(`wrote ${Object.keys(files).length} signed files and 4 JSON files to ${directory}`);
