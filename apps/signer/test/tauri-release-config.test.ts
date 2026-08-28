import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Captured in a variable rather than inlined: Vite statically detects the
// `new URL(x, import.meta.url)` literal pattern and rewrites it as a dev-server
// asset URL, which breaks resolution for these non-bundled config files.
const moduleUrl = import.meta.url;

// These are arbitrary parsed JSON config files; a precise type would just
// re-describe the Tauri config schema for no benefit to the assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, moduleUrl), "utf8"));

describe("signer release configuration", () => {
  const base = read("tauri.conf.json");
  const stable = read("tauri.stable.conf.json");
  const capabilities = read("capabilities/default.json");

  it("produces updater artifacts from the NSIS bundle only", () => {
    expect(base.bundle.createUpdaterArtifacts).toBe(true);
    expect(base.bundle.targets).toEqual(["nsis"]);
  });

  it("pins the identifier and the beta endpoint", () => {
    expect(base.identifier).toBe("app.markiro.signer");
    expect(base.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/signer/beta/latest.json",
    ]);
  });

  it("keeps one public key, declared only in the base config", () => {
    expect(typeof base.plugins.updater.pubkey).toBe("string");
    expect(stable.plugins.updater).not.toHaveProperty("pubkey");
    expect(stable.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/signer/stable/latest.json",
    ]);
  });

  it("starts hidden so the agent lives in the tray", () => {
    expect(base.app.windows[0].visible).toBe(false);
  });

  it("does not let the webview reach the network directly", () => {
    // Every cloud and True API call happens in Rust; a webview that could
    // reach https: would be a way to exfiltrate a token from the UI layer.
    expect(base.app.security.csp).not.toContain("https:");
  });

  it("grants the webview no filesystem or shell capability", () => {
    for (const permission of capabilities.permissions) {
      expect(permission).not.toMatch(/^(fs|shell|http):/);
    }
  });
});
