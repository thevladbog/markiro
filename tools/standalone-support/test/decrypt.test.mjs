// The maker's tool for the usage statistics of a support text (beta 3). The
// token here is made by an independent writer on node:crypto, so the tool is
// checked against the documented format and not against its own code; the
// webview's writer is checked against the tool in
// `apps/standalone/test/support-crypto.test.ts`.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { decryptBlob, findBlob, publicEntry, table } from "../decrypt.mjs";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "decrypt.mjs");

/** A pair made when the test runs; nothing is stored. */
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKey,
    pem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
  };
}

/** The format of `support-crypto.ts`, written again from its description. */
function seal(json, recipient, kid, compress) {
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = ephemeral.publicKey.export({ format: "jwk" });
  const epk = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const label = Buffer.from(`MKS1.${kid}`);
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
  );
  const iv = randomBytes(12);
  const flag = Buffer.from([compress ? 1 : 0]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([label, flag]));
  const plain = Buffer.from(JSON.stringify(json));
  const body = Buffer.concat([
    cipher.update(compress ? deflateRawSync(plain) : plain),
    cipher.final(),
  ]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);
  return `MKS1.${kid}.${Buffer.concat([flag, epk, iv, sealed]).toString("base64url")}`;
}

const PAYLOAD = {
  v: 1,
  generatedAt: "2026-10-14T09:00:00.000Z",
  appVersion: "0.2.0",
  hostVersion: "0.2.0",
  months: [
    {
      month: "2026-09",
      shifts: {
        aggregation: 6,
        validation: 1,
        validationPrint: 0,
        fromOffice: 5,
        fromStation: 2,
        withPallets: 2,
      },
      scans: { accepted: 7020, duplicates: 64, rejected: 9 },
      boxes: { closed: 585, disassembled: 0, codes: 7020 },
      pallets: { closed: 13, disassembled: 0 },
      exceptions: {
        boxUndo: 4,
        boxClear: 0,
        boxReprint: 2,
        boxDisassemble: 0,
        palletReprint: 0,
        palletDisassemble: 0,
      },
      conflicts: { late: 1, displaced: 0, reviewed: 0 },
      reprints: { warehouse: 0, unitLabel: 0 },
      disaggregationApplied: 0,
      syncRejected: 0,
    },
  ],
  devices: { station: 3, office: 2, handheld: 1 },
};

test("opens a token of the documented format, deflated or not", () => {
  const { publicKey, pem } = pair();
  for (const compress of [true, false]) {
    const token = seal(PAYLOAD, publicKey, "sup-1", compress);
    assert.deepEqual(decryptBlob(token, pem), { kid: "sup-1", json: PAYLOAD });
  }
});

test("refuses every change of a token and another key", () => {
  const { publicKey, pem } = pair();
  const token = seal(PAYLOAD, publicKey, "sup-1", true);
  const [version, kid, body] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  const flipped = (at) => {
    const copy = Buffer.from(bytes);
    copy[at] ^= 1;
    return `${version}.${kid}.${copy.toString("base64url")}`;
  };
  for (const at of [0, 30, 66, 70, bytes.length - 1])
    assert.throws(() => decryptBlob(flipped(at), pem), `byte ${at}`);
  assert.throws(() => decryptBlob(`${version}.sup-2.${body}`, pem));
  assert.throws(() => decryptBlob(token.replace("MKS1", "MKS9"), pem));
  assert.throws(() => decryptBlob(token, pair().pem));
  assert.throws(() => findBlob("no token here"));
});

test("finds the token in a whole support text and prints JSON and a table", () => {
  const { publicKey, pem } = pair();
  const token = seal(PAYLOAD, publicKey, "sup-1", true);
  const dir = mkdtempSync(path.join(tmpdir(), "markiro-support-"));
  try {
    const keyFile = path.join(dir, "support-private.pem");
    writeFileSync(keyFile, pem);
    const letter = `Markiro Автоном — сведения для поддержки\r\nВерсия приложения: 0.2.0\r\n\r\nДанные для анализа использования\r\nСтатистика: зашифрована\r\n${token}\r\n`;
    const letterFile = path.join(dir, "letter.txt");
    writeFileSync(letterFile, letter);
    for (const out of [
      execFileSync("node", [TOOL, "--key", keyFile, letterFile], { encoding: "utf8" }),
      execFileSync("node", [TOOL, "--key", keyFile], { encoding: "utf8", input: letter }),
    ]) {
      assert.match(out, /"accepted": 7020/u);
      assert.match(out, /2026-09/u);
      assert.match(out, /станций 3, офисов 2, ТСД 1/u);
    }
    const bad = spawnSync("node", [TOOL, "--key", keyFile], { encoding: "utf8", input: "nothing" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /no MKS1 token/u);
    const noKey = spawnSync("node", [TOOL], { encoding: "utf8", input: letter });
    assert.equal(noKey.status, 2);
    const jwk = JSON.parse(
      execFileSync("node", [TOOL, "--public-jwk", "--key", keyFile, "--kid", "sup-1"], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(jwk, publicEntry(pem, "sup-1"));
    assert.equal("d" in jwk.jwk, false);
    assert.equal(createPublicKey({ key: jwk.jwk, format: "jwk" }).asymmetricKeyType, "ec");
    assert.doesNotMatch(readFileSync(TOOL, "utf8"), /BEGIN (EC )?PRIVATE KEY/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the table says the average codes per box", () => {
  assert.match(table(PAYLOAD), /12\.0/u);
  const empty = structuredClone(PAYLOAD);
  empty.months[0].boxes = { closed: 0, disassembled: 0, codes: 0 };
  assert.match(table(empty), /—/u);
});
