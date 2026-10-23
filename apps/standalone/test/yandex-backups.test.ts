import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { yandexBackupStatusSchema, yandexClientProfileSchema } from "../src/host/yandex-backups.js";
const testModuleUrl = import.meta.url;

describe("Yandex public contract", () => {
  it("reads the Rust disconnected fixture without credential fields", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL("../proto/fixtures/yandex-backup-disconnected.json", testModuleUrl),
        "utf8",
      ),
    );
    const status = yandexBackupStatusSchema.parse(fixture);
    expect(status.state).toBe("disconnected");
    expect(Object.keys(status)).not.toEqual(
      expect.arrayContaining(["accessToken", "refreshToken", "clientSecret"]),
    );
  });
  it("imports only the fixed public customer application profile", () => {
    const profile = {
      format: 1,
      provider: "yandex_disk",
      clientId: "customer-client",
      redirectUri: "http://127.0.0.1:45711/oauth/yandex/callback",
      scopes: ["cloud_api:disk.app_folder", "login:info"],
    };
    expect(yandexClientProfileSchema.parse(profile)).toEqual(profile);
    for (const extra of [
      { clientSecret: "secret" },
      { accessToken: "token" },
      { endpoint: "https://markiro.ru" },
    ]) {
      expect(yandexClientProfileSchema.safeParse({ ...profile, ...extra }).success).toBe(false);
    }
    expect(yandexClientProfileSchema.safeParse({ ...profile, clientId: "../other" }).success).toBe(
      false,
    );
  });
});
