import { describe, expect, it, vi } from "vitest";

import { createTauriHostProbe, HostProbeError } from "../src/host/probe.js";

const RAW = {
  hello: {
    product: "markiro-host",
    protocol: 1,
    minProtocol: 1,
    hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    version: "0.1.0",
    time: "2026-09-26T09:15:00Z",
    initialized: false,
  },
  fingerprint: "0f".repeat(32),
};

describe("Tauri host probe", () => {
  it("asks the Rust shell for hello at the address and validates the answer", async () => {
    const call = vi.fn().mockResolvedValue(RAW);
    await expect(createTauriHostProbe(call).hello("https://127.0.0.1:45710")).resolves.toEqual(RAW);
    expect(call).toHaveBeenCalledWith("host_hello", { address: "https://127.0.0.1:45710" });
  });

  it.each(["unreachable", "not_markiro_host", "invalid_response"] as const)(
    "keeps the shell's %s code",
    async (code) => {
      const call = vi.fn().mockRejectedValue(code);
      await expect(createTauriHostProbe(call).hello("https://h")).rejects.toMatchObject({ code });
    },
  );

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(createTauriHostProbe(call).hello("https://h")).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("rejects a malformed answer", async () => {
    const call = vi.fn().mockResolvedValue({ ...RAW, fingerprint: "XYZ" });
    const error: unknown = await createTauriHostProbe(call)
      .hello("https://h")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostProbeError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });
});
