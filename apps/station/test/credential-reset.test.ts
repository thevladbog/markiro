import { describe, expect, it, vi } from "vitest";
import {
  resetCredentialForPairing,
  type RunConfigTransition,
} from "../src/lib/credential-reset.js";

describe("resetCredentialForPairing", () => {
  it("rejects every legacy keyed config before clear can run", async () => {
    const clearCredential = vi.fn(async () => {});
    const readConfig = vi.fn(async () => ({ machineId: "legacy-machine" }));
    let transitionStarted = false;
    const runTransition: RunConfigTransition = async (transition, publish) => {
      transitionStarted = true;
      const value = await transition();
      publish(value);
      return value;
    };

    await expect(
      resetCredentialForPairing(
        {
          machineId: "legacy-machine",
          apiKey: "legacy-key",
          serverUrl: "https://api.factory.example",
        },
        { clearCredential, readConfig, runTransition },
      ),
    ).rejects.toThrow("legacy station identity is not durable");

    expect(transitionStarted).toBe(false);
    expect(clearCredential).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });
});
