import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  UPDATE_SHELL_CODES,
  UpdateShellError,
  createTauriUpdateShell,
  type FoundPackage,
  type VerifiedReport,
} from "../src/office/info/update-shell.js";

const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";
const PATH = "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0.update.jws";
const MANIFEST: VerifiedReport["manifest"] = {
  v: 1,
  product: "markiro-standalone",
  version: "0.2.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "a".repeat(40),
  installer: {
    name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe",
    sha256: SHA,
    sizeBytes: 29,
  },
  protocol: 3,
  minProtocol: 1,
  minUpgradeFrom: "0.1.0",
  notes: ["Тестовый выпуск 0.2.0"],
};
const FOUND: FoundPackage = {
  path: PATH,
  place: "documents",
  fileName: "markiro-standalone-0.2.0.update.jws",
  manifest: MANIFEST,
  problem: null,
};
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: MANIFEST,
  installed: "0.1.0",
  installerPath: PATH.replace(".update.jws", "-windows-x86_64-setup.exe"),
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.1.0", protocol: 3, minProtocol: 1 },
};

describe("the update commands of the shell", () => {
  it("send the names the shell takes and read the answers it gives", async () => {
    const answers: Record<string, unknown> = {
      update_scan: [
        FOUND,
        { ...FOUND, fileName: "broken.update.jws", manifest: null, problem: "manifest_signature" },
      ],
      update_verify: REPORT,
      update_install: null,
      update_outcome: {
        kind: "not_finished",
        from: "0.1.0",
        to: "0.2.0",
        startedAtMs: 1760000000000,
      },
      update_outcome_dismiss: null,
      update_open_folder: null,
    };
    const call = vi.fn(async (command: string) => answers[command]);
    const shell = createTauriUpdateShell(call);
    expect(await shell.scan()).toEqual(answers.update_scan);
    expect(await shell.verify(PATH)).toEqual(REPORT);
    await expect(shell.install(PATH, ["reinstall"])).resolves.toBeUndefined();
    expect(await shell.outcome()).toEqual(answers.update_outcome);
    await shell.dismissOutcome();
    await shell.openFolder();
    expect(call.mock.calls).toEqual([
      ["update_scan", {}],
      ["update_verify", { path: PATH }],
      ["update_install", { path: PATH, confirm: ["reinstall"] }],
      ["update_outcome", {}],
      ["update_outcome_dismiss", {}],
      ["update_open_folder", {}],
    ]);
  });

  it("read no outcome as null, and refuse an answer of another shape", async () => {
    expect(await createTauriUpdateShell(async () => null).outcome()).toBeNull();
    await expect(
      createTauriUpdateShell(async () => [
        { ...FOUND, manifest: { ...MANIFEST, extra: true } },
      ]).scan(),
    ).rejects.toThrow();
    await expect(
      createTauriUpdateShell(async () => ({ ...REPORT, refusal: { code: "too_old" } })).verify(
        PATH,
      ),
    ).rejects.toThrow();
  });

  it("turn a bare code into its error, and anything else into unsupported", async () => {
    for (const [rejection, code] of [
      ["uac_cancelled", "uac_cancelled"],
      ["installer_mismatch", "installer_mismatch"],
      ["confirmation_required", "confirmation_required"],
      ["something new", "unsupported"],
      [new Error("no Tauri here"), "unsupported"],
    ] as const) {
      const shell = createTauriUpdateShell(async () => {
        throw rejection;
      });
      const error = await shell.install(PATH, []).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(UpdateShellError);
      expect(error instanceof UpdateShellError ? error.code : null).toBe(code);
    }
  });
});

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

describe("the refusal codes", () => {
  it("are the ones the shell's UpdateError gives, in its order (src-tauri/tests/fixtures/update-error-codes.json)", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL("../src-tauri/tests/fixtures/update-error-codes.json", testModuleUrl),
        "utf8",
      ),
    );
    expect([...UPDATE_SHELL_CODES]).toEqual(fixture);
  });
});
