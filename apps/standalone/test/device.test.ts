import { describe, expect, it, vi } from "vitest";

import { createTauriDeviceApi, DEVICE_ERROR_CODES, DeviceError } from "../src/host/device.js";
import { DEVICE_STATUS } from "./support/fixtures.js";

async function failure(promise: Promise<unknown>): Promise<DeviceError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DeviceError);
  return error as DeviceError;
}

describe("Tauri device API", () => {
  it("reports an unpaired device as null", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await expect(createTauriDeviceApi(call).status()).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith("device_status", {});
  });

  it("validates the pairing the shell reports", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual(DEVICE_STATUS);
  });

  it("pairs locally under the given device name", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    await expect(createTauriDeviceApi(call).pairLocally("Рабочее место хоста")).resolves.toEqual(
      DEVICE_STATUS,
    );
    expect(call).toHaveBeenCalledWith("host_local_pair", { name: "Рабочее место хоста" });
  });

  it("forgets the pairing", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTauriDeviceApi(call).forget();
    expect(call).toHaveBeenCalledWith("device_forget", {});
  });

  it.each(DEVICE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    expect((await failure(createTauriDeviceApi(call).pairLocally("x"))).code).toBe(code);
  });

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("unreachable");
  });

  it("rejects a pairing that does not match the shell's shape", async () => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, deviceKey: "leaked" });
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("invalid_response");
  });
});
