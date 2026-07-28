import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pwaOptions } from "../vite.config.js";

// jsdom has no service-worker registry, no install prompt and no Cache
// Storage, so a runtime test here would prove nothing about the shipped PWA.
// What IS worth pinning down is the configuration the plugin turns into
// `manifest.webmanifest` and `sw.js` — that object is the whole contract.
const { manifest, workbox } = pwaOptions;

/**
 * Width and height straight out of the PNG IHDR chunk (8-byte signature,
 * 8-byte chunk header, then two big-endian uint32s). Reading the real file
 * keeps the manifest honest: a zero-byte or wrongly-sized placeholder would
 * still satisfy an assertion about the manifest alone.
 */
function readPng(relativePath: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)));
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.byteLength,
  };
}

describe("kiosk PWA manifest", () => {
  it("is a fullscreen kiosk app in either orientation", () => {
    // The kiosk runs chromeless on a wall-mounted tablet; `orientationOf` in
    // Cart.tsx lays out both 1180x800 and 800x1180, so the manifest must not
    // lock the device to one of them.
    expect(manifest.display).toBe("fullscreen");
    expect(manifest.orientation).toBe("any");
  });

  it("starts at the app root", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  it("paints the splash in the dark floor theme", () => {
    // --surface-page under [data-theme="dark"] in @markiro/ui tokens.css.
    expect(manifest.theme_color).toBe("#131216");
    expect(manifest.background_color).toBe("#131216");
  });

  it("ships three real icons, one of them maskable", () => {
    expect(manifest.icons).toHaveLength(3);
    expect(manifest.icons.map((icon) => icon.type)).toEqual([
      "image/png",
      "image/png",
      "image/png",
    ]);
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);

    const maskable = manifest.icons.filter((icon) => icon.purpose === "maskable");
    expect(maskable).toHaveLength(1);

    for (const icon of manifest.icons) {
      const [declaredWidth, declaredHeight] = icon.sizes.split("x").map(Number);
      const png = readPng(`../public${icon.src}`);
      expect(png.width).toBe(declaredWidth);
      expect(png.height).toBe(declaredHeight);
      expect(png.bytes).toBeGreaterThan(0);
    }
  });
});

describe("kiosk service worker", () => {
  it("updates itself without anyone touching the device", () => {
    expect(pwaOptions.registerType).toBe("autoUpdate");
  });

  it("precaches the built shell", () => {
    const globs = workbox.globPatterns.join(" ");
    expect(globs).toMatch(/\bhtml\b/);
    expect(globs).toMatch(/\bjs\b/);
    expect(globs).toMatch(/\bcss\b/);
    expect(workbox.navigateFallback).toBe("index.html");
  });

  it("never caches /api/ — not the navigation fallback, not at runtime", () => {
    // The offline story is the IndexedDB snapshot. An HTTP cache in front of
    // POST /kiosk/orders would either replay a submission or hide one.
    expect(workbox.runtimeCaching).toEqual([]);

    const denylist = workbox.navigateFallbackDenylist;
    expect(denylist.some((pattern) => pattern.test("/api/kiosk/orders"))).toBe(true);
    expect(denylist.some((pattern) => pattern.test("/api/kiosk/bootstrap"))).toBe(true);
    expect(denylist.some((pattern) => pattern.test("/settings/scanner"))).toBe(false);
  });
});
