#!/usr/bin/env node
// Opens the usage statistics of a Markiro Автоном support text (beta 3
// feedback). The webview encrypts them for the maker's public key
// (`apps/standalone/src/office/info/support-crypto.ts`); this tool, run with
// the PRIVATE key, prints the JSON and a table by month.
//
//   node tools/standalone-support/decrypt.mjs --key support-private.pem [file]
//   node tools/standalone-support/decrypt.mjs --key support-private.pem < letter.txt
//   node tools/standalone-support/decrypt.mjs --public-jwk --key support-private.pem
//
// The input is the support text as the client sent it (or just the token):
// the first `MKS1.<kid>.<body>` in it is opened. `--public-jwk` prints the
// `{ kid, jwk }` entry for `apps/standalone/proto/fixtures/support-keys.json`
// (the public half only; the private key never leaves the file).
//
// The owner's key steps (once; the private key stays on the owner's machine
// and is never committed):
//
//   openssl ecparam -name prime256v1 -genkey -noout -out support-private.pem
//   node tools/standalone-support/decrypt.mjs --public-jwk --key support-private.pem
//
// then put the printed `{ kid, jwk }` into `keys` of
// `apps/standalone/proto/fixtures/support-keys.json` and build as usual. A
// retired key goes into `retiredKids` (its old texts still open with its file).
//
// The format: `MKS1.<kid>.<base64url(flag ‖ epk (65) ‖ iv (12) ‖ ciphertext ‖
// tag (16))>`, ECDH P-256 + HKDF-SHA256 (salt empty, info `MKS1.<kid>` ‖ epk) +
// AES-256-GCM, additional data `MKS1.<kid>` ‖ flag, `flag` 1 when the
// plaintext was raw-deflated; the writer is `support-crypto.ts` (see its header).
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const VERSION = "MKS1";
const EPK_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BLOB = /MKS1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+/u;

/** The first token in `text`, or throws. */
export function findBlob(text) {
  const match = BLOB.exec(text);
  if (match === null) throw new Error("no MKS1 token in the input");
  return match[0];
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new Error("the token body is not base64url");
  return Buffer.from(text, "base64url");
}

/** Splits a token into its parts without opening it. */
export function parseBlob(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("not a MKS1 token");
  const [, kid, body] = parts;
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(kid)) throw new Error("the key id is malformed");
  const bytes = fromBase64Url(body);
  if (bytes.length < 1 + EPK_BYTES + IV_BYTES + TAG_BYTES)
    throw new Error("the token is too short");
  const flag = bytes[0];
  if (flag !== 0 && flag !== 1) throw new Error("unknown flag");
  return {
    kid,
    flag,
    epk: bytes.subarray(1, 1 + EPK_BYTES),
    iv: bytes.subarray(1 + EPK_BYTES, 1 + EPK_BYTES + IV_BYTES),
    sealed: bytes.subarray(1 + EPK_BYTES + IV_BYTES),
  };
}

/** The JWK of an uncompressed P-256 point. */
function jwkOfPoint(point) {
  if (point.length !== EPK_BYTES || point[0] !== 4)
    throw new Error("not an uncompressed P-256 point");
  return {
    kty: "EC",
    crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"),
    y: point.subarray(33).toString("base64url"),
  };
}

/**
 * Opens `token` with the private key (a PEM string): `{ kid, json }`. Throws on
 * anything that does not authenticate: a changed key id, flag, ephemeral key,
 * nonce or ciphertext.
 */
export function decryptBlob(token, privatePem) {
  const { kid, flag, epk, iv, sealed } = parseBlob(token);
  const privateKey = createPrivateKey(privatePem);
  const ephemeral = createPublicKey({ key: jwkOfPoint(epk), format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const label = Buffer.from(`${VERSION}.${kid}`, "utf8");
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.concat([label, Buffer.from([flag])]));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const body = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
  const text = (flag === 1 ? inflateRawSync(body) : body).toString("utf8");
  return { kid, json: JSON.parse(text) };
}

/** The `{ kid, jwk }` entry of `support-keys.json` for a private key; the kid is a hash of the public point. */
export function publicEntry(privatePem, kid) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    kid: kid ?? `sup-${createHash("sha256").update(point).digest("hex").slice(0, 8)}`,
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

const COLUMNS = [
  ["Месяц", (m) => m.month],
  ["Смен агр.", (m) => m.shifts.aggregation],
  ["Смен пров.", (m) => m.shifts.validation],
  ["с печатью", (m) => m.shifts.validationPrint],
  ["офис", (m) => m.shifts.fromOffice],
  ["станция", (m) => m.shifts.fromStation],
  ["с паллетами", (m) => m.shifts.withPallets],
  ["Принято", (m) => m.scans.accepted],
  ["Дублей", (m) => m.scans.duplicates],
  ["Отклон.", (m) => m.scans.rejected],
  ["Коробов", (m) => m.boxes.closed],
  [
    "Кодов/короб",
    (m) => (m.boxes.closed === 0 ? "—" : (m.boxes.codes / m.boxes.closed).toFixed(1)),
  ],
  ["Паллет", (m) => m.pallets.closed],
  ["Искл.", (m) => Object.values(m.exceptions).reduce((sum, n) => sum + n, 0)],
  ["Конфл.", (m) => m.conflicts.late],
  ["Вытесн.", (m) => m.conflicts.displaced],
  ["Реприн.", (m) => m.reprints.warehouse + m.reprints.unitLabel],
  ["Расформ.", (m) => m.disaggregationApplied],
  ["Ошибок синхр.", (m) => m.syncRejected],
];

/** A readable table of the months and the devices. */
export function table(payload) {
  const rows = payload.months.map((month) => COLUMNS.map(([, cell]) => String(cell(month))));
  const heads = COLUMNS.map(([head]) => head);
  const widths = heads.map((head, at) =>
    Math.max(head.length, ...rows.map((row) => row[at].length)),
  );
  const line = (cells) => cells.map((cell, at) => cell.padStart(widths[at])).join("  ");
  const devices = payload.devices;
  return [
    `Сформировано: ${payload.generatedAt}; приложение ${payload.appVersion ?? "?"}, хост ${payload.hostVersion ?? "?"}`,
    `Устройства: станций ${devices.station}, офисов ${devices.office}, ТСД ${devices.handheld}`,
    "",
    line(heads),
    ...rows.map(line),
  ].join("\n");
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
  const keyPath = argument("--key");
  if (keyPath === undefined) {
    console.error(
      "usage: decrypt.mjs --key <private.pem> [file]   |   --public-jwk --key <private.pem>",
    );
    process.exit(2);
  }
  const pem = readFileSync(keyPath, "utf8");
  if (process.argv.includes("--public-jwk")) {
    console.log(JSON.stringify(publicEntry(pem, argument("--kid")), null, 2));
    return;
  }
  const positional = process.argv
    .slice(2)
    .filter(
      (arg, at, all) => !arg.startsWith("--") && all[at - 1] !== "--key" && all[at - 1] !== "--kid",
    );
  const input = readFileSync(positional[0] ?? 0, "utf8");
  const { kid, json } = decryptBlob(findBlob(input), pem);
  console.log(JSON.stringify(json, null, 2));
  console.log(`\n(ключ ${kid})\n`);
  console.log(table(json));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`decrypt: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
