import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tauriRoot = process.cwd();

describe("packaged station updater contract", () => {
  it("allows locally cached product image object URLs", async () => {
    const config = JSON.parse(await readFile(join(tauriRoot, "src-tauri/tauri.conf.json"), "utf8"));

    expect(config.app.security.csp).toContain("img-src 'self' data: blob:");
  });

  it("pins ordered beta and stable release origins with one unchanged public key", async () => {
    const [config, stableConfig] = await Promise.all([
      readFile(join(tauriRoot, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
      readFile(join(tauriRoot, "src-tauri/tauri.stable.conf.json"), "utf8").then(JSON.parse),
    ]);

    const publicKey =
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVEQ0ZDNzNGOTg0QUE5RjkKUldUNXFVcVlQOGZQN1ptZW0zdmtpbCtQTW85M21wNGUrNHJNeUFja2JhZm5lM0pSZG4wUzFLcVgK";

    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/station/beta/latest.json",
      "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json",
    ]);
    expect(stableConfig.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/station/stable/latest.json",
      "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json",
    ]);
    expect(config.plugins.updater.pubkey).toBe(publicKey);
    expect(stableConfig.plugins.updater).not.toHaveProperty("pubkey");
  });

  it("exposes only Station-owned updater commands while retaining restart permission", async () => {
    const [capability, lib, updater] = await Promise.all([
      readFile(join(tauriRoot, "src-tauri/capabilities/default.json"), "utf8").then(JSON.parse),
      readFile(join(tauriRoot, "src-tauri/src/lib.rs"), "utf8"),
      readFile(join(tauriRoot, "src-tauri/src/updater.rs"), "utf8"),
    ]);

    const updaterCommands = Array.from(
      lib.matchAll(/updater::(station_update_[a-z_]+)/g),
      (match) => match[1],
    );

    expect(updaterCommands).toEqual([
      "station_update_check",
      "station_update_download_and_install",
    ]);
    expect(
      capability.permissions.filter((permission: string) => permission.startsWith("updater:")),
    ).toEqual([]);
    expect(capability.permissions).toContain("process:allow-restart");
    expect(updater).not.toMatch(/std::env::(?:var|var_os)|set_update_endpoint|allow_downgrades/);
  });

  it("keeps the updater artifact and signing-key contract", async () => {
    const config = JSON.parse(await readFile(join(tauriRoot, "src-tauri/tauri.conf.json"), "utf8"));
    const capability = JSON.parse(
      await readFile(join(tauriRoot, "src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(config.plugins.updater.pubkey).not.toMatch(/replace|example|test/i);
    expect(capability.permissions).toContain("process:allow-restart");
  });

  it("has no operator-controlled updater endpoint command", async () => {
    const [commands, lib, updater] = await Promise.all([
      readFile(join(tauriRoot, "src-tauri/src/commands.rs"), "utf8"),
      readFile(join(tauriRoot, "src-tauri/src/lib.rs"), "utf8"),
      readFile(join(tauriRoot, "src-tauri/src/updater.rs"), "utf8"),
    ]);
    expect(commands).not.toMatch(/set_update_endpoint|validate_endpoint_url/);
    expect(lib).not.toMatch(/set_update_endpoint/);
    expect(updater).not.toMatch(/set_update_endpoint|validate_endpoint_url/);
  });
});
