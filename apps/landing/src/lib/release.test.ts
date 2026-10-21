import { describe, expect, it } from "vitest";

import {
  formatInstallerSize,
  formatReleaseDate,
  hashCommand,
  LATEST_RELEASE_URL,
  parseLatestRelease,
} from "./release";

const SHA = "3f9c1e7a52d84b06c9e1f3a7d20b5e8c41f6a9d3b7e2c05f18a4d6b9e3c7f201";

function latest(overrides: Record<string, unknown> = {}, installer: Record<string, unknown> = {}) {
  return {
    v: 1,
    product: "markiro-standalone",
    channel: "stable",
    version: "0.4.0",
    releasedAt: "2026-11-02T10:00:00Z",
    installer: {
      url: "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
      sha256: SHA,
      sizeBytes: 61_234_567,
      ...installer,
    },
    manifestUrl:
      "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0.update.jws",
    notes: ["Первый выпуск"],
    ...overrides,
  };
}

describe("latest standalone release", () => {
  it("reads the pointer from the public release bucket", () => {
    expect(LATEST_RELEASE_URL).toBe("https://releases.markiro.app/standalone/stable/latest.json");
    expect(parseLatestRelease(latest())).toEqual({
      version: "0.4.0",
      releasedAt: "2026-11-02T10:00:00Z",
      installerUrl:
        "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
      fileName: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
      sha256: SHA,
      sizeBytes: 61_234_567,
      notes: ["Первый выпуск"],
    });
  });

  it.each([
    ["another product", latest({ product: "markiro-station" })],
    ["a beta channel", latest({ channel: "beta" })],
    ["an unknown format", latest({ v: 2 })],
    ["a missing installer", latest({ installer: undefined })],
    ["an upper-case hash", latest({}, { sha256: SHA.toUpperCase() })],
    ["a short hash", latest({}, { sha256: SHA.slice(1) })],
    ["a fractional size", latest({}, { sizeBytes: 1.5 })],
    [
      "a link on another host",
      latest(
        {},
        {
          url: "https://evil.example/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
        },
      ),
    ],
    [
      "a plain-http link",
      latest(
        {},
        {
          url: "http://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
        },
      ),
    ],
    [
      "a link to another version",
      latest(
        {},
        {
          url: "https://releases.markiro.app/standalone/stable/0.3.0/markiro-standalone-0.3.0-windows-x86_64-setup.exe",
        },
      ),
    ],
    [
      "a non-installer file",
      latest({}, { url: "https://releases.markiro.app/standalone/stable/0.4.0/payload.zip" }),
    ],
    ["a broken date", latest({ releasedAt: "вчера" })],
    ["not an object", "<html>"],
  ])("refuses %s", (_name, value) => {
    expect(parseLatestRelease(value)).toBeNull();
  });

  it("prints the Moscow date, binary megabytes and the PowerShell check", () => {
    expect(formatReleaseDate("2026-10-17T22:30:00Z")).toBe("18.10.2026");
    expect(formatInstallerSize(61_234_567)).toBe("58 МБ");
    expect(hashCommand("markiro-standalone-0.4.0-windows-x86_64-setup.exe")).toBe(
      "Get-FileHash .\\markiro-standalone-0.4.0-windows-x86_64-setup.exe -Algorithm SHA256",
    );
  });
});
