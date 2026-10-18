import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { openSupportBlob } from "../../api/src/modules/standalone-diagnostics/support-blob";
import { standaloneSupportPayloadSchema } from "../../../packages/platform-contracts/src/standalone-support";
import { decryptBlob, findBlob } from "../../../tools/standalone-support/decrypt.mjs";
import { standaloneActivationRequestSchema } from "@markiro/domain";
import type { AboutApi } from "../src/office/info/about-api.js";
import { activationWithUsage } from "../src/office/info/license/activation-usage.js";
import { fakeHostApi } from "./support/office.js";
import { usageStatsSchema } from "../src/host/usage-stats.js";
import { encryptSupportPayload } from "../src/office/info/support-crypto.js";
import { createUsageToken, usagePayload } from "../src/office/info/support-usage.js";
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

  it("enriches activation exports with fresh encrypted support data while retaining legacy fallbacks", async () => {
    const request = standaloneActivationRequestSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../packages/domain/fixtures/standalone-license/activation-request.json",
            testModuleUrl,
          ),
          "utf8",
        ),
      ),
    );
    const api = fakeHostApi({
      getUsageStats: vi.fn(async () => stats),
      getLicense: vi.fn(async () => ACTIVE_LICENSE),
    });
    const about: AboutApi = {
      appVersion: async () => "0.2.0",
      installRole: async () => "host",
      pairing: async () => null,
      hello: async () => {
        throw new Error("unavailable");
      },
      system: async () => ({ os: "Windows 11", arch: "x64", webview: "WebView2 130.0.2849.80" }),
      openLink: async () => undefined,
    };
    const keyset = { keys: [key], retiredKids: [] };
    const exported = await activationWithUsage(request, api, "session", about, keyset);
    expect(exported.supportToken).toMatch(/^MKS1\.sup-parity\./);
    const opened = standaloneSupportPayloadSchema.parse(
      decryptBlob(exported.supportToken ?? "", pem).json,
    );
    expect(opened).toEqual(
      JSON.parse(
        usagePayload(stats, {
          generatedAt: new Date(opened.generatedAt),
          appVersion: "0.2.0",
          hostVersion: request.hostVersion,
          hostId: request.hostId,
          role: "host",
          os: "Windows 11",
          arch: "x64",
          webview: "WebView2 130.0.2849.80",
          license: ACTIVE_LICENSE,
        }),
      ),
    );
    expect(api.getUsageStats).toHaveBeenCalledWith("session");
    expect(
      await activationWithUsage(request, api, "session", about, { keys: [], retiredKids: [] }),
    ).toBe(request);
    api.getLicense.mockRejectedValue(new Error("license unavailable"));
    const withoutLicense = await activationWithUsage(request, api, "session", about, keyset);
    expect(decryptBlob(withoutLicense.supportToken ?? "", pem).json).toMatchObject({
      license: null,
      months: stats.months,
    });
    api.getUsageStats.mockRejectedValue(new Error("statistics unavailable"));
    expect(await activationWithUsage(request, api, "session", about, keyset)).toBe(request);
  });

  it("reuses the exact support payload allowlist for activation export tokens", async () => {
    const about = {
      generatedAt: new Date("2026-10-14T09:00:00Z"),
      appVersion: "0.2.0",
      hostVersion: "0.2.0",
      hostId: HOST_ID,
      role: "host" as const,
      os: "Windows 11",
      arch: "x64",
      webview: "WebView2 130.0.2849.80",
      license: ACTIVE_LICENSE,
    };
    const opaque = await createUsageToken(stats, about, { keys: [key], retiredKids: [] });
    expect(opaque).not.toBeNull();
    expect(decryptBlob(opaque ?? "", pem).json).toEqual(JSON.parse(payload));
    expect(await createUsageToken(stats, about, { keys: [], retiredKids: [] })).toBeNull();
  });

  it.each([true, false])(
    "the app's writer (compress: %s) is opened identically by the cloud and by the maker's tool",
    async (compress) => {
      const token = await encryptSupportPayload(payload, key, {
        compress,
        subtle: crypto.subtle,
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
