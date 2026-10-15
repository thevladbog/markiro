import { generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openSupportBlob } from "../../api/src/modules/standalone-diagnostics/support-blob";
import { standaloneSupportPayloadSchema } from "../../../packages/platform-contracts/src/standalone-support";
import { decryptBlob, findBlob } from "../../../tools/standalone-support/decrypt.mjs";
import { usageStatsSchema } from "../src/host/usage-stats.js";
import { encryptSupportPayload } from "../src/office/info/support-crypto.js";
import { usagePayload } from "../src/office/info/support-usage.js";
import { ACTIVE_LICENSE } from "./support/license.js";

const testModuleUrl = import.meta.url;
const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

describe("one token, three readers (plan ДИАГ Ч1)", () => {
  const stats = usageStatsSchema.parse(
    JSON.parse(readFileSync(new URL("../proto/fixtures/usage-stats.json", testModuleUrl), "utf8")),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = {
    kid: "sup-parity",
    jwk: { kty: "EC" as const, crv: "P-256" as const, x: String(jwk.x), y: String(jwk.y) },
  };
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const payload = usagePayload(stats, {
    generatedAt: new Date("2026-10-14T09:00:00Z"),
    appVersion: "0.2.0",
    hostVersion: "0.2.0",
    hostId: HOST_ID,
    role: "host",
    os: "Windows 11",
    arch: "x64",
    webview: "WebView2 130.0.2849.80",
    license: ACTIVE_LICENSE,
  });

  it.each([true, false])(
    "the app's writer (compress: %s) is opened identically by the cloud and by the maker's tool",
    async (compress) => {
      const token = await encryptSupportPayload(payload, key, {
        compress,
        subtle: webcrypto.subtle,
      });
      const text = `Сведения для поддержки\r\nДанные для анализа\r\nЗашифрованные данные\r\n${token}\r\n`;

      const cloud = openSupportBlob(text, [{ kid: "sup-parity", privateKey }]);
      const tool = decryptBlob(findBlob(text), pem);

      expect(cloud.ok).toBe(true);
      if (!cloud.ok) throw new Error("the cloud did not open the app's token");
      expect(cloud.json).toEqual(JSON.parse(payload));
      expect(tool.json).toEqual(cloud.json);
      expect(cloud.compressed).toBe(compress);
      // And the cloud's strict schema takes exactly what the app writes.
      const parsed = standaloneSupportPayloadSchema.parse(cloud.json);
      expect(parsed).toMatchObject({ v: 2, hostId: HOST_ID, role: "host", os: "Windows 11" });
    },
  );
});
