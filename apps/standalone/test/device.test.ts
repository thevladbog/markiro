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

  it("accepts a pairing whose device name is not known yet", async () => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, deviceName: null });
    await expect(createTauriDeviceApi(call).status()).resolves.toEqual({
      ...DEVICE_STATUS,
      deviceName: null,
    });
  });

  it.each([
    ["without the device name", { deviceName: undefined }],
    ["with an empty device name", { deviceName: "" }],
  ])("rejects a pairing %s", async (_case, change) => {
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, ...change });
    expect((await failure(createTauriDeviceApi(call).status())).code).toBe("invalid_response");
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

  it("forgets despite unsent records only when asked to keep them", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTauriDeviceApi(call).forget({ keepUnsent: true });
    expect(call).toHaveBeenLastCalledWith("device_forget", { keepUnsent: true });
    await createTauriDeviceApi(call).forget({ keepUnsent: false });
    expect(call).toHaveBeenLastCalledWith("device_forget", {});
  });

  it("keeps the shell's refusal while unsent records remain", async () => {
    const call = vi.fn().mockRejectedValue("unsent_facts");
    expect((await failure(createTauriDeviceApi(call).forget())).code).toBe("unsent_facts");
  });

  it("pairs by code with the host's address, the confirmed fingerprint and a name", async () => {
    const call = vi.fn().mockResolvedValue(DEVICE_STATUS);
    const input = {
      address: "https://192.168.1.10:45710",
      fingerprint: "ab".repeat(32),
      code: "7KQ2M9XRTD",
      name: "Станция на линии 2",
    };
    await expect(createTauriDeviceApi(call).claim(input)).resolves.toEqual(DEVICE_STATUS);
    expect(call).toHaveBeenCalledWith("host_claim", input);
  });

  it("reads the installer's role, and null in a development build", async () => {
    for (const role of ["host", "station", "office", null] as const) {
      const call = vi.fn().mockResolvedValue(role);
      await expect(createTauriDeviceApi(call).installRole()).resolves.toBe(role);
      expect(call).toHaveBeenCalledWith("install_role", {});
    }
    const call = vi.fn().mockResolvedValue("admin");
    expect((await failure(createTauriDeviceApi(call).installRole())).code).toBe("invalid_response");
  });

  it("moves the pairing to the host's new address", async () => {
    const address = "https://192.168.1.20:45710";
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, hostAddress: address });
    await expect(createTauriDeviceApi(call).changeAddress(address)).resolves.toEqual({
      ...DEVICE_STATUS,
      hostAddress: address,
    });
    expect(call).toHaveBeenCalledWith("device_change_address", { address });
    const refused = vi.fn().mockRejectedValue("address_other_host");
    expect((await failure(createTauriDeviceApi(refused).changeAddress(address))).code).toBe(
      "address_other_host",
    );
  });

  it("keeps the typed address out of what a refused address change raises", async () => {
    const address = "https://192.168.1.77:45710";
    for (const code of ["unreachable", "address_other_host", "invalid_request"] as const) {
      const call = vi.fn().mockRejectedValue(code);
      const error = await failure(createTauriDeviceApi(call).changeAddress(address));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("192.168.1.77");
    }
  });

  it("selects the station's line", async () => {
    const lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, lineId });
    await expect(createTauriDeviceApi(call).selectLine(lineId)).resolves.toEqual({
      ...DEVICE_STATUS,
      lineId,
    });
    expect(call).toHaveBeenCalledWith("device_select_line", { lineId });
  });

  it("reads the device again from the host, with the line the office assigned", async () => {
    const lineId = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, lineId });
    const { refresh } = createTauriDeviceApi(call);
    // Unbound on purpose: `useHostLink` receives the function on its own.
    await expect(refresh()).resolves.toEqual({ ...DEVICE_STATUS, lineId });
    expect(call).toHaveBeenCalledWith("device_refresh", {});
  });

  it("keeps the shell's reason when the host refuses the key on a refresh", async () => {
    const call = vi.fn().mockRejectedValue("key_rejected");
    expect((await failure(createTauriDeviceApi(call).refresh())).code).toBe("key_rejected");
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
