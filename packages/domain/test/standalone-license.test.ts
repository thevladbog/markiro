import { describe, expect, it } from "vitest";
import { z } from "zod";

import schemaCases from "../fixtures/standalone-license/schema-cases.json" with { type: "json" };
import { encodeBase64Url, signCompactJws } from "../src/signed-documents/compact-jws.js";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_LICENSE_MAX_BYTES,
  STANDALONE_LICENSE_TYP,
  STANDALONE_OPAQUE_ID_PATTERN,
  STANDALONE_QUOTA_KEYS,
  STANDALONE_UPDATE_TYP,
  standaloneActivationRequestSchema,
  standaloneLicenseFeaturesSchema,
  standaloneLicensePayloadV1Schema,
  standaloneLicenseQuotasSchema,
  standaloneOpaqueIdSchema,
  standaloneUpdateManifestV1Schema,
  verifyStandaloneLicense,
  verifyStandaloneUpdateManifest,
} from "../src/standalone-license/index.js";

const caseSchema = z
  .object({
    name: z.string(),
    valid: z.boolean(),
    set: z.record(z.string(), z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict();
const groupSchema = z
  .object({ base: z.record(z.string(), z.unknown()), cases: z.array(caseSchema).min(1) })
  .strict();
const cases = z
  .object({ license: groupSchema, manifest: groupSchema, activation: groupSchema })
  .strict()
  .parse(schemaCases);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object holding a dotted path's last key (as `apply` in proto/tests/trust.rs). */
function parent(root: Record<string, unknown>, path: string): [Record<string, unknown>, string] {
  const parts = path.split(".");
  const key = parts.pop();
  let target: unknown = root;
  for (const part of parts) target = isRecord(target) ? target[part] : undefined;
  if (!isRecord(target) || key === undefined) throw new Error(`No object for ${path}`);
  return [target, key];
}

function applyCase(base: Record<string, unknown>, item: z.infer<typeof caseSchema>) {
  const value = structuredClone(base);
  for (const [path, next] of Object.entries(item.set ?? {})) {
    const [target, key] = parent(value, path);
    target[key] = next;
  }
  for (const path of item.remove ?? []) {
    const [target, key] = parent(value, path);
    if (!(key in target)) throw new Error(`Nothing at ${path}`);
    delete target[key];
  }
  return value;
}

const groups = [
  ["license", standaloneLicensePayloadV1Schema],
  ["manifest", standaloneUpdateManifestV1Schema],
  ["activation", standaloneActivationRequestSchema],
] as const;

describe.each(groups)("the %s schema cases (shared with markiro_proto::trust)", (name, schema) => {
  it.each(cases[name].cases)("$name", (item) => {
    expect(schema.safeParse(applyCase(cases[name].base, item)).success).toBe(item.valid);
  });
});

describe("standalone license contracts", () => {
  it("name the cloud's quota and feature keys, and only those", () => {
    expect(Object.keys(standaloneLicenseQuotasSchema.shape)).toEqual([...STANDALONE_QUOTA_KEYS]);
    expect(Object.keys(standaloneLicenseFeaturesSchema.shape)).toEqual([
      ...STANDALONE_FEATURE_KEYS,
    ]);
    expect(STANDALONE_LICENSE_TYP).toBe("markiro-standalone-license+jws");
    expect(STANDALONE_UPDATE_TYP).toBe("markiro-standalone-update+jws");
    expect(STANDALONE_LICENSE_MAX_BYTES).toBe(16 * 1024);
  });

  it("read tenantId and siteId as opaque ids the counterparty chose, case kept", () => {
    expect(STANDALONE_OPAQUE_ID_PATTERN.source).toBe("^[A-Za-z0-9._:-]{1,64}$");
    expect(STANDALONE_OPAQUE_ID_PATTERN.flags).toBe("");
    const parsed = standaloneLicensePayloadV1Schema.parse({
      ...cases.license.base,
      tenantId: "Zq4bL0x9cabinetTenant01",
      siteId: "Site:Main-1",
    });
    // Never lower-cased or trimmed: "Acme" and "acme" are two tenants.
    expect(parsed.tenantId).toBe("Zq4bL0x9cabinetTenant01");
    expect(parsed.siteId).toBe("Site:Main-1");
    expect(standaloneOpaqueIdSchema.parse("Acme")).not.toBe(standaloneOpaqueIdSchema.parse("acme"));
    for (const hostile of ["", "a".repeat(65), "a b", "a\u0000b", "acme\n", "t\u0435nant"]) {
      expect(standaloneOpaqueIdSchema.safeParse(hostile).success).toBe(false);
    }
  });
});

describe("verifyStandaloneLicense", () => {
  const ORIGIN = "https://license.test.invalid";
  const encoder = new TextEncoder();
  const license = cases.license.base;
  const manifest = cases.manifest.base;

  async function setUp() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const keys = [{ kid: "k1", jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) }];
    return { privateKey: pair.privateKey, keyset: { origin: ORIGIN, keys, retiredKids: [] } };
  }

  async function signRaw(privateKey: CryptoKey, payload: Uint8Array) {
    const header = encoder.encode(
      JSON.stringify({ typ: STANDALONE_LICENSE_TYP, alg: "ES256", kid: "k1" }),
    );
    const input = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(input),
    );
    return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  it("returns the license of the keyset's issuer with its kid", async () => {
    const { privateKey, keyset } = await setUp();
    const compact = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      license,
    );
    // A file issued before `customLogo` existed has no such key: it reads as off.
    expect(await verifyStandaloneLicense(compact, keyset)).toEqual({
      ok: true,
      kid: "k1",
      license: { ...license, features: { ...license.features, customLogo: false } },
    });
  });

  it("reads custom branding (customLogo) from a file that carries it", async () => {
    const { privateKey, keyset } = await setUp();
    const branded = { ...license, features: { ...license.features, customLogo: true } };
    const compact = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      branded,
    );
    expect(await verifyStandaloneLicense(compact, keyset)).toEqual({
      ok: true,
      kid: "k1",
      license: branded,
    });
  });

  it("calls malformed, after the signature, another issuer, an unknown field and a payload that is no UTF-8 JSON object", async () => {
    const { privateKey, keyset } = await setUp();
    const malformed = { ok: false, reason: "malformed" };
    const signed = (payload: unknown) =>
      signCompactJws(privateKey, { typ: STANDALONE_LICENSE_TYP, kid: "k1" }, payload);
    expect(
      await verifyStandaloneLicense(await signed(license), {
        ...keyset,
        origin: "https://other.invalid",
      }),
    ).toEqual(malformed);
    expect(await verifyStandaloneLicense(await signed({ ...license, limits: {} }), keyset)).toEqual(
      malformed,
    );
    expect(await verifyStandaloneLicense(await signed(Object.values(license)), keyset)).toEqual(
      malformed,
    );
    const json = encoder.encode(JSON.stringify(license));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
    expect(await verifyStandaloneLicense(await signRaw(privateKey, withBom), keyset)).toEqual(
      malformed,
    );
    expect(
      await verifyStandaloneLicense(
        await signRaw(privateKey, new Uint8Array([0xff, 0xfe])),
        keyset,
      ),
    ).toEqual(malformed);
    // A repeated key keeps its last value, as serde_json read through a Value does.
    const repeated = encoder.encode(`{"graceDays":99,${JSON.stringify(license).slice(1)}`);
    expect((await verifyStandaloneLicense(await signRaw(privateKey, repeated), keyset)).ok).toBe(
      true,
    );
  });

  it("refuses a file above 16 KiB before reading it", async () => {
    const { privateKey, keyset } = await setUp();
    const compact = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      license,
    );
    const oversized = compact + " ".repeat(STANDALONE_LICENSE_MAX_BYTES + 1 - compact.length);
    expect(await verifyStandaloneLicense(oversized, keyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("keeps a license and an update manifest apart by their typ", async () => {
    const { privateKey, keyset } = await setUp();
    const asLicense = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      manifest,
    );
    const asUpdate = await signCompactJws(
      privateKey,
      { typ: STANDALONE_UPDATE_TYP, kid: "k1" },
      manifest,
    );
    const updateKeyset = { keys: keyset.keys, retiredKids: [] };
    expect(await verifyStandaloneUpdateManifest(asUpdate, updateKeyset)).toEqual({
      ok: true,
      kid: "k1",
      manifest,
    });
    expect(await verifyStandaloneUpdateManifest(asLicense, updateKeyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyStandaloneLicense(asUpdate, keyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
