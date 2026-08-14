import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tauriRoot = process.cwd();

describe("packaged station updater contract", () => {
  it("allows locally cached product image object URLs", async () => {
    const config = JSON.parse(await readFile(join(tauriRoot, "src-tauri/tauri.conf.json"), "utf8"));

    expect(config.app.security.csp).toContain("img-src 'self' data: blob:");
  });

  it("pins one beta endpoint, updater artifacts, a real public key and restart only", async () => {
    const config = JSON.parse(await readFile(join(tauriRoot, "src-tauri/tauri.conf.json"), "utf8"));
    const capability = JSON.parse(
      await readFile(join(tauriRoot, "src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.endpoints).toEqual([
      "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json",
    ]);
    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(config.plugins.updater.pubkey).not.toMatch(/replace|example|test/i);
    expect(capability.permissions).toContain("process:allow-restart");
  });

  it("has no operator-controlled updater endpoint command", async () => {
    const [commands, lib] = await Promise.all([
      readFile(join(tauriRoot, "src-tauri/src/commands.rs"), "utf8"),
      readFile(join(tauriRoot, "src-tauri/src/lib.rs"), "utf8"),
    ]);
    expect(commands).not.toMatch(/set_update_endpoint|validate_endpoint_url/);
    expect(lib).not.toMatch(/set_update_endpoint/);
  });
});
