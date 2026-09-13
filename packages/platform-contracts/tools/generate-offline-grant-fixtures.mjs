/** Public TEST-ONLY key/vectors. Never import this tool in application code. */
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../fixtures/offline-grants-v1.json", import.meta.url));
const androidDestination = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/offline-grants-v1.json", import.meta.url),
);
const check = process.argv.includes("--check");
const { privateJwk } = JSON.parse(
  readFileSync(new URL("./offline-grants-test-only-key.json", import.meta.url), "utf8"),
);
const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
const publicKey = createPublicKey(privateKey);
const previous = existsSync(destination)
  ? JSON.parse(readFileSync(destination, "utf8"))
  : undefined;
const encode = (value) => Buffer.from(value).toString("base64url");
const owner = {
  tenantId: "fixture-tenant",
  deviceId: "fixture-device",
  kind: "station",
  credentialEpoch: 1,
};
const base = {
  ...owner,
  version: 1,
  issuer: "https://offline-grants.fixture.invalid",
  grantId: "fixture-grant-device",
  entitlementRevision: "fixture-e1",
  policyRevision: "fixture-p1",
  issuedAt: 1800000000000,
  notBefore: 1800000000000,
};
const device = {
  ...base,
  kindOfGrant: "device",
  startNotAfter: 1800000060000,
  capabilities: ["shift.start.v1", "inventory.start.v1"],
};
const task = {
  ...base,
  grantId: "fixture-grant-task",
  kindOfGrant: "task",
  taskKind: "shift",
  taskId: "fixture-task",
  snapshotDigest: "sha256:fixture-frozen-snapshot",
  completeNotAfter: 1800000120000,
  eventTypes: ["shift.scan.v1", "shift.box.close.v1", "shift.close.v1"],
  budget: [
    { id: "units", unit: "unit", maximum: 2 },
    { id: "boxes", unit: "container", maximum: 1 },
  ],
};
const header = { typ: "markiro-offline-grant+jws", alg: "ES256", kid: "test-only-p256-v1" };
const producers = [];
function produce(
  id,
  payload = device,
  protectedHeader = header,
  alternate = false,
  exactPayloadJson,
) {
  const protectedHeaderJson = alternate
    ? JSON.stringify(
        { kid: protectedHeader.kid, alg: protectedHeader.alg, typ: protectedHeader.typ },
        null,
        2,
      )
    : JSON.stringify(protectedHeader);
  const payloadJson =
    exactPayloadJson ??
    (alternate
      ? JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()), null, 2)
      : JSON.stringify(payload));
  const signingInput = `${encode(protectedHeaderJson)}.${encode(payloadJson)}`;
  const saved = previous?.producers.find((entry) => entry.id === id);
  let signature;
  if (saved?.signingInput === signingInput) {
    assert.equal(saved.compact.split(".").slice(0, 2).join("."), signingInput);
    signature = Buffer.from(saved.compact.split(".")[2], "base64url");
    assert.equal(signature.length, 64);
    assert(
      verify(
        "sha256",
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      ),
      `Invalid recorded signature: ${id}`,
    );
  } else {
    assert(!check, `Missing or changed producer ${id}; regenerate fixtures`);
    signature = sign("sha256", Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
  }
  const compact = `${signingInput}.${encode(signature)}`;
  producers.push({ id, protectedHeaderJson, payloadJson, signingInput, compact });
  return compact;
}
const validDevice = produce("device");
const validTask = produce("task", task);
const context = { owner, issuer: base.issuer, now: base.notBefore, capability: "shift.start.v1" };
const taskContext = {
  owner,
  issuer: base.issuer,
  now: base.notBefore,
  taskKind: task.taskKind,
  taskId: task.taskId,
  snapshotDigest: task.snapshotDigest,
  eventType: "shift.scan.v1",
  consumption: [{ id: "units", used: 0, requested: 1 }],
};
const vectors = [];
function vector(id, compact, inputContext, cryptographic, admission) {
  vectors.push({
    id,
    input: { compact, context: inputContext },
    expected: { cryptographic, admission },
  });
}
vector("valid-device", validDevice, context, "valid", "allow");
vector("valid-task", validTask, taskContext, "valid", "allow");
vector(
  "original-bytes-whitespace-and-order",
  produce("alternate-json", device, header, true),
  context,
  "valid",
  "allow",
);
vector(
  "integral-decimal-and-exponent",
  produce(
    "integral-number-spellings",
    device,
    header,
    false,
    JSON.stringify(device)
      .replace('"credentialEpoch":1', '"credentialEpoch":1.0')
      .replace('"issuedAt":1800000000000', '"issuedAt":1.8e12'),
  ),
  context,
  "valid",
  "allow",
);
for (const [id, patch, admission] of [
  ["none-algorithm", { alg: "none" }, "unsupported_algorithm"],
  ["hs256-algorithm", { alg: "HS256" }, "unsupported_algorithm"],
  ["unknown-key", { kid: "unknown-test-key" }, "unknown_key"],
  ["wrong-type", { typ: "JWT" }, "invalid_header"],
  ["unknown-critical-header", { crit: ["fixture"], fixture: true }, "invalid_header"],
]) {
  vector(id, produce(id, device, { ...header, ...patch }), context, "valid", admission);
}
const [head, body, signatureText] = validDevice.split(".");
vector(
  "altered-payload",
  `${head}.${encode(JSON.stringify({ ...device, credentialEpoch: 2 }))}.${signatureText}`,
  context,
  "invalid",
  "invalid_signature",
);
for (const [name, offset] of [
  ["altered-r", 0],
  ["altered-s", 32],
]) {
  const signature = Buffer.from(signatureText, "base64url");
  signature[offset] ^= 1;
  vector(name, `${head}.${body}.${encode(signature)}`, context, "invalid", "invalid_signature");
}
function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const value = bytes.subarray(start);
  const positive = value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return Buffer.concat([Buffer.from([2, positive.length]), positive]);
}
const rawSignature = Buffer.from(signatureText, "base64url");
const derContent = Buffer.concat([
  derInteger(rawSignature.subarray(0, 32)),
  derInteger(rawSignature.subarray(32)),
]);
const der = Buffer.concat([Buffer.from([0x30, derContent.length]), derContent]);
vector(
  "der-instead-of-raw",
  `${head}.${body}.${encode(der)}`,
  context,
  "invalid",
  "invalid_signature",
);
vector(
  "all-zero-raw-signature",
  `${head}.${body}.${encode(Buffer.alloc(64))}`,
  context,
  "invalid",
  "invalid_signature",
);
for (const [id, compact] of [
  ["missing-segment", `${head}.${body}`],
  ["extra-segment", `${validDevice}.extra`],
  ["empty-header", `.${body}.${signatureText}`],
  ["invalid-base64url", `*.${body}.${signatureText}`],
  ["invalid-json-header", `${encode("{")}.${body}.${signatureText}`],
  ["padded-base64url", `${head}=.${body}.${signatureText}`],
])
  vector(id, compact, context, "not_checked", "malformed_compact");
for (const [name, patch] of [
  ["tenant", { tenantId: "other-fixture-tenant" }],
  ["device", { deviceId: "other-fixture-device" }],
  ["epoch", { credentialEpoch: 2 }],
  ["kind", { kind: "handheld" }],
]) {
  vector(
    `${name}-mismatch`,
    validDevice,
    { ...context, owner: { ...owner, ...patch } },
    "valid",
    "owner_mismatch",
  );
}
vector(
  "snapshot-mismatch",
  validTask,
  { ...taskContext, snapshotDigest: "other-snapshot" },
  "valid",
  "snapshot_mismatch",
);
vector(
  "task-mismatch",
  validTask,
  { ...taskContext, taskId: "other-task" },
  "valid",
  "task_mismatch",
);
vector(
  "issuer-mismatch",
  validDevice,
  { ...context, issuer: "https://other.fixture.invalid" },
  "valid",
  "issuer_mismatch",
);
vector(
  "default-port-origin",
  validDevice,
  { ...context, issuer: "https://offline-grants.fixture.invalid:443" },
  "valid",
  "issuer_mismatch",
);
vector(
  "case-normalized-origin",
  validDevice,
  { ...context, issuer: "HTTPS://OFFLINE-GRANTS.FIXTURE.INVALID" },
  "valid",
  "issuer_mismatch",
);
vector(
  "before-not-before",
  validDevice,
  { ...context, now: base.notBefore - 1 },
  "valid",
  "not_yet_valid",
);
vector(
  "last-start-millisecond",
  validDevice,
  { ...context, now: device.startNotAfter - 1 },
  "valid",
  "allow",
);
vector(
  "exact-start-deadline",
  validDevice,
  { ...context, now: device.startNotAfter },
  "valid",
  "expired",
);
vector(
  "last-completion-millisecond",
  validTask,
  { ...taskContext, now: task.completeNotAfter - 1 },
  "valid",
  "allow",
);
vector(
  "exact-completion-deadline",
  validTask,
  { ...taskContext, now: task.completeNotAfter },
  "valid",
  "expired",
);
vector(
  "exhausted-budget",
  validTask,
  { ...taskContext, consumption: [{ id: "units", used: 2, requested: 1 }] },
  "valid",
  "budget_exhausted",
);
vector(
  "exact-budget",
  validTask,
  { ...taskContext, consumption: [{ id: "units", used: 1, requested: 1 }] },
  "valid",
  "allow",
);
vector(
  "unknown-budget",
  validTask,
  { ...taskContext, consumption: [{ id: "unknown", used: 0, requested: 1 }] },
  "valid",
  "budget_unknown",
);
vector(
  "event-not-allowed",
  validTask,
  { ...taskContext, eventType: "shift.label.prepare.v1" },
  "valid",
  "event_not_allowed",
);
vector(
  "capability-not-allowed",
  validDevice,
  { ...context, capability: "pickup.start.v1" },
  "valid",
  "capability_not_allowed",
);
for (const entry of vectors) {
  if (entry.expected.cryptographic === "not_checked") continue;
  const parts = entry.input.compact.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  const valid =
    signature.length === 64 &&
    verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
  assert.equal(valid, entry.expected.cryptographic === "valid", entry.id);
}
const output = {
  protocol: "offline-grants-v1",
  warning: "Public synthetic fixtures only. Never trust this key in production.",
  expectationNotes:
    "cryptographic uses the fixed test public key regardless of protected header. admission is the expected future verifier/policy result; Task 1 validates definitions and signatures only.",
  publicKey: {
    kid: header.kid,
    jwk: publicKey.export({ format: "jwk" }),
    spkiDerBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  },
  producers,
  vectors,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (check) {
  assert.equal(readFileSync(destination, "utf8"), serialized, "Fixture definitions drifted");
  assert.equal(readFileSync(androidDestination, "utf8"), serialized, "Kotlin fixtures drifted");
} else {
  for (const path of [destination, androidDestination]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized);
  }
}
console.log(
  `${check ? "Verified" : "Generated"} ${vectors.length} offline grant vectors (${producers.length} signed producers).`,
);
