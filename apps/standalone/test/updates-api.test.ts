import { describe, expect, it, vi } from "vitest";

import {
  createTauriUpdatesApi,
  UPDATE_ERROR_CODES,
  UPDATE_PROGRESS_EVENT,
  UpdateError,
} from "../src/update/updates-api.js";

type Handler = (event: { payload: unknown }) => void;

function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const listen = vi.fn(async (event: string, handler: Handler) => {
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  return { listen, handlers };
}

describe("the shell's update commands", () => {
  it("fetch reports progress while it runs and stops listening after", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      expect(command).toBe("update_fetch");
      events.handlers.get(UPDATE_PROGRESS_EVENT)?.({ payload: { received: 10, total: 20 } });
      return { version: "0.3.0", manifestPath: "C:\\u\\0.3.0\\m.update.jws", sizeBytes: 20 };
    });
    const api = createTauriUpdatesApi(call, events.listen, async () => "0.2.1");
    const seen: unknown[] = [];
    await expect(api.fetch((progress) => seen.push(progress))).resolves.toEqual({
      version: "0.3.0",
      manifestPath: "C:\\u\\0.3.0\\m.update.jws",
      sizeBytes: 20,
    });
    expect(seen).toEqual([{ received: 10, total: 20 }]);
    expect(events.handlers.size).toBe(0);
  });

  it("a bare code becomes an UpdateError of that code, anything else `refused`", async () => {
    const events = fakeEvents();
    for (const [rejection, code] of [
      ["needs_intermediate", "needs_intermediate"],
      ["host_mismatch", "host_mismatch"],
      [new Error("boom"), "refused"],
    ] as const) {
      const api = createTauriUpdatesApi(
        vi.fn(async () => {
          throw rejection;
        }),
        events.listen,
        async () => "0.2.1",
      );
      const failed = await api.checkManifest("x").catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(UpdateError);
      expect((failed as UpdateError).code).toBe(code);
    }
    expect(UPDATE_ERROR_CODES).toContain("package_verifying");
  });

  it("stage names its arguments as the shell reads them", async () => {
    const events = fakeEvents();
    const call = vi.fn(async () => ({ version: "0.3.0", sizeBytes: 20 }));
    const api = createTauriUpdatesApi(call, events.listen, async () => "0.2.1");
    await api.stage("D:\\Markiro\\m.update.jws", "token");
    expect(call).toHaveBeenCalledWith("update_stage", {
      manifestPath: "D:\\Markiro\\m.update.jws",
      officeToken: "token",
    });
  });
});
