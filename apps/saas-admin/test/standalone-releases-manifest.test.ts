import { describe, expect, it } from "vitest";

import { readManifestText, selectionIssues } from "../src/pages/standalone-releases/manifest.js";
import {
  INSTALLER_BYTES,
  INSTALLER_SHA,
  SOURCE_SHA,
  manifestJws,
} from "./standalone-releases-fixtures.js";

describe("standalone release manifest preview", () => {
  it("decodes the base64url payload, including Cyrillic notes", () => {
    const reading = readManifestText(`${manifestJws()}\n`);
    expect(reading).toEqual({
      ok: true,
      preview: {
        sourceSha: SOURCE_SHA,
        version: "0.7.0",
        channel: "stable",
        installer: {
          name: "markiro-standalone-0.7.0-windows-x86_64-setup.exe",
          sha256: INSTALLER_SHA,
          sizeBytes: INSTALLER_BYTES.length,
        },
        notes: ["Печать на втором принтере"],
      },
    });
  });

  it.each([
    ["one part", "abc", "not_jws"],
    ["an empty signature", "a.b.", "not_jws"],
    ["a payload outside base64url", "a.b+c.d", "not_jws"],
    [
      "a payload that is not JSON",
      `a.${Buffer.from("nope").toString("base64url")}.c`,
      "unreadable",
    ],
    ["a payload without a version", `a.${Buffer.from("{}").toString("base64url")}.c`, "unreadable"],
  ])("refuses %s", (_label, text, problem) => {
    expect(readManifestText(text)).toEqual({ ok: false, problem });
  });

  it("refuses a manifest of another product", () => {
    expect(readManifestText(manifestJws({ product: "markiro-station" }))).toEqual({
      ok: false,
      problem: "wrong_product",
    });
  });

  it("blocks a size difference and only warns about renamed files", () => {
    const reading = readManifestText(manifestJws());
    if (!reading.ok) throw new Error("expected a preview");
    expect(
      selectionIssues(
        reading.preview,
        { name: "markiro-standalone-0.7.0 (1).update.jws" },
        { name: "setup.exe", size: INSTALLER_BYTES.length + 1 },
      ).map((issue) => [issue.kind, issue.blocking]),
    ).toEqual([
      ["manifest_name", false],
      ["installer_size", true],
      ["installer_name", false],
    ]);
  });
});
