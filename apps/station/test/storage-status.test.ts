import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import i18n from "../src/i18n/index.js";
import {
  pairingUnsafe,
  readStorageStatus,
  storageNoticeKey,
  storageNoticeTone,
  type StorageNotice,
} from "../src/lib/storage-status.js";

const everyNotice: StorageNotice[] = [
  { kind: "legacy_in_use" },
  { kind: "move_failed" },
  { kind: "local_less_durable", reason: "temporary_profile" },
  { kind: "local_less_durable", reason: "mandatory_profile" },
  { kind: "local_less_durable", reason: "delete_roaming_cache" },
  { kind: "roamed_copy_present", sameMachineId: true },
  { kind: "roamed_copy_present", sameMachineId: false },
  { kind: "claim_leftovers" },
];

beforeEach(() => {
  invokeMock.mockReset();
});

describe("readStorageStatus", () => {
  it("returns the status the Rust side reports", async () => {
    const status = {
      dir: "C:\\Users\\op\\AppData\\Local\\app.markiro.station",
      mode: "local",
      notices: everyNotice,
    };
    invokeMock.mockResolvedValue(status);

    await expect(readStorageStatus()).resolves.toEqual({ kind: "ready", status });
    expect(invokeMock).toHaveBeenCalledWith("station_storage_status");
  });

  it("carries the reason a blocked storage gives", async () => {
    // Tauri rejects with the command's `Err(String)` as it is.
    const reason =
      "the station storage record C:\\Users\\op\\AppData\\Local\\app.markiro.station\\station-storage.json is damaged: EOF while parsing an object at line 1 column 1";
    invokeMock.mockRejectedValueOnce(reason);

    await expect(readStorageStatus()).resolves.toEqual({ kind: "blocked", reason });
  });

  it("hides diagnostics instead of failing on another error or an unknown shape", async () => {
    invokeMock.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(readStorageStatus()).resolves.toEqual({ kind: "unknown" });
    invokeMock.mockRejectedValueOnce("");
    await expect(readStorageStatus()).resolves.toEqual({ kind: "unknown" });

    for (const value of [
      undefined,
      null,
      {},
      { dir: "x", mode: "cloud", notices: [] },
      { dir: "x", mode: "local", notices: [{ kind: "new_kind" }] },
    ]) {
      invokeMock.mockResolvedValueOnce(value);
      await expect(readStorageStatus()).resolves.toEqual({ kind: "unknown" });
    }
  });
});

describe("storage notices", () => {
  it("have copy in both languages", () => {
    for (const notice of everyNotice) {
      const key = storageNoticeKey(notice);
      for (const lng of ["ru", "en"]) {
        expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
      }
    }
    for (const key of [
      "storage.title",
      "storage.mode.local",
      "storage.mode.legacy",
      "storage.pairingUnsafe",
      "storage.blocked",
    ]) {
      for (const lng of ["ru", "en"]) {
        expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
      }
    }
  });

  it("flag a possible clone as an error and only sign-out-wiped profiles as unsafe for pairing", () => {
    expect(storageNoticeTone({ kind: "roamed_copy_present", sameMachineId: true })).toBe("error");
    expect(storageNoticeTone({ kind: "legacy_in_use" })).toBe("warn");
    expect(storageNoticeTone({ kind: "claim_leftovers" })).toBe("info");
    expect(pairingUnsafe([{ kind: "local_less_durable", reason: "temporary_profile" }])).toBe(true);
    expect(pairingUnsafe([{ kind: "local_less_durable", reason: "mandatory_profile" }])).toBe(true);
    expect(
      pairingUnsafe([
        { kind: "local_less_durable", reason: "delete_roaming_cache" },
        { kind: "legacy_in_use" },
      ]),
    ).toBe(false);
  });
});
