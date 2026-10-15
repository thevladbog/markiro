import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { deflateRawSync } from "node:zlib";

/** `MKS1.<kid>.<base64url(flag ‖ epk ‖ iv ‖ ciphertext ‖ tag)>`, written again from the format's description. */
export function sealSupportToken(
  plain: string | Buffer,
  recipient: KeyObject,
  kid: string,
  compress = true,
): string {
  const data = Buffer.from(plain);
  const body = compress ? deflateRawSync(data) : data;
  const flag = Buffer.from([compress ? 1 : 0]);
  const ephemeral = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = ephemeral.publicKey.export({ format: "jwk" });
  const epk = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
  const label = Buffer.from(`MKS1.${kid}`, "utf8");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([label, epk]), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.concat([label, flag]));
  const sealed = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return `MKS1.${kid}.${Buffer.concat([flag, epk, iv, sealed]).toString("base64url")}`;
}

export const TOKEN_OFFSETS = { flag: 0, epk: 1, iv: 66, sealed: 78 } as const;

/** The token with one byte of its body changed (xor 1). */
export function flipTokenByte(token: string, at: number): string {
  const [version, kid, body] = token.split(".");
  const bytes = Buffer.from(body ?? "", "base64url");
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return `${version}.${kid}.${bytes.toString("base64url")}`;
}

/** The token with the same bytes in a non-canonical base64url (unused trailing bits changed). */
export function nonCanonicalToken(token: string): string {
  const [version, kid, body = ""] = token.split(".");
  if (body.length % 4 === 0) throw new Error("this token has no unused bits");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(body.at(-1) ?? "");
  return `${version}.${kid}.${body.slice(0, -1)}${alphabet[last ^ 1]}`;
}

/** A month as the client sends it, for payload fixtures. */
export function usageMonth(month: string, accepted = 7020) {
  return {
    month,
    shifts: {
      aggregation: 6,
      validation: 1,
      validationPrint: 0,
      fromOffice: 5,
      fromStation: 2,
      withPallets: 2,
    },
    scans: { accepted, duplicates: 64, rejected: 9 },
    boxes: { closed: 585, disassembled: 0, codes: accepted },
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
  };
}

export const SUPPORT_LICENSE = {
  state: "active",
  plan: "subscription",
  licenseId: "11111111-2222-4333-8444-555555555555",
  sequence: 3,
  kid: "lic-1",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2027-10-01T00:00:00Z",
  graceDays: 14,
  daysLeft: 350,
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 3, used: 2, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 5, used: 1, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: false,
    handheld: true,
    customLogo: false,
  },
  innMatches: true,
};

export function supportPayloadV2(
  overrides: { hostId?: string | null; generatedAt?: string; months?: string[] } = {},
) {
  return {
    v: 2,
    generatedAt: overrides.generatedAt ?? "2026-10-14T09:00:00.000Z",
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    months: (overrides.months ?? ["2026-09", "2026-10"]).map((month) => usageMonth(month)),
    devices: { station: 3, office: 2, handheld: 1 },
    hostId:
      overrides.hostId === undefined ? "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" : overrides.hostId,
    role: "host",
    os: "Windows 11",
    arch: "x64",
    webview: "WebView2 130.0.2849.80",
    license: SUPPORT_LICENSE,
  };
}

export function supportPayloadV1(generatedAt = "2026-10-14T09:00:00.000Z") {
  return {
    v: 1,
    generatedAt,
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    months: [usageMonth("2026-10")],
    devices: { station: 3, office: 2, handheld: 1 },
  };
}

/** A support text as the client builds it: an open part and the token on its own line. */
export function supportText(token: string): string {
  return [
    "Markiro Автоном — сведения для поддержки",
    "Сформировано (UTC): 2026-10-14T09:00:00.000Z",
    "",
    "Версия приложения: 0.2.0",
    "Хост: https://127.0.0.1:45710 (id 3f1c2d4e)",
    "",
    "Данные для анализа",
    "Зашифрованные данные",
    token,
    "",
  ].join("\r\n");
}
