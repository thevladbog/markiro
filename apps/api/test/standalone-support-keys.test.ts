import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSupportBlob } from "../src/modules/standalone-diagnostics/support-blob";
import {
  STANDALONE_SUPPORT_KEYS_ERROR,
  configureStandaloneSupportKeys,
  expectedSupportKid,
  supportKeyKidMismatches,
} from "../src/modules/standalone-diagnostics/standalone-support-keys";
import { sealSupportToken, supportPayloadV2 } from "./support/standalone-support-token";

function generated(type: "sec1" | "pkcs8" = "sec1", namedCurve = "prime256v1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve });
  return { privateKey, publicKey, pem: privateKey.export({ type, format: "pem" }).toString() };
}
const env = (value: unknown) => ({ STANDALONE_SUPPORT_KEYS_JSON: JSON.stringify(value) });

describe("standalone support keys from the environment (plan ДИАГ А1)", () => {
  it("is disabled, not failing, when the variable is unset or empty", () => {
    expect(configureStandaloneSupportKeys({})).toBeNull();
    expect(configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: "" })).toBeNull();
    expect(configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: "  " })).toBeNull();
  });

  it("the owner's key in SEC1 'BEGIN EC PRIVATE KEY' format opens a token (Lockbox one-line JSON)", () => {
    const owner = generated("sec1");
    expect(owner.pem.startsWith("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
    const value = JSON.stringify([{ kid: "sup-owner", pem: owner.pem }]);
    expect(value.includes("\n")).toBe(false); // the inventory refuses a value with a line break
    const keys = configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: value });
    expect(keys).toHaveLength(1);
    const token = sealSupportToken(
      JSON.stringify(supportPayloadV2()),
      owner.publicKey,
      "sup-owner",
    );
    const opened = openSupportBlob(token, keys ?? []);
    expect(opened).toMatchObject({ ok: true, kid: "sup-owner" });
  });

  it("also accepts PKCS8, and a PEM whose newlines were escaped twice", () => {
    const pkcs8 = generated("pkcs8");
    const sec1 = generated("sec1");
    const doubled = sec1.pem.replaceAll("\n", "\\n");
    const keys = configureStandaloneSupportKeys(
      env([
        { kid: "sup-p8", pem: pkcs8.pem },
        { kid: "sup-esc", pem: doubled },
      ]),
    );
    expect(keys?.map((key) => key.kid)).toEqual(["sup-p8", "sup-esc"]);
    for (const [pair, kid] of [
      [pkcs8, "sup-p8"],
      [sec1, "sup-esc"],
    ] as const) {
      const token = sealSupportToken("{}", pair.publicKey, kid);
      expect(openSupportBlob(token, keys ?? []).ok).toBe(true);
    }
  });

  it("fails the start with one sentence and no key material for any bad configuration", () => {
    const good = generated();
    const p384 = generated("sec1", "secp384r1");
    const cases: unknown[] = [
      "not json",
      [],
      [
        {
          kid: "sup-1",
          pem: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
        },
      ],
      [
        { kid: "sup-1", pem: good.pem },
        { kid: "sup-1", pem: good.pem },
      ],
      [{ kid: "bad kid", pem: good.pem }],
      [{ kid: "sup-1", pem: good.pem, extra: true }],
      [{ kid: "sup-1", pem: p384.pem }],
      [{ kid: "sup-1", pem: good.publicKey.export({ type: "spki", format: "pem" }).toString() }],
      [
        {
          kid: "sup-1",
          pem: generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
      ],
    ];
    for (const value of cases) {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      let message = "";
      try {
        configureStandaloneSupportKeys({ STANDALONE_SUPPORT_KEYS_JSON: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toBe(STANDALONE_SUPPORT_KEYS_ERROR);
      expect(message).not.toMatch(/BEGIN|PRIVATE|AAAA/u);
    }
  });

  it("derives the key id the maker's tool prints and reports a mismatch", () => {
    const { privateKey, publicKey } = generated();
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(String(jwk.x), "base64url"),
      Buffer.from(String(jwk.y), "base64url"),
    ]);
    const derived = `sup-${createHash("sha256").update(point).digest("hex").slice(0, 8)}`;
    expect(expectedSupportKid(privateKey)).toBe(derived);
    expect(supportKeyKidMismatches([{ kid: derived, privateKey }])).toEqual([]);
    expect(supportKeyKidMismatches([{ kid: "sup-custom", privateKey }])).toEqual(["sup-custom"]);
  });
});
