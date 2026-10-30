import { describe, expect, it, vi } from "vitest";
import {
  createOnlineUpdatesApi,
  OnlineUpdateError,
} from "../src/office/info/online-updates-api.js";

const offer = {
  manifest: {
    version: "1.2.0",
    channel: "stable",
    releasedAt: "2026-10-30T10:00:00Z",
    notes: ["Исправления"],
    minUpgradeFrom: "1.0.0",
    protocol: 3,
    minProtocol: 2,
    sizeBytes: 100,
  },
  newer: true,
  compatible: true,
};

describe("online update shell contract", () => {
  it("checks only on request and unsubscribes after download", async () => {
    const call = vi.fn(async (command: string) =>
      command === "update_online_check"
        ? offer
        : {
            version: "1.2.0",
            manifestPath: "/online/1.2.0/markiro-standalone-1.2.0.update.jws",
            sizeBytes: 100,
          },
    );
    const stop = vi.fn();
    const subscribe = vi.fn(
      async (_event: string, handler: (event: { payload: unknown }) => void) => {
        handler({ payload: { received: 50, total: 100 } });
        return stop;
      },
    );
    const api = createOnlineUpdatesApi(call, subscribe);
    expect(call).not.toHaveBeenCalled();
    expect(await api.check("stable")).toEqual(offer);
    const progress = vi.fn();
    await api.download("stable", "1.2.0", progress);
    expect(call).toHaveBeenLastCalledWith("update_online_download", {
      channel: "stable",
      version: "1.2.0",
    });
    expect(progress).toHaveBeenCalledWith({ received: 50, total: 100 });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("cleans the progress listener on failure and rejects malformed offers", async () => {
    const stop = vi.fn();
    const api = createOnlineUpdatesApi(
      async () => {
        throw "unreachable";
      },
      async () => stop,
    );
    await expect(api.download("beta", "1.2.0", vi.fn())).rejects.toBeInstanceOf(OnlineUpdateError);
    expect(stop).toHaveBeenCalledOnce();
    await expect(
      createOnlineUpdatesApi(async () => ({ ...offer, newer: "yes" })).check("stable"),
    ).rejects.toThrow();
  });
});
