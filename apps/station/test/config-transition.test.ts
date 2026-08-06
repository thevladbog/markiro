import { describe, expect, it, vi } from "vitest";
import { ConfigTransitionCoordinator } from "../src/lib/config-transition.js";

describe("ConfigTransitionCoordinator", () => {
  it("does not write or publish an identity result after a newer config generation starts", async () => {
    const coordinator = new ConfigTransitionCoordinator();
    const legacyGeneration = coordinator.begin();
    const currentConfig = { apiKey: "new-key", deviceId: "new-device" };
    const writeLegacy = vi.fn(async () => ({ apiKey: "old-key", deviceId: "old-device" }));
    const publishLegacy = vi.fn();

    const newerGeneration = coordinator.begin();
    await coordinator.commit({
      generation: newerGeneration,
      isOriginCurrent: () => true,
      transition: async () => currentConfig,
      publish: () => {},
    });
    const result = await coordinator.commit({
      generation: legacyGeneration,
      isOriginCurrent: () => true,
      transition: writeLegacy,
      publish: publishLegacy,
    });

    expect(result).toBe("stale");
    expect(writeLegacy).not.toHaveBeenCalled();
    expect(publishLegacy).not.toHaveBeenCalled();
    expect(currentConfig).toEqual({ apiKey: "new-key", deviceId: "new-device" });
  });

  it("serializes a reset behind an identity write so a raced response cannot resurrect the key", async () => {
    const coordinator = new ConfigTransitionCoordinator();
    const durableConfig: { apiKey?: string; deviceId?: string } = { apiKey: "legacy-key" };
    const queue = [{ id: 1, payload: "exact-local-fact" }];
    const originalQueue = JSON.stringify(queue);
    let releaseIdentityWrite!: () => void;
    let identityWriteStarted!: () => void;
    const identityStarted = new Promise<void>((resolve) => {
      identityWriteStarted = resolve;
    });
    const identityWrite = new Promise<void>((resolve) => {
      releaseIdentityWrite = resolve;
    });
    const published: string[] = [];

    const identityGeneration = coordinator.begin();
    const identityCommit = coordinator.commit({
      generation: identityGeneration,
      isOriginCurrent: () => true,
      transition: async () => {
        identityWriteStarted();
        await identityWrite;
        durableConfig.apiKey = "legacy-key";
        durableConfig.deviceId = "legacy-device";
        return { ...durableConfig };
      },
      publish: () => published.push("identity"),
    });
    await identityStarted;

    const resetGeneration = coordinator.begin();
    const resetCommit = coordinator.commit({
      generation: resetGeneration,
      isOriginCurrent: () => true,
      transition: async () => {
        delete durableConfig.apiKey;
        return { ...durableConfig };
      },
      publish: () => published.push("reset"),
    });
    releaseIdentityWrite();

    await expect(identityCommit).resolves.toBe("stale");
    await expect(resetCommit).resolves.toBe("committed");
    expect(durableConfig).toEqual({ deviceId: "legacy-device" });
    expect(published).toEqual(["reset"]);
    expect(JSON.stringify(queue)).toBe(originalQueue);
  });

  it("seals an unmounted identity attempt before its durable write starts", async () => {
    const coordinator = new ConfigTransitionCoordinator();
    const generation = coordinator.begin();
    const write = vi.fn(async () => undefined);
    coordinator.seal();

    const result = await coordinator.commit({
      generation,
      isOriginCurrent: () => true,
      transition: write,
      publish: () => {},
    });

    expect(result).toBe("stale");
    expect(write).not.toHaveBeenCalled();
  });
});
